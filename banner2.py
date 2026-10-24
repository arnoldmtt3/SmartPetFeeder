#!/usr/bin/env python3
"""banner2.py - Intenta capturar el banner de arranque del ESP32."""
import serial, time

def drain(s, dur=2.0):
    t0 = time.time(); buf = b""
    while time.time() - t0 < dur:
        b = s.read(512)
        if b:
            buf += b
    return buf

s = serial.Serial('/dev/ttyUSB0', 115200, timeout=0.2)
time.sleep(0.3)
buf = drain(s, 1.5)

s.dtr = False; s.rts = True; time.sleep(0.15); s.rts = False; time.sleep(0.3)
buf += drain(s, 2.0)

s.dtr = True; time.sleep(0.1); s.dtr = False
time.sleep(0.1)
s.rts = True; time.sleep(0.15); s.rts = False; time.sleep(0.3)
buf += drain(s, 2.0)

txt = buf.decode('utf-8', 'replace')
print("===RAW===")
print(repr(txt))
print("===TXT===")
print(txt)
print("<<< fin")
