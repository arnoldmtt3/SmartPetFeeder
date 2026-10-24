#!/usr/bin/env python3
"""
test_faja.py - Prueba de los 2 motores de la faja (L298N) en la Raspberry Pi 3B
Ruta critica: ejecutar con sudo ->  sudo python3 test_faja.py
Cableado en el conector de 40 pines (numeros BCM):
  M1 (motor A): ENA=GPIO12(pin32)  IN1=GPIO17(pin11)  IN2=GPIO18(pin12)
  M2 (motor B): ENB=GPIO13(pin33)  IN3=GPIO22(pin15)  IN4=GPIO23(pin16)
  Alimentacion L298N: 12V externo + GND comun con la Pi.
"""
import RPi.GPIO as GPIO
import time

# --- Pines (BCM) ---
ENA, IN1, IN2 = 12, 17, 18
ENB, IN3, IN4 = 13, 22, 23

PWM_FREQ = 1000   # Hz
DUTY = 50         # % de velocidad (ajusta 0-100)

def motor_setup():
    GPIO.setmode(GPIO.BCM)
    for p in (IN1, IN2, IN3, IN4, ENA, ENB):
        GPIO.setup(p, GPIO.OUT, initial=GPIO.LOW)
    global pwm_a, pwm_b
    pwm_a = GPIO.PWM(ENA, PWM_FREQ)
    pwm_b = GPIO.PWM(ENB, PWM_FREQ)
    pwm_a.start(0)
    pwm_b.start(0)

def motor_stop_all():
    GPIO.output((IN1, IN2, IN3, IN4), GPIO.LOW)
    pwm_a.ChangeDutyCycle(0)
    pwm_b.ChangeDutyCycle(0)

def motor_run(label, in_hi, in_lo, pwm, seconds, direction):
    motor_stop_all()
    time.sleep(0.2)
    print(f"  [{label}] {direction} durante {seconds}s")
    GPIO.output(in_hi, GPIO.HIGH)
    GPIO.output(in_lo, GPIO.LOW)
    pwm.ChangeDutyCycle(DUTY)
    time.sleep(seconds)
    motor_stop_all()
    time.sleep(0.5)

def main():
    motor_setup()
    print("=== Test faja: 2 motores (L298N) ===")
    print("M1: ENA=12 IN1=17 IN2=18 | M2: ENB=13 IN3=22 IN4=23")
    print("Velocidad:", DUTY, "% | Frecuencia PWM:", PWM_FREQ, "Hz")
    print("Si no giran: revisa 12V en L298N, GND comun y ENA/ENB.")
    try:
        motor_run("M1", IN1, IN2, pwm_a, 2, "AVANZANDO")
        motor_run("M1", IN2, IN1, pwm_a, 3, "RETROCEDIENDO")
        motor_run("M2", IN3, IN4, pwm_b, 2, "AVANZANDO")
        motor_run("M2", IN4, IN3, pwm_b, 2, "RETROCEDIENDO")

        print("  [AMBOS] AVANZANDO durante 2s")
        motor_stop_all(); time.sleep(0.2)
        GPIO.output((IN1, IN3), GPIO.HIGH)
        GPIO.output((IN2, IN4), GPIO.LOW)
        pwm_a.ChangeDutyCycle(DUTY); pwm_b.ChangeDutyCycle(DUTY)
        time.sleep(2)
        motor_stop_all()

        print("  [AMBOS] RETROCEDIENDO durante 2s")
        GPIO.output((IN2, IN4), GPIO.HIGH)
        GPIO.output((IN1, IN3), GPIO.LOW)
        pwm_a.ChangeDutyCycle(DUTY); pwm_b.ChangeDutyCycle(DUTY)
        time.sleep(2)
        motor_stop_all()

        print("=== Test completado OK ===")
    except KeyboardInterrupt:
        print("\nInterrumpido: motores detenidos.")
    finally:
        motor_stop_all()
        GPIO.cleanup()

if __name__ == "__main__":
    main()