#include <ESP32Servo.h>

Servo servoDosificador;
Servo servoSuperior;
Servo servoInferior;

// =========================
// Pines
// =========================
const int pinServoDosificador = 18;
const int pinServoSuperior    = 19;
const int pinServoInferior    = 21;
const int pinRele             = 23;

// Pines para motores de la faja (Puente H)
const int m1Pin1 = 22;
const int m1Pin2 = 4;
const int m2Pin1 = 16;
const int m2Pin2 = 17;

// =========================
// Sensor óptico ranurado FC-03
// =========================
const int pinFC03           = 25;      // Salida digital DO del FC-03
const int RANURAS_POR_REV   = 1;       // 1 pulso = 1 vuelta (sensor de ranura simple, sin disco)
const unsigned long DEBOUNCE_US = 2000; // Antibote (2 ms)
volatile unsigned long pulsosFC03   = 0;
volatile unsigned long ultimoPulsoFC03 = 0;
volatile int nivelReposoFC03 = 1;      // Nivel del pin sin objeto (se lee en setup)

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
int anguloSuperiorActual = 180;
int anguloInferiorActual = 180;

// Prototipos (necesarios porque los define despues de setup/loop)
void IRAM_ATTR contarPulsoFC03();
void girarPorPulsos(int pulsosObjetivo);

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

  // Sensor óptico FC-03 (entrada digital con interrupción)
  pinMode(pinFC03, INPUT_PULLUP);
  delay(100);
  nivelReposoFC03 = digitalRead(pinFC03);   // Nivel sin objeto
  attachInterrupt(digitalPinToInterrupt(pinFC03), contarPulsoFC03, CHANGE);

  Serial.println("======================================");
  Serial.println("Sistema listo");
  Serial.println("======================================");
  Serial.println("1 120  -> Dosificador +120 grados (1 racion)");
  Serial.println("1 -90  -> Dosificador -90 grados");
  Serial.println("2 180  -> Compuerta cerrada (superior)");
  Serial.println("2 0    -> Compuerta abierta (superior)");
  Serial.println("3 180  -> Compuerta inferior");
  Serial.println("3 0    -> Compuerta inferior");
  Serial.println("4 1    -> Encender rele");
  Serial.println("4 0    -> Apagar rele");
  Serial.println("5 1    -> Ciclo de limpieza con faja");
  Serial.println("6 N    -> Dosificar N porciones (1 vuelta c/u)");
  Serial.println("7 [ms] [1/0] -> Giro por tiempo (1=horario)");
  Serial.println("8 N    -> Girar hasta N pulsos (N vueltas) del FC-03");
  Serial.println("9 0    -> Mostrar conteo de pulsos/vueltas del FC-03");
  Serial.println("10 0   -> Diagnostico: leer nivel del pin FC-03");
  Serial.println("11 0   -> Reiniciar contador de pulsos del FC-03");
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

    // Dosificar hasta N pulsos del FC-03 (comando 8)
    else if (numeroServo == 8 && valor > 0) {
      girarPorPulsos(valor);
    }

    // Mostrar conteo de pulsos (comando 9)
    else if (numeroServo == 9) {
      Serial.print("Pulsos FC-03: ");
      Serial.println(pulsosFC03);
      if (RANURAS_POR_REV == 1) {
        Serial.print("Equivale a ");
        Serial.print(pulsosFC03);
        Serial.println(" vueltas del dosificador");
      } else if (RANURAS_POR_REV > 1) {
        uint32_t p = pulsosFC03;
        Serial.print("Equivale a ");
        Serial.print(p / RANURAS_POR_REV);
        Serial.print(" vueltas y ");
        Serial.print(p % RANURAS_POR_REV);
        Serial.print(" ranuras (");
        Serial.print(RANURAS_POR_REV);
        Serial.println(" ranuras/vuelta)");
      }
    }

    // Diagnostico: leer en vivo el nivel del pin del FC-03 (comando 10)
    else if (numeroServo == 10) {
      Serial.println("Lectura GPIO25 (FC-03) por 8s. Bloquea/desbloquea la ranura...");
      int prev = digitalRead(pinFC03);
      Serial.print("Nivel inicial: ");
      Serial.println(prev);
      unsigned long t0 = millis();
      while (millis() - t0 < 8000) {
        int v = digitalRead(pinFC03);
        if (v != prev) {
          Serial.print("Cambio -> ");
          Serial.println(v);
          prev = v;
        }
        delay(1);
      }
      Serial.println("Fin lectura GPIO25");
    }

    // Reiniciar contador de pulsos (comando 11)
    else if (numeroServo == 11) {
      noInterrupts();
      pulsosFC03 = 0;
      ultimoPulsoFC03 = 0;
      interrupts();
      Serial.println("Contador FC-03 reiniciado a 0");
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
// Sensores
//==========================================

void IRAM_ATTR contarPulsoFC03() {
  int v = digitalRead(pinFC03);
  if (v == nivelReposoFC03) return;   // Ignora el flanco de vuelta al reposo
  unsigned long ahora = micros();
  if (ahora - ultimoPulsoFC03 >= DEBOUNCE_US) {
    ultimoPulsoFC03 = ahora;
    pulsosFC03++;
  }
}

void girarPorPulsos(int pulsosObjetivo) {

  if (pulsosObjetivo <= 0) {
    Serial.println("Error: pulsos debe ser > 0");
    return;
  }

  // Reiniciar el contador solo para esta dosificación
  unsigned long inicio = pulsosFC03;

  Serial.print("Girando dosificador hasta ");
  Serial.print(pulsosObjetivo);
  Serial.println(" pulsos (= vueltas) del FC-03...");

  servoDosificador.writeMicroseconds(giroHorario);

  // Tiempo de seguridad: si no se alcanzan los pulsos, detener
  unsigned long tiempoInicio = millis();
  const unsigned long TIMEOUT_MS = 30000;

  while ((pulsosFC03 - inicio) < (unsigned long)pulsosObjetivo) {
    if (millis() - tiempoInicio > TIMEOUT_MS) {
      Serial.println("Timeout: no se alcanzaron los pulsos.");
      break;
    }
    delay(1);
  }

  servoDosificador.writeMicroseconds(detener);

  Serial.print("Dosificacion completada: ");
  Serial.print(pulsosFC03 - inicio);
  Serial.println(" pulsos contados.");

  delay(200);
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
    Serial.println("Error: numero de porciones debe ser > 0");
    return;
  }

  Serial.print("Dosificando ");
  Serial.print(numRaciones);
  Serial.println(" porciones (1 vuelta c/u)...");

  for (int i = 0; i < numRaciones; i++) {
    Serial.print("Porcion ");
    Serial.print(i + 1);
    Serial.print("/");
    Serial.println(numRaciones);

    // 1 porcion = 1 vuelta = 1 pulso del FC-03
    girarPorPulsos(1);

    // Pausa entre porciones para que caiga el alimento
    if (i < numRaciones - 1) {
      delay(300);
    }
  }

  Serial.print("Dosificacion completada: ");
  Serial.print(numRaciones);
  Serial.println(" porciones");
}

void girarPorTiempo(int ms, bool horario) {

  Serial.print("Girando dosificador ");
  Serial.print(ms);
  Serial.println(horario ? " ms horario" : " ms antihorario");

  servoDosificador.writeMicroseconds(horario ? giroHorario : giroAntihorario);

  delay(ms);

  servoDosificador.writeMicroseconds(detener);
}