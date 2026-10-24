#!/usr/bin/env python3
"""reset_banner.py - Resetea el ESP32 y captura el banner de arranque."""
import serial, time

s = serial.Serial('/dev/ttyUSB0', 115200, timeout=0.3)
s.dtr = False
s.rts = False
time.sleep(0.1)
s.rts = True          # EN -> reset
time.sleep(0.15)
s.rts = False         # liberar reset
time.sleep(0.3)
s.reset_input_buffer()
t0 = time.time()
buf = b""
while time.time() - t0 < 3:
    b = s.read(512)
    if b:
        buf += b
print(buf.decode('utf-8', 'replace'))
print("<<< fin banner")
