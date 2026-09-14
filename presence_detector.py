#!/usr/bin/env python3
"""
SmartPetFeeder - Detección de presencia con OpenCV
Usa la cámara USB conectada a la Raspberry Pi (/dev/video0)
y expone estado + video en vivo vía HTTP (puerto 5001).
"""

import cv2
import time
import threading
import numpy as np
from datetime import datetime
from flask import Flask, jsonify, Response, stream_with_context

app = Flask(__name__)

# Configuración
CAMERA_INDEX = 0
CHECK_INTERVAL = 2  # segundos entre cada verificación
MOTION_THRESHOLD = 500  # píxeles mínimos para considerar movimiento
DEFAULT_PRESENCE_THRESHOLD = 10  # segundos de presencia confirmada


class DetectionState:
    def __init__(self):
        self.camera_connected = False
        self.motion_detected = False
        self.motion_pixels = 0
        self.presence_seconds = 0
        self.presence_confirmed = False
        self.presence_threshold = DEFAULT_PRESENCE_THRESHOLD
        self.last_detection = None
        self.monitoring = False
        self.cap = None
        self.latest_frame = None
        self.prev_frame = None
        self.lock = threading.Lock()
        self.cap_lock = threading.Lock()


state = DetectionState()


def init_camera():
    """Inicializa la cámara USB de la Raspberry Pi."""
    try:
        if state.cap is not None:
            try:
                state.cap.release()
            except Exception:
                pass
            state.cap = None
        state.cap = cv2.VideoCapture(CAMERA_INDEX)
        if state.cap.isOpened():
            state.camera_connected = True
            print(f"[CAMARA] Conectada en /dev/video{CAMERA_INDEX}")
            return True
        state.camera_connected = False
        print("[CAMARA] No detectada en /dev/video0")
        return False
    except Exception as e:
        state.camera_connected = False
        print(f"[CAMARA] Error: {e}")
        return False


def process_frame(frame):
    """Compara un frame con el anterior. Retorna (motion, motion_pixels)."""
    small = cv2.resize(frame, (320, 240))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (21, 21), 0)

    if state.prev_frame is None:
        state.prev_frame = gray
        return False, 0

    delta = cv2.absdiff(state.prev_frame, gray)
    thresh = cv2.threshold(delta, 25, 255, cv2.THRESH_BINARY)[1]
    thresh = cv2.dilate(thresh, None, iterations=2)

    motion_pixels = int(cv2.countNonZero(thresh))
    state.prev_frame = gray

    return motion_pixels > MOTION_THRESHOLD, motion_pixels


def apply_motion(motion):
    """Actualiza el temporizador de presencia con el resultado."""
    state.motion_detected = motion
    if motion:
        state.presence_seconds += CHECK_INTERVAL
        state.last_detection = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        if state.presence_seconds >= state.presence_threshold:
            if not state.presence_confirmed:
                print(f"[PRESENCIA] Confirmada ({state.presence_seconds}s)")
            state.presence_confirmed = True
        else:
            state.presence_confirmed = False
    else:
        if state.presence_seconds > 0:
            print("[PRESENCIA] Movimiento perdido, reiniciando contador")
        state.presence_seconds = 0
        state.presence_confirmed = False


def capture_loop():
    """Único lector de la cámara: actualiza latest_frame ~10fps."""
    while True:
        try:
            if not state.camera_connected or state.cap is None:
                time.sleep(1)
                continue
            with state.cap_lock:
                ret, frame = state.cap.read()
            if ret and frame is not None:
                with state.lock:
                    state.latest_frame = frame
            else:
                time.sleep(0.2)
        except Exception:
            time.sleep(0.5)
        time.sleep(0.1)


def get_latest_frame():
    """Copia del último frame (sin bloquear la captura)."""
    with state.lock:
        if state.latest_frame is None:
            return None
        return state.latest_frame.copy()


def monitoring_loop():
    """Loop principal de detección."""
    while state.monitoring:
        try:
            frame = get_latest_frame()
            motion = False
            if frame is not None:
                with state.lock:
                    motion, pixels = process_frame(frame)
                    state.motion_pixels = pixels
            with state.lock:
                apply_motion(motion)
        except Exception as e:
            print(f"[ERROR] {e}")
        time.sleep(CHECK_INTERVAL)


@app.route('/status')
def get_status():
    """Retorna estado actual de detección."""
    with state.lock:
        return jsonify({
            'camera': state.camera_connected,
            'motion': state.motion_detected,
            'motion_pixels': state.motion_pixels,
            'presence_seconds': state.presence_seconds,
            'presence_threshold': state.presence_threshold,
            'presence_confirmed': state.presence_confirmed,
            'monitoring': state.monitoring,
            'last_detection': state.last_detection
        })


@app.route('/start')
def start_monitoring():
    """Inicia el monitoreo de presencia."""
    if not state.camera_connected:
        init_camera()
    if not state.camera_connected:
        return jsonify({'error': 'Cámara no conectada en /dev/video0'}), 503
    if not state.monitoring:
        state.monitoring = True
        state.prev_frame = None
        t = threading.Thread(target=monitoring_loop, daemon=True)
        t.start()
        print("[MONITOREO] Iniciado")
        return jsonify({'status': 'started', 'camera': True})
    return jsonify({'status': 'already_running'})


@app.route('/stop')
def stop_monitoring():
    """Detiene el monitoreo."""
    state.monitoring = False
    with state.lock:
        state.presence_seconds = 0
        state.presence_confirmed = False
        state.motion_detected = False
    print("[MONITOREO] Detenido")
    return jsonify({'status': 'stopped'})


@app.route('/threshold/<int:seconds>')
def set_threshold(seconds):
    """Configura el umbral de presencia en segundos."""
    if 1 <= seconds <= 120:
        state.presence_threshold = seconds
        print(f"[CONFIG] Umbral cambiado a {seconds}s")
        return jsonify({'threshold': seconds})
    return jsonify({'error': 'Valor debe ser entre 1 y 120'}), 400


@app.route('/reset')
def reset_presence():
    """Reinicia el contador de presencia."""
    with state.lock:
        state.presence_seconds = 0
        state.presence_confirmed = False
    return jsonify({'status': 'reset'})


@app.route('/snapshot')
def snapshot():
    """Devuelve el frame actual como JPEG."""
    frame = get_latest_frame()
    if frame is None:
        return jsonify({'error': 'Sin imagen disponible'}), 503
    ok, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
    if not ok:
        return jsonify({'error': 'No se pudo codificar'}), 500
    return Response(buf.tobytes(), mimetype='image/jpeg')


@app.route('/video_stream')
def video_stream():
    """Stream MJPEG fluido de la cámara USB."""
    def gen():
        while True:
            frame = get_latest_frame()
            if frame is None:
                time.sleep(0.5)
                continue
            ok, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 60])
            if not ok:
                continue
            yield (b'--frame\r\nContent-Type: image/jpeg\r\n\r\n'
                   + buf.tobytes() + b'\r\n')
            time.sleep(0.1)

    return Response(stream_with_context(gen()),
                    mimetype='multipart/x-mixed-replace; boundary=frame')


if __name__ == '__main__':
    print("=== SmartPetFeeder - Detector de Presencia ===")
    init_camera()
    ct = threading.Thread(target=capture_loop, daemon=True)
    ct.start()
    print("Servidor HTTP en puerto 5001...")
    app.run(host='0.0.0.0', port=5001, debug=False)
