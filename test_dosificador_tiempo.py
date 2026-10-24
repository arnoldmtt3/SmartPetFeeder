#!/usr/bin/env python3
"""test_dosificador_tiempo.py - Prueba giro por tiempo (360°) en ambas direcciones."""
import sys, time, serial

MS = int(sys.argv[1]) if len(sys.argv) > 1 else 1500

with serial.Serial('/dev/ttyUSB0', 115200, timeout=4) as s:
    time.sleep(0.3)
    for cmd, label in [(f'7 {MS} 1\n', f'7 {MS} 1 (horario)'), (f'7 {MS} 0\n', f'7 {MS} 0 (antihorario)')]:
        s.reset_input_buffer()
        s.write(cmd.encode())
        print(f'>>> {label}')
        time.sleep(0.3)
        t0 = time.time(); buf = b''
        while time.time() - t0 < 8:
            b = s.read(256)
            if b: buf += b
        print(buf.decode('utf-8', errors='replace'))
        print('---')
        time.sleep(1.0)