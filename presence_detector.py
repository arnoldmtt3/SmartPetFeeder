#!/usr/bin/env python3
"""Camera off at boot. Cat detection defaults to observation-only mode."""
import os
import threading
import time
from datetime import datetime
import cv2
from flask import Flask, Response, jsonify, request
from cat_detection import CatDetector, PresenceTracker

app = Flask(__name__)
CAMERA_INDEX = int(os.environ.get('CAMERA_INDEX', '0'))
CHECK_INTERVAL = 0.5


class DetectionState:
    def __init__(self):
        self.camera_connected = False
        self.camera_generation = 0
        self.detection_generation = 0
        self.monitoring = False
        self.cap = None
        self.latest_frame = None
        self.frame_at = None
        self.last_detection = None
        self.boxes = []
        self.detector_error = None
        self.tracker = PresenceTracker(3)
        self.detector = CatDetector(os.environ.get('CAT_MODEL_DIR'), confidence=0.65)
        self.automation_enabled = os.environ.get('CAT_AUTOMATION_ENABLED', '0') == '1'
        self.lock = threading.RLock()
        self.cap_lock = threading.RLock()
        self.model_lock = threading.Lock()


state = DetectionState()


@app.before_request
def local_service_only():
    if request.remote_addr not in ('127.0.0.1', '::1'):
        return jsonify(error='Servicio de cámara solo local'), 403


def reset_detection():
    state.detection_generation += 1
    state.tracker.reset()
    state.boxes = []


def start_camera():
    with state.cap_lock:
        with state.lock:
            if state.camera_connected:
                return True
        cap = cv2.VideoCapture(CAMERA_INDEX)
        if not cap.isOpened():
            cap.release()
            return False
        with state.lock:
            state.cap = cap
            state.camera_connected = True
            state.camera_generation += 1
            state.latest_frame = None
            state.frame_at = None
            reset_detection()
        return True


def stop_camera():
    with state.cap_lock:
        with state.lock:
            cap = state.cap
            state.cap = None
            state.camera_connected = False
            state.camera_generation += 1
            state.monitoring = False
            state.latest_frame = None
            state.frame_at = None
            reset_detection()
        if cap is not None:
            cap.release()


def capture_loop():
    while True:
        try:
            with state.cap_lock:
                with state.lock:
                    cap = state.cap
                if cap is not None:
                    ret, frame = cap.read()
                    if ret and frame is not None:
                        with state.lock:
                            state.latest_frame = frame
                            state.frame_at = time.monotonic()
        except Exception as exc:
            with state.lock:
                state.detector_error = str(exc)
        time.sleep(0.1)


def latest_frame():
    with state.lock:
        if not state.camera_connected or state.latest_frame is None or state.frame_at is None or time.monotonic()-state.frame_at > 2:
            return None
        return state.latest_frame.copy()


def monitoring_loop():
    while True:
        with state.lock:
            active = state.monitoring and state.camera_connected
            generation = state.camera_generation
            detection_generation = state.detection_generation
        if active:
            frame = latest_frame()
            try:
                with state.model_lock:
                    boxes = state.detector.detect(frame) if frame is not None else []
                with state.lock:
                    if state.monitoring and state.camera_connected and generation == state.camera_generation and detection_generation == state.detection_generation:
                        if frame is None:
                            reset_detection()
                        else:
                            state.tracker.update(bool(boxes), time.monotonic())
                            state.boxes = boxes
                            if boxes:
                                state.last_detection = datetime.now().isoformat(timespec='seconds')
                        state.detector_error = None
            except Exception as exc:
                with state.lock:
                    state.detector_error = str(exc)
                    reset_detection()
        time.sleep(CHECK_INTERVAL)


@app.route('/status')
def get_status():
    with state.lock:
        now = time.monotonic()
        status = state.tracker.status(now)
        if state.frame_at is None or now-state.frame_at > 2:
            status.update(presence_confirmed=False, stale=True)
        return jsonify(camera=state.camera_connected, monitoring=state.monitoring,
            enabled=state.camera_connected, **status,
            presence_threshold=state.tracker.threshold, last_detection=state.last_detection,
            motion=False, motion_pixels=0, detector='mobilenet-ssd-voc-cat',
            cat_detected=bool(state.boxes) and not status['stale'], detections=state.boxes if not status['stale'] else [],
            detector_error=state.detector_error, observation_only=not state.automation_enabled,
            automation_allowed=state.automation_enabled and state.monitoring and not status['stale'] and not state.detector_error)


@app.route('/camera/start')
def camera_start():
    if not start_camera():
        return jsonify(error='No se pudo abrir la cámara', enabled=False), 503
    return jsonify(status='ok', enabled=True, camera=True)


@app.route('/camera/stop')
def camera_stop():
    stop_camera()
    return jsonify(status='ok', enabled=False, camera=False, monitoring=False)


@app.route('/start')
def start_monitoring():
    with state.lock:
        if not state.camera_connected:
            return jsonify(error='Primero enciende la cámara'), 409
        generation = state.camera_generation
    try:
        with state.model_lock:
            if state.detector.net is None:
                state.detector.load()
    except Exception as exc:
        with state.lock:
            state.detector_error = str(exc)
        return jsonify(error=str(exc)), 503
    with state.lock:
        if not state.camera_connected or generation != state.camera_generation:
            return jsonify(error='La cámara fue apagada'), 409
        reset_detection()
        state.monitoring = True
        state.detector_error = None
    return jsonify(status='started', camera=True, observation_only=not state.automation_enabled)


@app.route('/stop')
def stop_monitoring():
    with state.lock:
        state.monitoring = False
        reset_detection()
    return jsonify(status='stopped')


@app.route('/threshold/<int:seconds>')
def set_threshold(seconds):
    if not 1 <= seconds <= 120:
        return jsonify(error='Valor debe ser entre 1 y 120'), 400
    with state.lock:
        state.tracker.threshold = seconds
        reset_detection()
    return jsonify(threshold=seconds)


@app.route('/reset')
def reset_presence():
    with state.lock:
        reset_detection()
    return jsonify(status='reset')


@app.route('/snapshot')
def snapshot():
    frame = latest_frame()
    if frame is None:
        return jsonify(error='Cámara apagada o sin imagen reciente'), 503
    ok, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return Response(buf.tobytes(), mimetype='image/jpeg') if ok else (jsonify(error='No se pudo codificar'), 500)


@app.route('/video_stream')
def video_stream():
    with state.lock:
        if not state.camera_connected:
            return jsonify(error='Cámara apagada'), 409
        generation = state.camera_generation
    def gen():
        while True:
            with state.lock:
                if not state.camera_connected or generation != state.camera_generation:
                    break
            frame = latest_frame()
            if frame is not None:
                ok, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
                if ok:
                    with state.lock:
                        if not state.camera_connected or generation != state.camera_generation:
                            break
                    yield b'--frame\r\nContent-Type: image/jpeg\r\n\r\n'+buf.tobytes()+b'\r\n'
            time.sleep(0.1)
    return Response(gen(), mimetype='multipart/x-mixed-replace; boundary=frame')


if __name__ == '__main__':
    # Starting the service must NOT open the camera or start detection.
    cv2.setNumThreads(2)
    threading.Thread(target=capture_loop, daemon=True).start()
    threading.Thread(target=monitoring_loop, daemon=True).start()
    app.run(host='127.0.0.1', port=5001, debug=False, threaded=True)
