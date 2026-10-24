#!/usr/bin/env python3
"""esp32_cmd.py - Envia un comando al ESP32 y espera a que termine.

Uso: python3 esp32_cmd.py <max_segundos> <comando...>
Lee hasta que aparece "Ingrese otro comando:" (fin de comando) o se
agota el tiempo maximo.
"""
import sys
import time
import serial

maxs = float(sys.argv[1]) if len(sys.argv) > 1 else 15.0
cmd = " ".join(sys.argv[2:])

try:
    with serial.Serial("/dev/ttyUSB0", 115200, timeout=0.2) as s:
        time.sleep(0.2)
        s.reset_input_buffer()
        s.write((cmd + "\n").encode())
        t0 = time.time()
        buf = b""
        while time.time() - t0 < maxs:
            b = s.read(256)
            if b:
                buf += b
                if b"Ingrese otro comando" in buf:
                    break
        sys.stdout.write(buf.decode("utf-8", errors="replace"))
except Exception as e:
    sys.stderr.write(str(e) + "\n")
    sys.exit(1)
