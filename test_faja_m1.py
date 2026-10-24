#!/usr/bin/env python3
"""test_faja_m1.py - Test del M1 nada mas, con los mismos parametros que
test_faja.py (PWM 1000Hz, velocidad 50%). 
Uso: sudo python3 test_faja_m1.py <GPIO_IN2>   (default 18)
"""
import sys
import time
import RPi.GPIO as GPIO

ENA, IN1 = 12, 17
PIN2 = int(sys.argv[1]) if len(sys.argv) > 1 else 18
PWM_FREQ, DUTY = 1000, 50

def setup():
    global pwm_a
    GPIO.setmode(GPIO.BCM)
    for p in (IN1, PIN2, ENA):
        GPIO.setup(p, GPIO.OUT, initial=GPIO.LOW)
    pwm_a = GPIO.PWM(ENA, PWM_FREQ)
    pwm_a.start(0)

def stop():
    GPIO.output((IN1, PIN2), GPIO.LOW)
    pwm_a.ChangeDutyCycle(0)

def motor_run(label, in_hi, in_lo, seconds, nombre):
    stop()
    time.sleep(0.2)
    print(f"  [{label}] {nombre} {seconds}s")
    GPIO.output(in_hi, GPIO.HIGH)
    GPIO.output(in_lo, GPIO.LOW)
    pwm_a.ChangeDutyCycle(DUTY)
    time.sleep(seconds)
    stop()
    time.sleep(0.5)

def main():
    setup()
    print("=== TEST SOLO M1 (mismos params que test_faja) ===")
    print(f"ENA=12 | IN1=17 (avance) | IN2=GPIO{PIN2} (retroceso) | {PWM_FREQ}Hz {DUTY}%")
    try:
        motor_run('M1', IN1, PIN2, 3, 'AVANZANDO')
        motor_run('M1', PIN2, IN1, 5, 'RETROCEDIENDO')
        print("=== FIN ===")
    except KeyboardInterrupt:
        print("\nInterrumpido.")
    finally:
        stop()
        GPIO.cleanup()

if __name__ == "__main__":
    main()