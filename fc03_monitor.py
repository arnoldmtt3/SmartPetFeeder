#!/usr/bin/env python3
"""fc03_monitor.py - Lee el conteo de pulsos del FC-03 durante unos segundos."""
import sys, time, re, serial

DURACION = int(sys.argv[1]) if len(sys.argv) > 1 else 20

with serial.Serial('/dev/ttyUSB0', 115200, timeout=2) as s:
    time.sleep(0.3)
    s.reset_input_buffer()
    t0 = time.time()
    ultimo = None
    print(f"Monitoreando FC-03 por {DURACION}s. Pasa un objeto por la ranura...")
    while time.time() - t0 < DURACION:
        s.reset_input_buffer()
        s.write(b'9 0\n')
        time.sleep(0.2)
        buf = ''
        t1 = time.time()
        while time.time() - t1 < 1.0:
            b = s.read(256)
            if b:
                buf += b.decode('utf-8', 'replace')
        m = re.search(r'Pulsos FC-03:\s*(\d+)', buf)
        if m:
            n = int(m.group(1))
            if n != ultimo:
                t = time.time() - t0
                print(f"[{t:5.1f}s] pulsos = {n}")
                ultimo = n
        time.sleep(0.2)
    print(f"Conteo final: {ultimo}")
