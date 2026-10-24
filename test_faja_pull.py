#!/usr/bin/env python3
"""
test_faja_pull.py - Prueba de la faja (L298N, 2 motores) AMBOS JALANDO JUNTOS.
  ADELANTE = M1 jala con IN1=HI,IN2=LO  |  M2 jala con IN3=HI,IN4=LO
  ATRAS    = M1 jala con IN2=HI,IN1=LO  |  M2 jala con IN4=HI,IN3=LO
  M1 y M2 tienen velocidades distintas: M2 va mas rapido, por eso
  se reduce un poco su duty (DUTY_B) para equilibrar la faja.
  Sin coast: el motor libre no puede arrastrar la faja, ambos jalan juntos.
Pines (BCM):
  M1: ENA=12 IN1=17 IN2=18 | M2: ENB=13 IN3=22 IN4=23
Ruta: sudo python3 test_faja_pull.py
"""
import time
import RPi.GPIO as GPIO

ENA, IN1, IN2 = 12, 17, 18
ENB, IN3, IN4 = 13, 22, 23
PWM_FREQ = 1000
DUTY_A = 65
DUTY_B = 55
DUTY_A_TRAS = 55

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
    print(f"  [ADELANTE] M1 y M2 JALANDO {seconds}s")
    GPIO.output((IN1, IN3), GPIO.HIGH)
    GPIO.output((IN2, IN4), GPIO.LOW)
    pwm_a.ChangeDutyCycle(DUTY_A)
    pwm_b.ChangeDutyCycle(DUTY_B)
    time.sleep(seconds)
    stop_all()
    time.sleep(0.5)

def atras(seconds):
    stop_all()
    time.sleep(0.2)
    print(f"  [ATRAS]    M1 y M2 JALANDO {seconds}s")
    GPIO.output((IN2, IN4), GPIO.HIGH)
    GPIO.output((IN1, IN3), GPIO.LOW)
    pwm_a.ChangeDutyCycle(DUTY_A_TRAS)
    pwm_b.ChangeDutyCycle(DUTY_B)
    time.sleep(seconds)
    stop_all()
    time.sleep(0.5)

def main():
    setup()
    print("=== TEST FAJA: AMBOS MOTORES JUNTOS ===")
    print("M1: ENA=12 IN1=17 IN2=18 | M2: ENB=13 IN3=22 IN4=23 | DUTY_A =", DUTY_A, "% DUTY_B =", DUTY_B, "% A_TRAS =", DUTY_A_TRAS, "%")
    try:
        atras(2)
        adelante(3)
        print("=== FIN ===")
    except KeyboardInterrupt:
        print("\nInterrumpido: motores detenidos.")
    finally:
        stop_all()
        GPIO.cleanup()

if __name__ == "__main__":
    main()