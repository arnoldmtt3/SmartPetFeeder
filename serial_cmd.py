#!/usr/bin/env python3
"""serial_cmd.py - Envia un comando al ESP32 y lee la respuesta durante N segundos.
Uso: sudo python3 serial_cmd.py <segundos> <comando...>
Ej:  sudo python3 serial_cmd.py 10 10 0
"""
import sys, time, serial

dur = float(sys.argv[1])
cmd = " ".join(sys.argv[2:])

with serial.Serial("/dev/ttyUSB0", 115200, timeout=0.2) as s:
    time.sleep(0.2)
    s.reset_input_buffer()
    s.write((cmd + "\n").encode())
    print(f">>> {cmd}  (leyendo {dur}s)\n")
    t0 = time.time()
    buf = b""
    while time.time() - t0 < dur:
        b = s.read(256)
        if b:
            buf += b
    print(buf.decode("utf-8", errors="replace"))
    print("<<< fin")
