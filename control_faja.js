/**
 * control_faja.js
 * ---------------------------------------------------------------------------
 * CÓDIGO QUE CONTROLA LA FAJA TRANSPORTADORA DEL SMART PET FEEDER
 *
 * Este archivo es un EXTRACTO de server.js (el controlador que corre en la
 * Raspberry Pi 3B+, Node.js 18). No es un módulo independiente: depende de
 * `lgpio`, de `gpioHandle` y de la app Express del server.js original.
 * Sirve como referencia de cómo funciona la faja.
 *
 * ---------------------------------------------------------------------------
 * HARDWARE
 * ---------------------------------------------------------------------------
 * - La faja se maneja con un puente H L298N de 2 canales (2 motores).
 * - La controla la RASPBERRY directamente por GPIO con la librería `lgpio`
 *   (NO el ESP32).
 * - Pines (numeración BCM):
 *
 *      Motor 1:  ENA = GPIO12 (PWM)   IN1 = GPIO17   IN2 = GPIO18
 *      Motor 2:  ENB = GPIO13 (PWM)   IN3 = GPIO22   IN4 = GPIO23
 *
 * - Ambos motores giran juntos en cada fase:
 *      Adelante : M1 -> IN1, M2 -> IN3
 *      Atrás    : M1 -> IN2, M2 -> IN4
 *   (El motor "libre" no arrastra la faja, por eso se usan los dos.)
 * - La velocidad se regula con PWM por software: lgpio.txPwm(pin, Hz, duty).
 * ---------------------------------------------------------------------------
 */

// ─── Pines (BCM) ────────────────────────────────────────────────────────────
const M1_ENA = 12, M1_IN1 = 17, M1_IN2 = 18;
const M2_ENB = 13, M2_IN3 = 22, M2_IN4 = 23;

// Duraciones del ciclo de limpieza
const FAJA_ADELANTE_MS = 3000;
const FAJA_RETORNO_MS = 3000;

// ─── Inicialización GPIO (fragmento de gpioInit) ─────────────────────────────
// Se reclaman todos los pines de la faja como salida, en 0 (detenidos).
const FAJA_PINS = [M1_ENA, M1_IN1, M1_IN2, M2_ENB, M2_IN3, M2_IN4];

function gpioInit() {
  try {
    if (!gpioHandle) gpioHandle = lgpio.gpiochipOpen(0);
    lgpio.gpioClaimOutput(gpioHandle, RELAY_PIN, 0);   // relé humidificador (GPIO5)
    for (const pin of FAJA_PINS) lgpio.gpioClaimOutput(gpioHandle, pin, 0);
    console.log('[GPIO] Rele en GPIO' + RELAY_PIN + ' | Faja en pins ' + FAJA_PINS.join(','));
    return true;
  } catch (e) {
    console.error('[GPIO] Error:', e.message);
    return false;
  }
}

// ─── Faja: ambos motores jalan juntos en cada fase ──────────────────────────
const FAJA_PWM_FREQ = 1000;
const FAJA_DUTY_A = 65;      // M1 adelante
const FAJA_DUTY_B = 55;      // M2 adelante
const FAJA_DUTY_A_TRAS = 55; // M1 retroceso
const FAJA_DUTY_B_TRAS = 50; // M2 retroceso
let fajaTestTimer = null;

// Detiene la faja (todos los pines a 0) y cancela cualquier prueba temporizada.
function fajaStop() {
  if (gpioHandle === null) return;
  for (const pin of FAJA_PINS) lgpio.gpioWrite(gpioHandle, pin, 0);
  if (fajaTestTimer) { clearTimeout(fajaTestTimer); fajaTestTimer = null; }
}

// Mueve la faja con duty configurable por motor ("forward" | "backward").
function fajaRun(direction, dutyA = FAJA_DUTY_A, dutyB = FAJA_DUTY_B) {
  if (gpioHandle === null) return false;
  fajaStop();
  const A_HI = direction === 'forward' ? M1_IN1 : M1_IN2;
  const B_HI = direction === 'forward' ? M2_IN3 : M2_IN4;
  lgpio.gpioWrite(gpioHandle, A_HI, 1);
  lgpio.gpioWrite(gpioHandle, B_HI, 1);
  lgpio.txPwm(gpioHandle, M1_ENA, FAJA_PWM_FREQ, dutyA);
  lgpio.txPwm(gpioHandle, M2_ENB, FAJA_PWM_FREQ, dutyB);
  return true;
}

// Atajos: adelante / retroceso con los duty por defecto.
function fajaAdelante() {
  return fajaRun('forward');
}

function fajaRetorno() {
  return fajaRun('backward', FAJA_DUTY_A_TRAS, FAJA_DUTY_B_TRAS);
}

// Prueba única: dirección + tiempo + PWM por motor (duty 0-100).
// Programa fajaStop() automáticamente al terminar `duration_ms`.
async function fajaTest({ direction = 'forward', duration_ms = 3000, duty_a, duty_b } = {}) {
  fajaStop();
  const dA = Number.isFinite(duty_a) ? Math.min(100, Math.max(0, duty_a)) : (direction === 'backward' ? FAJA_DUTY_A_TRAS : FAJA_DUTY_A);
  const dB = Number.isFinite(duty_b) ? Math.min(100, Math.max(0, duty_b)) : (direction === 'backward' ? FAJA_DUTY_B_TRAS : FAJA_DUTY_B);
  fajaRun(direction, dA, dB);
  const ms = Math.max(100, Number(duration_ms) || 3000);
  fajaTestTimer = setTimeout(fajaStop, ms);
  return { direction, duration_ms: ms, duty_a: dA, duty_b: dB };
}

function fajaBusy() {
  return fajaTestTimer !== null;
}

// ─── Endpoints HTTP (Express) ───────────────────────────────────────────────
// POST /faja/test  body: { direction: "forward"|"backward", duration_ms?, duty_a?, duty_b? }
app.post('/faja/test', async (req, res) => {
  const { direction, duration_ms, duty_a, duty_b } = req.body || {};
  if (!['forward', 'backward'].includes(direction)) {
    return res.status(400).json({ status: 'error', message: 'direction: forward | backward' });
  }
  const result = await fajaTest({ direction, duration_ms, duty_a, duty_b });
  res.json({ status: 'ok', ...result });
});

// POST /faja/stop  -> detiene de inmediato.
app.post('/faja/stop', (req, res) => { fajaStop(); res.json({ status: 'ok' }); });

// GET /faja/busy  -> { busy: true|false } si hay una prueba temporizada en curso.
app.get('/faja/busy', (req, res) => res.json({ busy: fajaBusy() }));

// ─── USO 1: retroceso breve al final de la secuencia de alimentación ─────────
// (dentro de runFeedingSequence, tras cerrar la compuerta inferior)
//
//   updateStep(7, 'Retrocediendo faja...', 85);
//   fajaRetorno();          // marcha atrás (duty 55/50)
//   await delay(1500);      // 1.5 segundos
//   fajaStop();
//
// ─── USO 2: ciclo de limpieza automática (al retirarse la mascota) ──────────
async function runCleaning() {
  if (state.cleaning) return;
  state.cleaning = true;
  broadcast();
  console.log(`[LIMPIEZA] Iniciando ciclo de faja (adelante ${FAJA_ADELANTE_MS}ms, retorno ${FAJA_RETORNO_MS}ms)...`);
  try {
    fajaAdelante();
    await new Promise((r) => setTimeout(r, FAJA_ADELANTE_MS));
    fajaRetorno();
    await new Promise((r) => setTimeout(r, FAJA_RETORNO_MS));
  } catch (e) {
    console.error('[LIMPIEZA] Error:', e.message);
  } finally {
    fajaStop();
    state.cleaning = false;
    broadcast();
    console.log('[LIMPIEZA] Ciclo de faja completado');
  }
}

// ─── USO 3: apagado seguro (SIGINT / SIGTERM) ───────────────────────────────
process.on('SIGINT', () => {
  console.log('\n[Cierre] Limpiando...');
  setRelay(false);
  fajaStop();
  stopDispenser();
  if (gpioHandle) lgpio.gpiochipClose(gpioHandle);
  process.exit(0);
});

process.on('SIGTERM', () => {
  setRelay(false);
  fajaStop();
  stopDispenser();
  process.exit(0);
});
