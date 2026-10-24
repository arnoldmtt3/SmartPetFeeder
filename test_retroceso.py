#!/usr/bin/env python3
"""
test_retroceso.py - Prueba de RETROCESO SOLO de la faja (2 segundos).
  Ambos motores jalan en sentido invertido (retroceso):
  M1: IN2=HI,IN1=LO | M2: IN4=HI,IN3=LO | ENA/ENB on
Pines (BCM): M1 ENA=12 IN1=17 IN2=18 | M2 ENB=13 IN3=22 IN4=23
Ruta: sudo python3 test_retroceso.py
"""
import time
import RPi.GPIO as GPIO

ENA, IN1, IN2 = 12, 17, 18
ENB, IN3, IN4 = 13, 22, 23
SEGUNDOS = 2
PWM_FREQ = 1000
DUTY_A = 55
DUTY_B = 50

def setup():
    GPIO.setmode(GPIO.BCM)
    for p in (ENA, IN1, IN2, ENB, IN3, IN4):
        GPIO.setup(p, GPIO.OUT, initial=GPIO.LOW)
    global pwm_a, pwm_b
    pwm_a = GPIO.PWM(ENA, PWM_FREQ)
    pwm_b = GPIO.PWM(ENB, PWM_FREQ)
    pwm_a.start(0)
    pwm_b.start(0)

def stop_all():
    GPIO.output((IN1, IN2, IN3, IN4), GPIO.LOW)
    pwm_a.ChangeDutyCycle(0)
    pwm_b.ChangeDutyCycle(0)

def main():
    setup()
    print("=== TEST RETROCESO SOLO (2s) ===")
    print("M1: ENA=12 IN1=17 IN2=18 | M2: ENB=13 IN3=22 IN4=23 | DUTY_A =", DUTY_A, "% DUTY_B =", DUTY_B, "%")
    try:
        stop_all()
        time.sleep(0.5)
        print(f"  [RETROCESO] M1 y M2 jalando {SEGUNDOS}s")
        GPIO.output(IN2, GPIO.HIGH)
        GPIO.output(IN4, GPIO.HIGH)
        GPIO.output(IN1, GPIO.LOW)
        GPIO.output(IN3, GPIO.LOW)
        pwm_a.ChangeDutyCycle(DUTY_A)
        pwm_b.ChangeDutyCycle(DUTY_B)
        time.sleep(SEGUNDOS)
        stop_all()
        print("=== FIN ===")
    except KeyboardInterrupt:
        print("\nInterrumpido: motores detenidos.")
    finally:
        stop_all()
        GPIO.cleanup()

if __name__ == "__main__":
    main()