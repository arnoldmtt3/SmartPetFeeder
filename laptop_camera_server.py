#!/usr/bin/env python3
"""
SmartPetFeeder - Transmisor de cámara para LAPTOP (no la Raspberry).

Uso en tu laptop:
    pip install opencv-python flask
    python laptop_camera_server.py

Luego abre en el navegador para verificar:
    http://TU_IP_LAPTOP:5002/

Y en la interfaz del alimentador (pestaña Pruebas > Cámara):
    fuente = "Cámara de laptop (URL)", URL = http://TU_IP_LAPTOP:5002/video
"""

import cv2
import time
from flask import Flask, Response

app = Flask(__name__)
CAMERA_INDEX = 0
JPEG_QUALITY = 70


def frames():
    cap = cv2.VideoCapture(CAMERA_INDEX)
    if not cap.isOpened():
        raise RuntimeError(f'No se pudo abrir la cámara {CAMERA_INDEX}')
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                time.sleep(0.2)
                continue
            # Reducir para que el stream sea liviano en la red
            frame = cv2.resize(frame, (480, 360))
            _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + buf.tobytes() + b'\r\n')
            time.sleep(0.1)
    finally:
        cap.release()


@app.route('/video')
def video():
    return Response(frames(), mimetype='multipart/x-mixed-replace; boundary=frame')


@app.route('/')
def index():
    return ('<h2>SmartPetFeeder - Cámara laptop OK</h2>'
            '<p>Stream: <a href="/video">/video</a></p>'
            '<img src="/video" style="max-width:480px">')


if __name__ == '__main__':
    print('=== SmartPetFeeder - Cámara de laptop ===')
    print('Stream disponible en http://0.0.0.0:5002/video')
    app.run(host='0.0.0.0', port=5002, debug=False, threaded=True)
