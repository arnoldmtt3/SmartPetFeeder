#!/usr/bin/env python3
"""test_m1.py - Prueba INDIVIDUAL y SEGURA del motor M1 (faja, canal A).
Uso: sudo python3 test_m1.py <GPIO_IN2>
  <GPIO_IN2>  = pin BCM que tienes CABLEADO a la entrada IN2 del L298N.
                GPIO18 = pin fisico 12.
Fases: 1) AVANZA (control, 3s) 2) RETROCESO con ese IN2 (5s) 3) detiene todo.
Velocidad maxima (100%). Mientras corre puedes medir con multimetro en IN2 y Out1/Out2.
"""
import sys
import time
import RPi.GPIO as GPIO

ENA, IN1 = 12, 17
PIN2 = int(sys.argv[1]) if len(sys.argv) > 1 else 18

def setup():
    global pwm
    GPIO.setmode(GPIO.BCM)
    for p in (ENA, IN1, PIN2):
        GPIO.setup(p, GPIO.OUT, initial=GPIO.LOW)
    pwm = GPIO.PWM(ENA, 1000)
    pwm.start(0)

def stop():
    GPIO.output((IN1, PIN2), GPIO.LOW)
    pwm.ChangeDutyCycle(0)

def run(direction, seconds, duty):
    stop()
    time.sleep(0.5)
    if direction == 'avanza':
        GPIO.output(IN1, GPIO.HIGH)
        GPIO.output(PIN2, GPIO.LOW)
    else:
        GPIO.output(PIN2, GPIO.HIGH)
        GPIO.output(IN1, GPIO.LOW)
    pwm.ChangeDutyCycle(duty)
    for i in range(seconds, 0, -1):
        print(f"  [{direction}] ... {i}s", flush=True)
        time.sleep(1)
    stop()
    time.sleep(0.5)

def main():
    setup()
    print("=== TEST SOLO M1 (canal A) ===")
    print(f"ENA=12 | IN1=17 (avance) | IN2=GPIO{PIN2} (retroceso)")
    print("Mide con multimetro la bornera IN2 durante la fase RETROCESO: debe marcar ~3.3V")
    try:
        run('AVANZANDO (control)', 3, 100)
        run('RETROCEDIENDO', 5, 100)
        print("=== FIN. El motor giro a la inversa? (si no: mide IN2 durante RETROCESO) ===")
    except KeyboardInterrupt:
        print("\nInterrumpido por el usuario.")
    finally:
        stop()
        GPIO.cleanup()

if __name__ == "__main__":
    main()