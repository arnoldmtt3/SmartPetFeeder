#!/usr/bin/env python3
"""test_esp32.py - Envia un comando por serial al ESP32 y muestra la respuesta.
Uso: sudo python3 test_esp32.py '<comando>'
Ejemplos:
  sudo python3 test_esp32.py '4 1'      # Encender rele
  sudo python3 test_esp32.py '2 180'    # Compuerta superior a 180
  sudo python3 test_esp32.py '1 120'    # Dosificador +120 grados
  sudo python3 test_esp32.py '99'       # Comando invalido (prueba de comunicacion)
"""
import sys
import time
import serial

CMD = " ".join(sys.argv[1:])

with serial.Serial("/dev/ttyUSB0", 115200, timeout=1) as ser:
    time.sleep(0.2)
    ser.write((CMD + "\n").encode())
    print(f">>> {CMD}\n")
    t0 = time.time()
    buf = b""
    while time.time() - t0 < 3:
        b = ser.read(256)
        if b:
            buf += b
    print(buf.decode("utf-8", errors="replace"))
    ser.close()