#!/usr/bin/env python3
"""
test_faja_coast.py - Prueba faja con COAST (un motor jala, el otro libre).
  ADELANTE = M1 jala (IN1=HI,IN2=LO, ENA on)  |  M2 coast (ENB 0 -> salidas en alta impedancia)
  ATRAS    = M2 jala (IN4=HI,IN3=LO, ENB on)  |  M1 coast (ENA 0)
  Coast = EN en bajo -> el motor gira libre sin ofrecer resistencia.
Pines (BCM):
  M1: ENA=12 IN1=17 IN2=18 | M2: ENB=13 IN3=22 IN4=23
Ruta: sudo python3 test_faja_coast.py
"""
import time
import RPi.GPIO as GPIO

ENA, IN1, IN2 = 12, 17, 18
ENB, IN3, IN4 = 13, 22, 23
PWM_FREQ = 1000
DUTY = 50

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

def adelante(seconds):
    stop_all()
    time.sleep(0.2)
    print(f"  [ADELANTE] M1 JALANDO {seconds}s | M2 coast (libre)")
    GPIO.output(IN1, GPIO.HIGH)
    GPIO.output(IN2, GPIO.LOW)
    pwm_a.ChangeDutyCycle(DUTY)
    pwm_b.ChangeDutyCycle(0)
    time.sleep(seconds)
    stop_all()
    time.sleep(0.5)

def atras(seconds):
    stop_all()
    time.sleep(0.2)
    print(f"  [ATRAS]    M2 JALANDO {seconds}s | M1 coast (libre)")
    GPIO.output(IN4, GPIO.HIGH)
    GPIO.output(IN3, GPIO.LOW)
    pwm_a.ChangeDutyCycle(0)
    pwm_b.ChangeDutyCycle(DUTY)
    time.sleep(seconds)
    stop_all()
    time.sleep(0.5)

def main():
    setup()
    print("=== TEST FAJA COAST ===")
    print("M1: ENA=12 IN1=17 IN2=18 | M2: ENB=13 IN3=22 IN4=23 | DUTY =", DUTY, "%")
    try:
        adelante(3)
        atras(3)
        adelante(2)
        atras(2)
        print("=== FIN ===")
    except KeyboardInterrupt:
        print("\nInterrumpido: motores detenidos.")
    finally:
        stop_all()
        GPIO.cleanup()

if __name__ == "__main__":
    main()