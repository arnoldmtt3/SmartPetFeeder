#!/usr/bin/env python3
"""Genera imagen de estado para el video feed."""
import cv2
import numpy as np
import sys
import json
import datetime

# Leer estado de stdin
status_json = sys.stdin.read()
try:
    status = json.loads(status_json)
except:
    status = {}

# Crear imagen 640x480
img = np.zeros((480, 640, 3), dtype=np.uint8)
img[:] = (80, 60, 45)

# Borde
cv2.rectangle(img, (0, 0), (639, 479), (100, 100, 100), 2)

# Logo/icono
cv2.putText(img, "SmartPetFeeder", (180, 60), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 200, 100), 2)
cv2.line(img, (180, 70), (460, 70), (255, 200, 100), 1)

if status.get('monitoring'):
    if status.get('presence_confirmed'):
        # MASCOTA DETECTADA - verde
        cv2.rectangle(img, (40, 100), (600, 350), (39, 103, 39), -1)
        cv2.putText(img, "MASCOTA DETECTADA", (100, 200), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (255, 255, 255), 3)
        cv2.putText(img, "Comida dispensada automaticamente", (100, 260), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (200, 255, 200), 1)
        # Icono check
        cv2.circle(img, (520, 170), 40, (0, 255, 0), 3)
        cv2.putText(img, "OK", (500, 180), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 255, 0), 2)
    elif status.get('motion'):
        # Movimiento detectado - amarillo
        secs = status.get('presence_seconds', 0)
        threshold = status.get('presence_threshold', 10)
        cv2.rectangle(img, (40, 100), (600, 350), (0, 165, 255), -1)
        cv2.putText(img, "Movimiento detectado", (100, 180), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 2)
        cv2.putText(img, f"Presencia: {secs}s / {threshold}s", (100, 240), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
        # Barra de progreso
        bar_width = int(400 * (secs / threshold))
        cv2.rectangle(img, (100, 270), (500, 300), (80, 80, 80), -1)
        cv2.rectangle(img, (100, 270), (100 + bar_width, 300), (0, 255, 255), -1)
        cv2.putText(img, f"{int(secs/threshold*100)}%", (280, 290), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
    else:
        # Monitoreando - azul
        cv2.rectangle(img, (40, 100), (600, 350), (120, 80, 50), -1)
        cv2.putText(img, "Monitoreando...", (150, 200), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 2)
        cv2.putText(img, "Esperando mascota", (180, 260), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (180, 180, 180), 1)
        # Puntos animados
        import time
        t = int(time.time() % 3)
        dots = "." * (t + 1)
        cv2.putText(img, f"Buscando{dots}", (220, 310), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (150, 150, 150), 1)
else:
    # Sin monitoreo - gris
    cv2.rectangle(img, (40, 100), (600, 350), (60, 60, 60), -1)
    cv2.putText(img, "Sin monitoreo", (180, 200), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (150, 150, 150), 2)
    cv2.putText(img, "Activa la camara para comenzar", (120, 260), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (100, 100, 100), 1)

# Info inferior
mode = "MODO PRUEBA" if status.get('test_mode') else "Camara en vivo"
cv2.putText(img, mode, (50, 400), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (150, 150, 150), 1)

ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
cv2.putText(img, ts, (400, 450), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (120, 120, 120), 1)

# Encode JPEG
_, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 80])
sys.stdout.buffer.write(buf)
