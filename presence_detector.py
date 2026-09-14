#!/usr/bin/env python3
"""
SmartPetFeeder - Detección de presencia con OpenCV
Detecta movimiento con cámara USB y expone estado vía HTTP.
Modo TEST: simula detección sin cámara física.
"""

import cv2
import time
import threading
import random
from datetime import datetime
from flask import Flask, jsonify

app = Flask(__name__)

# Configuración
CAMERA_INDEX = 0
CHECK_INTERVAL = 2  # segundos entre cada verificación
MOTION_THRESHOLD = 500  # píxeles mínimos para considerar movimiento
DEFAULT_PRESENCE_THRESHOLD = 10  # segundos de presencia confirmada

# Estado
class DetectionState:
    def __init__(self):
        self.camera_connected = False
        self.motion_detected = False
        self.presence_seconds = 0
        self.presence_confirmed = False
        self.presence_threshold = DEFAULT_PRESENCE_THRESHOLD
        self.last_detection = None
        self.monitoring = False
        self.cap = None
        self.prev_frame = None
        self.lock = threading.Lock()
        # Modo test
        self.test_mode = False
        self.test_motion = False
        self.test_cycle_index = 0

state = DetectionState()


def init_camera():
    """Inicializa la cámara USB."""
    try:
        state.cap = cv2.VideoCapture(CAMERA_INDEX)
        if state.cap.isOpened():
            state.camera_connected = True
            print(f"[CAMARA] Conectada en /dev/video{CAMERA_INDEX}")
            return True
        else:
            state.camera_connected = False
            print("[CAMARA] No detectada")
            return False
    except Exception as e:
        state.camera_connected = False
        print(f"[CAMARA] Error: {e}")
        return False


def detect_motion_real():
    """Detecta movimiento comparando frames consecutivos."""
    if not state.camera_connected or not state.cap:
        return False

    ret, frame = state.cap.read()
    if not ret or frame is None:
        return False

    small = cv2.resize(frame, (320, 240))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (21, 21), 0)

    if state.prev_frame is None:
        state.prev_frame = gray
        return False

    delta = cv2.absdiff(state.prev_frame, gray)
    thresh = cv2.threshold(delta, 25, 255, cv2.THRESH_BINARY)[1]
    thresh = cv2.dilate(thresh, None, iterations=2)

    motion_pixels = cv2.countNonZero(thresh)
    state.prev_frame = gray

    return motion_pixels > MOTION_THRESHOLD


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
                        print(f"[PRESENCIA] Movimiento perdido, reiniciando contador")
                    state.presence_seconds = 0
                    state.presence_confirmed = False

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
            'presence_seconds': state.presence_seconds,
            'presence_threshold': state.presence_threshold,
            'presence_confirmed': state.presence_confirmed,
            'monitoring': state.monitoring,
            'last_detection': state.last_detection,
            'test_mode': state.test_mode
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
    print("Servidor HTTP en puerto 5001...")
    app.run(host='0.0.0.0', port=5001, debug=False)
