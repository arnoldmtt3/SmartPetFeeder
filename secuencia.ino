#include <ESP32Servo.h>

Servo servoDosificador;
Servo servoSuperior;
Servo servoInferior;

// =========================
// Pines
// =========================
const int pinServoDosificador = 19;
const int pinServoSuperior    = 18;
const int pinServoInferior    = 21;
const int pinRele             = 23;

// Pines para motores de la faja (Puente H)
const int m1Pin1 = 22;
const int m1Pin2 = 4;
const int m2Pin1 = 16;
const int m2Pin2 = 17;

// =========================
// Servo dosificador 360°
// =========================
float msPorGrado = 4.3;

const int detener         = 1500;
const int giroHorario     = 2000;
const int giroAntihorario = 1000;

// Configuración dosificación
const int GRADOS_POR_RACION = 120;   // 120° = 12g
const int GRAMOS_POR_RACION = 12;    // 1 ración = 12g

// =========================
// Servos posicionales
// =========================
int anguloSuperiorActual = 0;
int anguloInferiorActual = 180;

void setup() {

  Serial.begin(115200);
  Serial.setTimeout(2000);

  servoDosificador.setPeriodHertz(50);
  servoSuperior.setPeriodHertz(50);
  servoInferior.setPeriodHertz(50);

  servoDosificador.attach(pinServoDosificador, 500, 2500);
  servoSuperior.attach(pinServoSuperior, 500, 2500);
  servoInferior.attach(pinServoInferior, 500, 2500);

  // Posiciones iniciales
  servoDosificador.writeMicroseconds(detener);
  servoSuperior.write(anguloSuperiorActual);
  servoInferior.write(anguloInferiorActual);

  // Configuración del relé
  pinMode(pinRele, OUTPUT);
  digitalWrite(pinRele, LOW);   // Relé APAGADO al iniciar

  // Configuración de pines de motores de faja
  pinMode(m1Pin1, OUTPUT);
  pinMode(m1Pin2, OUTPUT);
  pinMode(m2Pin1, OUTPUT);
  pinMode(m2Pin2, OUTPUT);
  detenerInercia(m1Pin1, m1Pin2);
  detenerInercia(m2Pin1, m2Pin2);

  Serial.println("======================================");
  Serial.println("Sistema listo");
  Serial.println("======================================");
  Serial.println("1 120  -> Dosificador +120 grados (1 racion)");
  Serial.println("1 -90  -> Dosificador -90 grados");
  Serial.println("2 180  -> Compuerta superior");
  Serial.println("2 0    -> Compuerta superior");
  Serial.println("3 180  -> Compuerta inferior");
  Serial.println("3 0    -> Compuerta inferior");
  Serial.println("4 1    -> Encender rele");
  Serial.println("4 0    -> Apagar rele");
  Serial.println("5 1    -> Ciclo de limpieza con faja");
  Serial.println("6 N    -> Dosificar N raciones (12g c/u)");
  Serial.println("7 [ms] [1/0] -> Giro por tiempo (1=horario)");
  Serial.println("======================================");
}

void loop() {

  if (Serial.available() > 0) {

    int numeroServo = Serial.parseInt();
    int valor = Serial.parseInt();

    // Servo dosificador
    if (numeroServo == 1 && valor != 0) {

      Serial.print("Moviendo dosificador: ");
      Serial.print(valor);
      Serial.println(" grados");

      girarDosificador(valor);
    }

    // Servo superior
    else if (numeroServo == 2) {

      valor = constrain(valor, 0, 180);

      Serial.print("Compuerta superior -> ");
      Serial.print(valor);
      Serial.println(" grados");

      moverCompuertaSuperior(valor);
    }

    // Servo inferior
    else if (numeroServo == 3) {

      valor = constrain(valor, 0, 180);

      Serial.print("Compuerta inferior -> ");
      Serial.print(valor);
      Serial.println(" grados");

      moverCompuertaInferior(valor);
    }

    // Relé
    else if (numeroServo == 4) {

      if (valor == 1) {

        digitalWrite(pinRele, HIGH);   // Encender relé

        Serial.println("Rele ENCENDIDO");
      }

      else if (valor == 0) {

        digitalWrite(pinRele, LOW);    // Apagar relé

        Serial.println("Rele APAGADO");
      }

      else {

        Serial.println("Usa:");
        Serial.println("4 1 -> Encender");
        Serial.println("4 0 -> Apagar");
      }
    }

    // Ciclo de limpieza con faja
    else if (numeroServo == 5 && valor == 1) {
      ejecutarCicloLimpiezaFaja();
    }

    // Dosificar N raciones (comando 6)
    else if (numeroServo == 6 && valor > 0) {
      dosificarRaciones(valor);
    }

    // Giro por tiempo (comando 7): 7 [ms] [1=horario 0=antihorario]
    else if (numeroServo == 7 && valor > 0) {
      int dir = Serial.parseInt();
      girarPorTiempo(valor, dir == 1);
    }

    else {

      Serial.println("Comando no valido.");
    }

    while (Serial.available() > 0) {
      Serial.read();
    }

    Serial.println();
    Serial.println("Ingrese otro comando:");
  }
}

//==========================================
// Funciones
//==========================================

void girarDosificador(int grados) {

  int direccion;

  if (grados > 0) {
    direccion = giroHorario;
  } else {
    direccion = giroAntihorario;
    grados = -grados;
  }

  int tiempoGiro = grados * msPorGrado;

  servoDosificador.writeMicroseconds(direccion);

  delay(tiempoGiro);

  servoDosificador.writeMicroseconds(detener);
}

void moverCompuertaSuperior(int angulo) {

  servoSuperior.write(angulo);
  anguloSuperiorActual = angulo;

  delay(800);
}

void moverCompuertaInferior(int angulo) {

  servoInferior.write(angulo);
  anguloInferiorActual = angulo;

  delay(800);
}

void detenerInercia(int p1, int p2) {
  digitalWrite(p1, LOW);
  digitalWrite(p2, LOW);
}

void tensarFaja() {
  Serial.println("Tensando faja...");
  digitalWrite(m1Pin1, HIGH);
  digitalWrite(m1Pin2, LOW);
  digitalWrite(m2Pin1, LOW);
  digitalWrite(m2Pin2, HIGH);
  delay(300);
  detenerInercia(m1Pin1, m1Pin2);
  detenerInercia(m2Pin1, m2Pin2);
}

void ejecutarCicloLimpiezaFaja() {
  Serial.println("Iniciando ciclo de limpieza de faja...");

  // Activar agua opcionalmente
  digitalWrite(pinRele, HIGH);
  delay(1000);

  // Motor 1 enrolla, Motor 2 en inercia
  digitalWrite(m1Pin1, HIGH);
  digitalWrite(m1Pin2, LOW);
  detenerInercia(m2Pin1, m2Pin2);

  delay(4000);

  // Apagar agua
  digitalWrite(pinRele, LOW);

  // Detener motor y tensar
  detenerInercia(m1Pin1, m1Pin2);
  tensarFaja();

  Serial.println("Ciclo de limpieza de faja finalizado.");
}

void dosificarRaciones(int numRaciones) {
  if (numRaciones <= 0) {
    Serial.println("Error: Numero de raciones debe ser > 0");
    return;
  }

  int totalGrados = numRaciones * GRADOS_POR_RACION;
  int totalGramos = numRaciones * GRAMOS_POR_RACION;

  Serial.print("Dosificando ");
  Serial.print(numRaciones);
  Serial.print(" raciones = ");
  Serial.print(totalGramos);
  Serial.print("g (");
  Serial.print(totalGrados);
  Serial.println(" grados)");

  for (int i = 0; i < numRaciones; i++) {
    Serial.print("Racion ");
    Serial.print(i + 1);
    Serial.print("/");
    Serial.println(numRaciones);
    
    girarDosificador(GRADOS_POR_RACION);
    
    // Pequeña pausa entre raciones para que caiga el alimento
    if (i < numRaciones - 1) {
      delay(500);
    }
  }

  Serial.print("Dosificacion completada: ");
  Serial.print(totalGramos);
  Serial.println("g");
}

void girarPorTiempo(int ms, bool horario) {

  Serial.print("Girando dosificador ");
  Serial.print(ms);
  Serial.println(horario ? " ms horario" : " ms antihorario");

  servoDosificador.writeMicroseconds(horario ? giroHorario : giroAntihorario);

  delay(ms);

  servoDosificador.writeMicroseconds(detener);
}
