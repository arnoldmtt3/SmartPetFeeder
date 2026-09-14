#!/usr/bin/env python3
"""
SmartPetFeeder - Detección de presencia con OpenCV
Detecta movimiento con cámara USB y expone estado vía HTTP.
Modo TEST: simula detección sin cámara física.
"""

import cv2
import time
import threading
import numpy as np
from datetime import datetime
from flask import Flask, jsonify, request

app = Flask(__name__)

# Configuración
DEFAULT_CAMERA_INDEX = 0
CHECK_INTERVAL = 2  # segundos entre cada verificación
MOTION_THRESHOLD = 500  # píxeles mínimos para considerar movimiento
DEFAULT_PRESENCE_THRESHOLD = 10  # segundos de presencia confirmada

# Estado
class DetectionState:
    def __init__(self):
        self.camera_connected = False
        self.video_source = DEFAULT_CAMERA_INDEX  # int (USB) o str (URL stream)
        self.source_label = 'raspberry'
        self.motion_detected = False
        self.motion_pixels = 0
        self.presence_seconds = 0
        self.presence_confirmed = False
        self.presence_threshold = DEFAULT_PRESENCE_THRESHOLD
        self.last_detection = None
        self.last_photo_result = None
        self.monitoring = False
        self.cap = None
        self.latest_frame = None
        self.prev_frame = None
        self.lock = threading.Lock()
        self.cap_lock = threading.Lock()
        # Modo test
        self.test_mode = False
        self.test_motion = False
        self.test_cycle_index = 0

state = DetectionState()


def parse_source(src):
    """Convierte '0'->0, URLs se dejan como string."""
    if src is None:
        return DEFAULT_CAMERA_INDEX
    s = str(src).strip()
    if s.isdigit():
        return int(s)
    return s


def init_camera(source=None):
    """Inicializa la fuente de video (índice USB o URL de stream)."""
    if source is not None:
        state.video_source = parse_source(source)
    try:
        if state.cap is not None:
            try:
                state.cap.release()
            except Exception:
                pass
            state.cap = None
        state.cap = cv2.VideoCapture(state.video_source)
        if state.cap.isOpened():
            state.camera_connected = True
            print(f"[CAMARA] Conectada: {state.video_source}")
            return True
        else:
            state.camera_connected = False
            print(f"[CAMARA] No se pudo abrir: {state.video_source}")
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
            if state.test_mode or not state.camera_connected or state.cap is None:
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


def detect_motion_real():
    """Detecta movimiento analizando el último frame capturado."""
    frame = get_latest_frame()
    if frame is None:
        return False
    with state.lock:
        motion, pixels = process_frame(frame)
        state.motion_pixels = pixels
    return motion


def detect_motion_test():
    """Simula detección de movimiento para pruebas.
    Ciclo: 6s con movimiento, 6s sin movimiento.
    """
    state.test_cycle_index += 1
    # 6s con movimiento (3 checks de 2s), 6s sin movimiento
    cycle_position = state.test_cycle_index % 6
    has_motion = cycle_position < 3
    state.test_motion = has_motion
    return has_motion


def detect_motion():
    """Detecta movimiento (real o simulado)."""
    if state.test_mode:
        return detect_motion_test()
    return detect_motion_real()


def monitoring_loop():
    """Loop principal de detección."""
    while state.monitoring:
        try:
            motion = detect_motion()
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
            'camera': state.camera_connected or state.test_mode,
            'motion': state.motion_detected,
            'motion_pixels': state.motion_pixels,
            'presence_seconds': state.presence_seconds,
            'presence_threshold': state.presence_threshold,
            'presence_confirmed': state.presence_confirmed,
            'monitoring': state.monitoring,
            'last_detection': state.last_detection,
            'last_photo_result': state.last_photo_result,
            'test_mode': state.test_mode,
            'source': state.video_source if isinstance(state.video_source, int) else str(state.video_source),
            'source_label': state.source_label
        })


@app.route('/start')
def start_monitoring():
    """Inicia el monitoreo de presencia."""
    if not state.test_mode and not state.camera_connected:
        init_camera()

    if not state.test_mode and not state.camera_connected:
        return jsonify({'error': 'Cámara no conectada. Usa /test/start para modo prueba.'}), 503

    if not state.monitoring:
        state.monitoring = True
        state.prev_frame = None
        t = threading.Thread(target=monitoring_loop, daemon=True)
        t.start()
        mode = "TEST" if state.test_mode else "REAL"
        print(f"[MONITOREO] Iniciado (modo {mode})")
        return jsonify({'status': 'started', 'camera': True, 'test_mode': state.test_mode})
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


# ─── Fuentes de cámara ────────────────────────────────────────────

@app.route('/camera/sources')
def camera_sources():
    """Lista la fuente actual y prueba índices USB disponibles."""
    available = []
    for i in range(3):
        try:
            cap = cv2.VideoCapture(i)
            if cap.isOpened():
                available.append(i)
            cap.release()
        except Exception:
            pass
    return jsonify({
        'current': state.video_source if isinstance(state.video_source, int) else str(state.video_source),
        'current_label': state.source_label,
        'usb_available': available,
        'test_mode': state.test_mode
    })


@app.route('/camera/source', methods=['POST'])
def camera_set_source():
    """Cambia la fuente de video: {"source": 0 | "http://ip:5002/video" | "test"}."""
    data = request.get_json(force=True, silent=True) or {}
    src = data.get('source', 0)
    label = str(data.get('label') or '').strip()

    if str(src).strip().lower() == 'test':
        state.test_mode = True
        state.test_cycle_index = 0
        state.source_label = 'test'
        print("[CAMARA] Fuente cambiada a modo prueba")
        return jsonify({'status': 'ok', 'source': 'test'})

    state.test_mode = False
    ok = init_camera(src)
    state.source_label = label or ('laptop' if isinstance(state.video_source, str) else 'raspberry')
    with state.lock:
        state.prev_frame = None
        state.presence_seconds = 0
        state.presence_confirmed = False
    if ok:
        return jsonify({'status': 'ok', 'source': state.video_source, 'label': state.source_label})
    return jsonify({'error': f'No se pudo abrir la fuente: {src}'}), 503


@app.route('/camera/upload', methods=['POST'])
def camera_upload():
    """Procesa una foto subida manualmente como un frame de detección.

    Compara la foto con el frame anterior usando el mismo pipeline de
    movimiento y actualiza el temporizador de presencia.
    """
    if 'photo' not in request.files:
        return jsonify({'error': 'Falta el archivo (campo "photo")'}), 400
    try:
        data = request.files['photo'].read()
        arr = np.frombuffer(data, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            return jsonify({'error': 'Imagen inválida'}), 400
        with state.lock:
            motion, pixels = process_frame(frame)
            apply_motion(motion)
            result = {
                'motion': motion,
                'motion_pixels': pixels,
                'motion_threshold': MOTION_THRESHOLD,
                'presence_seconds': state.presence_seconds,
                'presence_threshold': state.presence_threshold,
                'presence_confirmed': state.presence_confirmed,
                'last_detection': state.last_detection
            }
            state.last_photo_result = result
        print(f"[FOTO] motion={motion} pixels={pixels} presencia={state.presence_seconds}s")
        return jsonify(result)
    except Exception as e:
        print(f"[FOTO] Error: {e}")
        return jsonify({'error': str(e)}), 500


# ─── Snapshot para video en vivo ────────────────────────────────────

@app.route('/snapshot')
def snapshot():
    """Devuelve el frame actual como JPEG (para el video en vivo)."""
    frame = None
    if state.test_mode:
        # Imagen de prueba con el estado actual
        img = np.zeros((360, 480, 3), dtype=np.uint8)
        img[:] = (60, 60, 60)
        with state.lock:
            motion = state.motion_detected
            secs = state.presence_seconds
            threshold = state.presence_threshold
            confirmed = state.presence_confirmed
        cv2.putText(img, 'MODO PRUEBA', (140, 60),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.0, (150, 150, 150), 2)
        if confirmed:
            cv2.putText(img, 'MASCOTA DETECTADA', (70, 170),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2)
        elif motion:
            cv2.putText(img, f'Movimiento {secs}s/{threshold}s', (70, 170),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 255, 255), 2)
        else:
            cv2.putText(img, 'Sin movimiento', (110, 170),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.0, (200, 200, 200), 2)
        ts = datetime.now().strftime('%H:%M:%S')
        cv2.putText(img, ts, (190, 320),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (120, 120, 120), 1)
        frame = img
    else:
        frame = get_latest_frame()

    if frame is None:
        return jsonify({'error': 'Sin imagen disponible'}), 503
    ok, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
    if not ok:
        return jsonify({'error': 'No se pudo codificar'}), 500
    from flask import Response
    return Response(buf.tobytes(), mimetype='image/jpeg')


# ─── Stream MJPEG fluido ────────────────────────────────────────────

@app.route('/video_stream')
def video_stream():
    """Stream MJPEG fluido de la fuente actual."""
    from flask import Response, stream_with_context

    def gen():
        frame_i = 0
        while True:
            frame = None
            if state.test_mode:
                img = np.zeros((360, 480, 3), dtype=np.uint8)
                img[:] = (60, 60, 60)
                x = int((frame_i * 5) % 380)
                cv2.rectangle(img, (x, 140), (x + 100, 220), (0, 200, 0), -1)
                cv2.putText(img, 'MODO PRUEBA', (140, 60),
                            cv2.FONT_HERSHEY_SIMPLEX, 1.0, (150, 150, 150), 2)
                with state.lock:
                    confirmed = state.presence_confirmed
                if confirmed:
                    cv2.putText(img, 'DETECTADA', (150, 300),
                                cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2)
                ts = datetime.now().strftime('%H:%M:%S')
                cv2.putText(img, ts, (190, 330),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (120, 120, 120), 1)
                frame = img
                frame_i += 1
            else:
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


# ─── Endpoints de prueba ──────────────────────────────────────────

@app.route('/test/start')
def start_test_mode():
    """Activa modo prueba (sin cámara). Simula movimiento cada 6s."""
    state.test_mode = True
    state.test_cycle_index = 0
    print("[TEST] Modo prueba activado")
    return jsonify({
        'status': 'test_mode_started',
        'message': 'Simulación: 6s con movimiento, 6s sin movimiento'
    })


@app.route('/test/stop')
def stop_test_mode():
    """Desactiva modo prueba."""
    state.test_mode = False
    state.test_motion = False
    print("[TEST] Modo prueba desactivado")
    return jsonify({'status': 'test_mode_stopped'})


@app.route('/test/simulate/<int:seconds>')
def simulate_motion(seconds):
    """Simula movimiento continuo por X segundos."""
    if 1 <= seconds <= 60:
        def fake_motion():
            state.test_mode = True
            state.test_motion = True
            state.monitoring = True
            with state.lock:
                state.presence_seconds = 0
                state.presence_confirmed = False
            print(f"[TEST] Simulando movimiento por {seconds}s")

            for i in range(0, seconds, CHECK_INTERVAL):
                with state.lock:
                    state.motion_detected = True
                    state.presence_seconds += CHECK_INTERVAL
                    state.last_detection = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                    if state.presence_seconds >= state.presence_threshold:
                        state.presence_confirmed = True
                        print(f"[TEST] ¡Presencia confirmada! ({state.presence_seconds}s)")
                time.sleep(CHECK_INTERVAL)

            with state.lock:
                state.motion_detected = False
                state.test_motion = False
            print(f"[TEST] Simulación terminada")

        t = threading.Thread(target=fake_motion, daemon=True)
        t.start()
        return jsonify({'status': 'simulating', 'seconds': seconds})
    return jsonify({'error': 'Valor debe ser entre 1 y 60'}), 400


if __name__ == '__main__':
    print("=== SmartPetFeeder - Detector de Presencia ===")
    print("Modos disponibles:")
    print("  Real:      python3 presence_detector.py")
    print("  Prueba:    python3 presence_detector.py --test")
    print("  API:       curl http://localhost:5001/test/start")

    import sys
    if '--test' in sys.argv:
        state.test_mode = True
        print("[CONFIG] Modo prueba activado por argumento")

    init_camera()
    ct = threading.Thread(target=capture_loop, daemon=True)
    ct.start()
    print("Servidor HTTP en puerto 5001...")
    app.run(host='0.0.0.0', port=5001, debug=False)
