#!/usr/bin/env node
/**
 * SmartPetFeeder - Node.js Server v2.1
 * Servos (compuertas y dosificador) y sensor FC-03 via ESP32 (serial USB).
 * Rele y faja via GPIO de la Raspberry Pi (lgpio).
 * Sirve la interfaz web y maneja WebSocket para tiempo real.
 *
 * Hardware:
 *   ESP32 (/dev/ttyUSB0, 115200):
 *     cmd 2 -> Servo compuerta superior (posicional)
 *     cmd 3 -> Servo compuerta inferior (posicional)
 *     cmd 6 -> Dosificador N porciones (1 vuelta = 1 pulso FC-03 = 12 g)
 *     cmd 7 -> Giro por tiempo del dosificador
 *   GPIO 5 -> Rele humidificador ; faja (L298N) en GPIO 12,13,17,18,22,23
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const lgpio = require('lgpio');
const Database = require('better-sqlite3');
const { createAuth } = require('./auth');
const { authorizeLocalAgent } = require('./agent/local-auth');

// ─── Config ────────────────────────────────────────────────────────
const PORT = 3000;
const I2C_ADDR = 0x40;
const I2C_BUS = 1;
const RELAY_PIN = 5;

// ─── Faja (L298N, 2 motores) ──────────────────────────────────────
// Ambos motores jalan juntos. Adelante: M1 con IN1 / M2 con IN3.
// Atras: M1 con IN2 / M2 con IN4. Sin coast: el motor libre no
// arrastra la faja, asi que los dos jalan en cada fase.
const M1_ENA = 12, M1_IN1 = 17, M1_IN2 = 18;
const M2_ENB = 13, M2_IN3 = 22, M2_IN4 = 23;
const FAJA_ADELANTE_MS = 3000;
const FAJA_RETORNO_MS = 3000;

// PCA9685 registers
const MODE1 = 0x00;
const PRESCALE = 0xFE;
const LED0_ON_L = 0x06;

// Servo channels
const CH_SUPERIOR = 0;
const CH_DOSIFICADOR = 1;
const CH_INFERIOR = 2;

// Movement constants
const GRAMOS_POR_REV = 12;
const TIEMPO_POR_REV = 1.548;
const ABIERTO_SUPERIOR = 0;
const ABIERTO_INFERIOR = 0;
const CERRADO_SUPERIOR = 180;
const CERRADO_INFERIOR = 180;

// ─── State ─────────────────────────────────────────────────────────
const state = {
  superior_open: true,
  inferior_open: false,
  humidifier_on: false,
  sequence_running: false,
  sequence_success: false,
  sequence_step: 0,
  sequence_step_name: '',
  sequence_progress_pct: 0,
  cleaning: false,
};

// ─── SQLite Database ────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'data', 'smartpetfeeder.db');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    hour INTEGER NOT NULL,
    minute INTEGER NOT NULL,
    portions INTEGER DEFAULT 12,
    humidify INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS last_feed (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    portions INTEGER DEFAULT 12,
    humidify INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS feed_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    time TEXT,
    portions TEXT,
    humidify TEXT,
    status TEXT,
    source TEXT DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// Migración para bases de datos creadas antes de la columna source
try {
  db.exec("ALTER TABLE feed_log ADD COLUMN source TEXT DEFAULT 'manual'");
  console.log('[DB] Migración: columna source agregada a feed_log');
} catch {
  // La columna ya existe, nada que hacer
}

const feedLog = [];

// ─── Settings (clave/valor en SQLite) ─────────────────────────────
function loadSetting(key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  } catch { return fallback; }
}
function saveSetting(key, value) {
  try {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  } catch (e) {
    console.error('[DB] Error guardando setting:', e.message);
  }
}

// ─── lgpio handles ────────────────────────────────────────────────
let gpioHandle = null;
let i2cHandle = null;
let i2cReady = false;

// ─── PCA9685 via lgpio I2C ───────────────────────────────────────
function pca9685Init() {
  try {
    gpioHandle = lgpio.gpiochipOpen(0);
    i2cHandle = lgpio.i2cOpen(I2C_BUS, I2C_ADDR, 0);

    // Reset
    lgpio.i2cWriteByteData(i2cHandle, MODE1, 0x00);

    // Set PWM frequency to ~50Hz: prescale = 25MHz/(4096*50) - 1 = 127
    const prescaleVal = 127;
    const oldMode = lgpio.i2cReadByteData(i2cHandle, MODE1);
    const sleepMode = (oldMode & 0x7F) | 0x10;
    lgpio.i2cWriteByteData(i2cHandle, MODE1, sleepMode);
    lgpio.i2cWriteByteData(i2cHandle, PRESCALE, prescaleVal);
    lgpio.i2cWriteByteData(i2cHandle, MODE1, oldMode);

    // Auto-increment
    setTimeout(() => {
      lgpio.i2cWriteByteData(i2cHandle, MODE1, oldMode | 0xA0);
    }, 5);

    i2cReady = true;
    console.log('[PCA9685] OK en I2C bus ' + I2C_BUS + ' addr 0x' + I2C_ADDR.toString(16));
    return true;
  } catch (e) {
    console.error('[PCA9685] Error:', e.message);
    return false;
  }
}

function setPulse(channel, pulseMs) {
  if (!i2cReady) return;
  const off = Math.round((pulseMs / 20) * 4096) & 0x0FFF;
  const reg = LED0_ON_L + 4 * channel;
  lgpio.i2cWriteWordData(i2cHandle, reg, 0);
  lgpio.i2cWriteWordData(i2cHandle, reg + 2, off);
}

function setAngle(channel, angle) {
  const pulseMs = 0.5 + (angle / 180) * 2.0;
  setPulse(channel, pulseMs);
}

const DOSIFIER_NEUTRAL_MS = 1.575; // trim: neutro real del servo dosificador (parada)
function setThrottle(channel, throttle) {
  const pulseMs = DOSIFIER_NEUTRAL_MS + throttle * 0.5;
  setPulse(channel, pulseMs);
}

// ─── GPIO: relé humidificador + faja ──────────────────────────────
const FAJA_PINS = [M1_ENA, M1_IN1, M1_IN2, M2_ENB, M2_IN3, M2_IN4];
function gpioInit() {
  try {
    if (!gpioHandle) gpioHandle = lgpio.gpiochipOpen(0);
    lgpio.gpioClaimOutput(gpioHandle, RELAY_PIN, 0);
    for (const pin of FAJA_PINS) lgpio.gpioClaimOutput(gpioHandle, pin, 0);
    console.log('[GPIO] Rele en GPIO' + RELAY_PIN + ' | Faja en pins ' + FAJA_PINS.join(','));
    return true;
  } catch (e) {
    console.error('[GPIO] Error:', e.message);
    return false;
  }
}

function setRelay(on) {
  if (gpioHandle === null) return;
  lgpio.gpioWrite(gpioHandle, RELAY_PIN, on ? 1 : 0);
  state.humidifier_on = on;
}

// ─── Faja: ambos motores jalan juntos en cada fase ────────────────
const FAJA_PWM_FREQ = 1000;
const FAJA_DUTY_A = 65;   // M1 adelante
const FAJA_DUTY_B = 55;   // M2 adelante
const FAJA_DUTY_A_TRAS = 55; // M1 retroceso
const FAJA_DUTY_B_TRAS = 50; // M2 retroceso
let fajaTestTimer = null;

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

function fajaAdelante() {
  return fajaRun('forward');
}

function fajaRetorno() {
  return fajaRun('backward', FAJA_DUTY_A_TRAS, FAJA_DUTY_B_TRAS);
}

// Prueba única: dirección + tiempo + PWM por motor (duty 0-100).
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

// ─── ESP32 (serial USB): servos compuertas + dosificador + sensor FC-03 ──
// Los servos (compuertas y dosificador) están conectados al ESP32 (/dev/ttyUSB0),
// no a la PCA9685. Cada comando se envía vía esp32_cmd.py y se espera a que el
// firmware termine (marca "Ingrese otro comando:").
const ESP32_SCRIPT = path.join(__dirname, 'esp32_cmd.py');

function esp32Cmd(cmd, timeoutMs = 15000) {
  const secs = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  return new Promise((resolve, reject) => {
    execFile('python3', [ESP32_SCRIPT, secs, cmd], { timeout: timeoutMs + 3000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve((stdout || '').toString());
    });
  });
}

// ─── Actuators (ESP32) ─────────────────────────────────────────────
// Comando 2 = compuerta superior, 3 = compuerta inferior (angulo 0-180).
function openUpperDoor() {
  esp32Cmd(`2 ${ABIERTO_SUPERIOR}`).catch(() => {});
  state.superior_open = true;
  broadcast();
}

function closeUpperDoor() {
  esp32Cmd(`2 ${CERRADO_SUPERIOR}`).catch(() => {});
  state.superior_open = false;
  broadcast();
}

function openLowerDoor() {
  esp32Cmd(`3 ${ABIERTO_INFERIOR}`).catch(() => {});
  state.inferior_open = true;
  broadcast();
}

function closeLowerDoor() {
  esp32Cmd(`3 ${CERRADO_INFERIOR}`).catch(() => {});
  state.inferior_open = false;
  broadcast();
}

const GRAMOS_POR_RACION = 12; // 1 porción = 12 g

// Dosificación vía ESP32: comando serial "6 <raciones>". El firmware gira el
// dosificador hasta contar 1 pulso del FC-03 por ración (1 vuelta = 12 g).
function dispenseGrams(grams) {
  return new Promise(async (resolve) => {
    const raciones = Math.max(1, Math.round((grams || 0) / GRAMOS_POR_RACION));
    console.log(`[DOSIFICADOR] ${raciones} porciones (~${raciones * GRAMOS_POR_RACION}g) vía ESP32 (FC-03)`);
    try {
      const out = await esp32Cmd(`6 ${raciones}`, 60000);
      console.log(`[DOSIFICADOR] ${(out || '').trim().replace(/\n/g, ' | ')}`);
    } catch (e) {
      console.error('[DOSIFICADOR] Error ESP32:', e.message);
    } finally {
      resolve();
    }
  });
}

// El firmware no tiene comando de parada dedicado; "7 1 1" gira 1 ms y deja el
// servo en neutro (detener). Solo se usa al cerrar el servicio.
function stopDispenser() {
  esp32Cmd('7 1 1').catch(() => {});
}

// ─── Feeding sequence ─────────────────────────────────────────────
// ─── Cámara: consentimiento explícito y captura real ───────────────
// Explicit consent each controller boot; do not restore a persisted "on" state.
let cameraEnabled = false;
const activeCameraStreams = new Set();
const CAMERA_OFF_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#10151a"/><text x="320" y="175" font-family="Arial" font-size="26" fill="#5b6770" text-anchor="middle">Cámara desactivada</text><text x="320" y="205" font-family="Arial" font-size="16" fill="#3d464d" text-anchor="middle">Video en vivo oculto</text></svg>`;
async function getCameraState() {
  const detector = await fetchPresence('/status');
  if (!detector?.camera) cameraEnabled = false;
  return { enabled: cameraEnabled && detector?.camera === true, available: !!detector, monitoring: !!detector?.monitoring };
}
async function setCameraEnabled(on) {
  if (!on) {
    cameraEnabled = false;
    presClean.armed = false;
    presClean.departedAt = 0;
    for (const stream of activeCameraStreams) { stream.up.destroy(); stream.res.end(); }
    activeCameraStreams.clear();
  }
  const result = await fetchPresence(on ? '/camera/start' : '/camera/stop');
  if (!result || result.error || result.enabled !== !!on) {
    cameraEnabled = false;
    return { status: 'error', enabled: false, error: result?.error || 'No se pudo cambiar el estado de la cámara' };
  }
  cameraEnabled = !!on;
  return { status: 'ok', enabled: cameraEnabled };
}
// ─── Limpieza automática al retirarse la mascota ────────────────────
const presClean = {
  enabled: loadSetting('pres_clean_enabled', true),
  delay_min: loadSetting('pres_clean_delay_min', 1),
  armed: false,
  departedAt: 0,
  last_clean_at: 0,
};
const CLEAN_COOLDOWN_MS = 30 * 60000;

async function runFeedingSequence(portions = 12, humidify = false, source = 'manual') {
  if (state.sequence_running) {
    console.log('[SECUENCIA] Ignorada: ya hay una en curso');
    return;
  }
  state.sequence_running = true;
  state.sequence_success = false;
  state.sequence_step = 0;
  state.sequence_progress_pct = 0;
  broadcast();

  try {
    updateStep(0, 'Cerrando compuerta inferior...', 0);
    closeLowerDoor();
    await delay(2000);

    updateStep(1, 'Abriendo compuerta superior...', 11);
    openUpperDoor();
    await delay(2000);

    updateStep(2, `Dosificando ${portions}g...`, 22);
    await dispenseGrams(portions);
    await delay(2000);

    updateStep(3, 'Cerrando compuerta superior...', 33);
    closeUpperDoor();
    await delay(2000);

    if (humidify) {
      updateStep(4, 'Humedeciendo...', 44);
      setRelay(true);
      await delay(10000);
      setRelay(false);
    } else {
      updateStep(4, 'Saltando humidificacion...', 44);
    }
    await delay(2000);

    updateStep(5, 'Abriendo compuerta inferior...', 55);
    openLowerDoor();
    await delay(2000);

    updateStep(6, 'Cerrando compuerta inferior...', 66);
    closeLowerDoor();
    await delay(2000);

    // Retroceso breve de la faja para liberar/retirar el alimento servido
    updateStep(7, 'Retrocediendo faja...', 85);
    fajaRetorno();
    await delay(1500);
    fajaStop();

    state.sequence_success = true;
    updateStep(7, 'Comida servida', 100);
    addFeedLogEntry(portions, humidify, true, source);
    console.log(`[SECUENCIA] Completada: ${portions}g (origen=${source})`);
    armCleaning();
  } catch (e) {
    console.error('[SECUENCIA] Error:', e.message);
    state.sequence_success = false;
    addFeedLogEntry(portions, humidify, false, source);
  } finally {
    setTimeout(() => {
      state.sequence_running = false;
      state.sequence_step = 0;
      state.sequence_step_name = '';
      state.sequence_progress_pct = 0;
      broadcast();
    }, 3000);
  }
}

function updateStep(step, name, pct) {
  state.sequence_step = step;
  state.sequence_step_name = name;
  state.sequence_progress_pct = pct;
  broadcast();
  console.log(`  [Paso ${step}] ${name}`);
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Orígenes válidos de alimentación
const FEED_SOURCES = ['manual', 'horario', 'presencia'];

// ─── Feed log ──────────────────────────────────────────────────────
function addFeedLogEntry(portions, humidify, success, source = 'manual') {
  if (!FEED_SOURCES.includes(source)) source = 'manual';
  const entry = {
    date: new Date().toLocaleDateString('es-PE'),
    time: new Date().toLocaleTimeString('es-PE'),
    portions: portions + 'g',
    humidify: humidify ? 'Si' : 'No',
    status: success ? 'Completada' : 'Fallida',
    source,
  };
  feedLog.unshift(entry);
  if (feedLog.length > 100) feedLog.length = 100;

  try {
    db.prepare('INSERT INTO feed_log (date, time, portions, humidify, status, source) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.date, entry.time, entry.portions, entry.humidify, entry.status, entry.source);
  } catch (e) {
    console.error('[DB] Error guardando log:', e.message);
  }
}

// ─── Schedules ─────────────────────────────────────────────────────
function loadSchedules() {
  try {
    const rows = db.prepare('SELECT id, hour, minute, portions, humidify FROM schedules').all();
    return rows.map(r => ({ ...r, humidify: !!r.humidify }));
  } catch { return []; }
}
function saveSchedules(list) {
  db.exec('DELETE FROM schedules');
  const insert = db.prepare('INSERT INTO schedules (id, hour, minute, portions, humidify) VALUES (?, ?, ?, ?, ?)');
  const tx = db.transaction((items) => { for (const s of items) insert.run(s.id, s.hour, s.minute, s.portions, s.humidify ? 1 : 0); });
  tx(list);
}
// Claves de horarios ya disparados (id + fecha + hora), para no repetir
// dentro del mismo minuto aunque el tick corra varias veces.
const firedScheduleKeys = new Set();

function checkSchedules() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const dayKey = now.toISOString().slice(0, 10);
  let schedules;
  try {
    schedules = loadSchedules();
  } catch (e) {
    console.error('[HORARIO] Error cargando horarios:', e.message);
    return;
  }
  schedules.forEach((s) => {
    if (s.hour !== h || s.minute !== m) return;
    const key = `${s.id}@${dayKey} ${h}:${m}`;
    if (firedScheduleKeys.has(key)) return;
    firedScheduleKeys.add(key);
    // Limpiar claves viejas para no crecer sin límite
    if (firedScheduleKeys.size > 500) {
      const oldest = [...firedScheduleKeys].slice(0, firedScheduleKeys.size - 500);
      oldest.forEach((k) => firedScheduleKeys.delete(k));
    }
    if (state.sequence_running) {
      console.log(`[HORARIO] Omitido ${s.portions}g: secuencia ya en curso`);
      return;
    }
    console.log(`[HORARIO] Ejecutando: ${s.portions}g (humidify=${!!s.humidify})`);
    runFeedingSequence(s.portions, s.humidify, 'horario');
  });
}

// ─── WebSocket ─────────────────────────────────────────────────────
let wss;
function broadcast() {
  if (!wss) return;
  const msg = JSON.stringify({ type: 'status', data: state });
  wss.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
}

// ─── Express ───────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const auth = createAuth(db);
wss = new WebSocketServer({
  server,
  verifyClient: ({ req }, done) => {
    const session = auth.getSession(req);
    done(!!session, session ? 200 : 401, session ? undefined : 'Unauthorized');
  },
});

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// Autenticación. En el primer inicio, /login permite crear la cuenta administradora.
app.get('/login', (req, res) => {
  if (auth.getSession(req)) return res.redirect('/');
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/api/auth/status', auth.status);
app.post('/api/auth/setup', auth.setup);
app.post('/api/auth/login', auth.login);
app.post('/api/auth/logout', auth.logout);

// Todo lo demás (panel, cámara, WebSocket y controles) requiere sesión.
// Puente del agente en loopback (Bearer AGENT_LOCAL_TOKEN) para la nube central.
app.use((req, res, next) => {
  if (authorizeLocalAgent(req, process.env.AGENT_LOCAL_TOKEN)) return next();
  return auth.requireAuth(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  }
}));

// Door (PCA9685)
app.post('/door/:type', (req, res) => {
  const { type } = req.params;
  const { action } = req.body;
  if (!['upper', 'lower'].includes(type)) return res.json({ status: 'error', message: 'Tipo invalido' });
  const open = action === 'open';
  if (type === 'upper') { open ? openUpperDoor() : closeUpperDoor(); }
  else { open ? openLowerDoor() : closeLowerDoor(); }
  res.json({ status: 'ok' });
});
app.get('/door/:type', (req, res) => {
  if (req.params.type === 'upper') return res.json({ open: state.superior_open });
  if (req.params.type === 'lower') return res.json({ open: state.inferior_open });
  res.json({ status: 'error' });
});

// Dosifier
app.post('/dosifier/test', async (req, res) => {
  const grams = Number(req.body.grams) || 0;
  const raciones = Math.max(1, Math.round(grams / GRAMOS_POR_RACION));
  await dispenseGrams(raciones * GRAMOS_POR_RACION);
  res.json({ status: 'ok', raciones, grams: raciones * GRAMOS_POR_RACION });
});

// Giro por tiempo del dosificador vía ESP32 (comando 7). direction 1=horario / 0=antihorario.
app.post('/dosifier/time', async (req, res) => {
  const ms = Number(req.body.ms) || 0;
  const horario = String(req.body.direction) !== '0';
  if (ms <= 0) return res.status(400).json({ status: 'error', message: 'ms requerido' });
  try {
    const out = await esp32Cmd(`7 ${ms} ${horario ? 1 : 0}`, Math.min(ms, 10000) + 5000);
    res.json({ status: 'ok', ms, horario, respuesta: (out || '').trim() });
  } catch (e) {
    res.status(500).json({ status: 'error', message: 'ESP32: ' + e.message });
  }
});

// Tiempo ajustable para 12g (1 porcion) del dosificador
const DOSIFIER_MS_12G_DEFAULT = 516; // 12g = 120° * 4.3 ms/grado
let dosifierMs12g = loadSetting('dosifier_ms_12g', DOSIFIER_MS_12G_DEFAULT);
app.get('/dosifier/params', (req, res) => res.json({ ms_12g: dosifierMs12g }));
app.post('/dosifier/params', (req, res) => {
  const ms = Number(req.body?.ms_12g);
  if (!(ms >= 50 && ms <= 5000)) return res.status(400).json({ status: 'error', message: 'ms_12g entre 50 y 5000' });
  dosifierMs12g = Math.round(ms);
  saveSetting('dosifier_ms_12g', dosifierMs12g);
  res.json({ status: 'ok', ms_12g: dosifierMs12g });
});

// Feed
app.post('/feed', async (req, res) => {
  const { portions = 12, humidify = false } = req.body;
  let source = 'manual';

  // Verificar presencia si está activado
  if (presenceState.feed_only_with_presence) {
    const presence = await fetchPresence('/status');
    if (!cameraEnabled || !presence || !presence.monitoring || presence.stale || !presence.presence_confirmed) {
      return res.json({ status: 'rejected', message: 'No se detectó mascota cerca' });
    }
    source = 'presencia';
  }

  runFeedingSequence(portions, humidify, source);
  res.json({ status: 'started', source });
});

// Humidifier
app.post('/humidify', (req, res) => {
  setRelay(!!req.body.on);
  broadcast();
  res.json({ status: 'ok' });
});
app.get('/humidify', (req, res) => res.json({ humidifier_on: state.humidifier_on }));

// Sequence status
app.get('/sequence_status', (req, res) => res.json({
  is_running: state.sequence_running,
  success: state.sequence_success,
  step: state.sequence_step,
  total_steps: 7,
  step_name: state.sequence_step_name,
  progress_pct: state.sequence_progress_pct,
}));

// Video en vivo: proxy del stream MJPEG fluido del detector
app.get('/video_feed', (req, res) => {
  if (!cameraEnabled) {
    res.set('Content-Type', 'image/svg+xml');
    res.send(CAMERA_OFF_SVG);
    return;
  }
  const up = http.get('http://127.0.0.1:5001/video_stream', (pres) => {
    if (pres.statusCode !== 200) {
      res.status(503).send('Camara no conectada');
      return;
    }
    res.set('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    res.set('Cache-Control', 'no-cache');
    pres.pipe(res);
  });
  const stream = { up, res };
  activeCameraStreams.add(stream);
  up.on('error', () => { try { res.status(503).send('Camara no conectada'); } catch { /* ya respondido */ } });
  res.on('close', () => { activeCameraStreams.delete(stream); try { up.destroy(); } catch { /* ignorar */ } });
});

app.get('/api/camera', async (req, res) => res.json(await getCameraState()));
app.post('/api/camera', async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') return res.status(400).json({ status: 'error', message: 'enabled requerido' });
  const result = await setCameraEnabled(enabled);
  res.status(result.error ? 503 : 200).json(result);
});

// Last feed
app.get('/api/last-feed', (req, res) => {
  try {
    const row = db.prepare('SELECT portions, humidify FROM last_feed WHERE id = 1').get();
    res.json(row || { portions: 12, humidify: false });
  } catch { res.json({ portions: 12, humidify: false }); }
});
app.post('/api/last-feed', (req, res) => {
  try {
    const { portions = 12, humidify = false } = req.body;
    db.prepare('INSERT OR REPLACE INTO last_feed (id, portions, humidify) VALUES (1, ?, ?)').run(portions, humidify ? 1 : 0);
    res.json({ status: 'ok' });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// Faja: prueba con dirección, tiempo y PWM configurables
app.post('/faja/test', async (req, res) => {
  const { direction, duration_ms, duty_a, duty_b } = req.body || {};
  if (!['forward', 'backward'].includes(direction)) {
    return res.status(400).json({ status: 'error', message: 'direction: forward | backward' });
  }
  const result = await fajaTest({ direction, duration_ms, duty_a, duty_b });
  res.json({ status: 'ok', ...result });
});
app.post('/faja/stop', (req, res) => { fajaStop(); res.json({ status: 'ok' }); });
app.get('/faja/busy', (req, res) => res.json({ busy: fajaBusy() }));

// Schedules
app.get('/schedules', (req, res) => res.json(loadSchedules()));
app.post('/schedules', (req, res) => {
  const { time, portions = 12, humidify = false } = req.body;
  const [hour, minute] = time.split(':').map(Number);
  const id = Date.now().toString(36);
  try {
    db.prepare('INSERT INTO schedules (id, hour, minute, portions, humidify) VALUES (?, ?, ?, ?, ?)')
      .run(id, hour, minute, portions, humidify ? 1 : 0);
    res.json({ id, hour, minute, portions, humidify });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});
app.delete('/schedules/:id', (req, res) => {
  db.prepare('DELETE FROM schedules WHERE id = ?').run(req.params.id);
  res.json({ status: 'ok' });
});

// Hora del servidor (para verificar zona horaria vs horarios)
app.get('/api/server-time', (req, res) => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  res.json({
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    date: now.toLocaleDateString('es-PE'),
    timezone_offset_min: now.getTimezoneOffset()
  });
});

// Feed log
app.get('/api/feed-log', (req, res) => {
  try {
    const rows = db.prepare("SELECT date, time, portions, humidify, status, COALESCE(source, 'manual') AS source FROM feed_log ORDER BY id DESC LIMIT 50").all();
    res.json(rows);
  } catch { res.json([]); }
});

// ─── Consumo (estadísticas para el dueño) ──────────────────────────
function getLocalDayKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

app.get('/api/consumption', (req, res) => {
  const today = new Date();
  const todayKey = getLocalDayKey(today);

  // Últimos 7 días (incluyendo hoy), con ceros
  const days = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    days[getLocalDayKey(d)] = { date: getLocalDayKey(d), feeds: 0, grams: 0, humidified: 0 };
  }

  try {
    const rows = db.prepare("SELECT portions, humidify, created_at FROM feed_log WHERE status = 'Completada' ORDER BY created_at DESC LIMIT 500").all();
    rows.forEach((r) => {
      const key = String(r.created_at || '').slice(0, 10);
      if (!days[key]) return;
      const grams = parseInt(String(r.portions).replace('g', ''), 10) || 0;
      days[key].feeds += 1;
      days[key].grams += grams;
      if (r.humidify === 'Si') days[key].humidified += 1;
    });
  } catch (e) { console.error('[DB] Consumo:', e.message); }

  const last7 = Object.values(days);
  const todayStats = days[todayKey] || { feeds: 0, grams: 0, humidified: 0 };
  const weekGrams = last7.reduce((s, d) => s + d.grams, 0);

  // Próxima comida programada (si existe en horarios)
  let next = null;
  try {
    const scheds = db.prepare('SELECT hour, minute, portions FROM schedules').all();
    if (scheds.length) {
      const nowMin = today.getHours() * 60 + today.getMinutes();
      const inMin = scheds.map((s) => s.hour * 60 + s.minute).filter((m) => m > nowMin).sort((a, b) => a - b);
      const nextMin = inMin.length ? inMin[0] : Math.min(...scheds.map((s) => s.hour * 60 + s.minute));
      const s = scheds.find((s) => s.hour * 60 + s.minute === nextMin);
      next = {
        hh: String(s.hour).padStart(2, '0'),
        mm: String(s.minute).padStart(2, '0'),
        grams: s.portions,
      };
    }
  } catch {}

  res.json({
    today: { date: todayKey, ...todayStats },
    last7,
    average_7d: Math.round(weekGrams / 7),
    next_schedule: next,
    goal_grams: loadSetting('daily_grams_goal', 0),
  });
});

// Meta diaria de consumo (gramos)
app.post('/api/consumption/goal', (req, res) => {
  let grams = parseInt(req.body.grams, 10) || 0;
  if (grams < 0) grams = 0;
  if (grams > 1000) grams = 1000;
  saveSetting('daily_grams_goal', grams);
  res.json({ status: 'ok', grams });
});

// ─── Presence Detection (proxy a Python detector) ──────────────────
const PRESENCE_URL = 'http://127.0.0.1:5001';
const presenceState = {
  enabled: false,
  feed_only_with_presence: loadSetting('feed_only_with_presence', false),
};
// Alimentación automática al detectar presencia (activa por defecto)
const presenceAutoFeed = {
  enabled: loadSetting('presence_auto_feed_enabled', true),
  cooldown_min: loadSetting('presence_auto_feed_cooldown_min', 10),
  last_fire_at: 0,
};

function fetchPresence(path) {
  return new Promise((resolve) => {
    const req = http.get(PRESENCE_URL + path, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
    req.setTimeout(path === '/start' ? 5000 : 2000, () => { req.destroy(); resolve(null); });
  });
}

// Verifica cada 5s si hay mascota confirmada -> dispara secuencia
let lastCooldownLogAt = 0;
async function checkPresenceFeed() {
  if (!presenceAutoFeed.enabled) return;
  if (state.sequence_running) return;
  const now = Date.now();
  const cooldownLeft = now - presenceAutoFeed.last_fire_at;
  if (cooldownLeft < presenceAutoFeed.cooldown_min * 60000) {
    const status = await fetchPresence('/status');
    if (status && status.presence_confirmed && now - lastCooldownLogAt > 30000) {
      const remain = Math.ceil((presenceAutoFeed.cooldown_min * 60000 - cooldownLeft) / 60000);
      console.log(`[PRESENCIA] Mascota detectada pero auto-alimentación en cooldown (faltan ${remain} min)`);
      lastCooldownLogAt = now;
    }
    return;
  }
  const status = await fetchPresence('/status');
  if (!cameraEnabled || !status || !status.monitoring || !status.automation_allowed || status.stale || !status.presence_confirmed) return;
  presenceAutoFeed.last_fire_at = now;
  let portions = 12, humidify = false;
  try {
    const row = db.prepare('SELECT portions, humidify FROM last_feed WHERE id = 1').get();
    if (row) { portions = row.portions; humidify = !!row.humidify; }
  } catch {}
  console.log(`[PRESENCIA] Mascota detectada -> alimentación automática ${portions}g`);
  runFeedingSequence(portions, humidify, 'presencia');
}

// Tras una comida exitosa, se espera a que la mascota se retire
function armCleaning() {
  if (!presClean.enabled) return;
  presClean.armed = true;
  presClean.departedAt = 0;
  console.log('[LIMPIEZA] Armada: se limpiará cuando la mascota se retire');
}

// Ciclo de limpieza de faja transportadora (L298N): adelante con M1, retorno con M2
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

// Verifica cada 5s: mascota retirada (+ espera) -> ejecuta limpieza
async function checkPresenceClean() {
  if (!presClean.enabled || !presClean.armed) return;
  if (state.sequence_running || state.cleaning) return;
  const now = Date.now();
  const status = await fetchPresence('/status');
  if (!cameraEnabled || !status || !status.monitoring || !status.automation_allowed || status.stale) return;
  if (status.presence_confirmed) {
    presClean.departedAt = 0;
    return;
  }
  if (!presClean.departedAt) presClean.departedAt = now;
  if (now - presClean.departedAt < presClean.delay_min * 60000) return;
  presClean.armed = false;
  presClean.departedAt = 0;
  if (now - presClean.last_clean_at < CLEAN_COOLDOWN_MS) {
    console.log('[LIMPIEZA] Omitida: cooldown de 30 min activo');
    return;
  }
  presClean.last_clean_at = now;
  await runCleaning();
}

app.get('/api/presence', async (req, res) => {
  const status = await fetchPresence('/status');
  if (!status) return res.json({ camera: false, monitoring: false, detected: false });
  let auto_feed_remaining_s = 0;
  if (presenceAutoFeed.enabled) {
    const waited = Date.now() - presenceAutoFeed.last_fire_at;
    auto_feed_remaining_s = Math.max(0, Math.ceil((presenceAutoFeed.cooldown_min * 60000 - waited) / 1000));
  }
  res.json({
    camera: cameraEnabled && status.camera,
    monitoring: status.monitoring,
    detected: status.presence_confirmed,
    presence_seconds: status.presence_seconds,
    threshold: status.presence_threshold,
    last_detection: status.last_detection,
    observation_only: status.observation_only !== false,
    detector_error: status.detector_error || null,
    cat_detected: !!status.cat_detected,
    stale: !!status.stale,
    auto_feed_enabled: presenceAutoFeed.enabled,
    auto_feed_remaining_s
  });
});

app.post('/api/presence/start', async (req, res) => {
  if (!cameraEnabled) return res.status(409).json({ error: 'Primero enciende la cámara' });
  const result = await fetchPresence('/start');
  presenceState.enabled = true;
  res.json(result || { error: 'Detector no disponible' });
});

app.post('/api/presence/stop', async (req, res) => {
  const result = await fetchPresence('/stop');
  presenceState.enabled = false;
  res.json(result || { error: 'Detector no disponible' });
});

app.post('/api/presence/threshold', (req, res) => {
  const { seconds } = req.body;
  if (!seconds || seconds < 1 || seconds > 120) {
    return res.status(400).json({ error: 'Valor debe ser entre 1 y 120' });
  }
  fetchPresence('/threshold/' + seconds).then((result) => {
    res.json(result || { error: 'Detector no disponible' });
  });
});

app.post('/api/presence/feed-only', (req, res) => {
  presenceState.feed_only_with_presence = !!req.body.enabled;
  saveSetting('feed_only_with_presence', presenceState.feed_only_with_presence);
  res.json({ feed_only_with_presence: presenceState.feed_only_with_presence });
});



app.get('/api/presence/feed-only', (req, res) => {
  res.json({ feed_only_with_presence: presenceState.feed_only_with_presence });
});

// Alimentación automática al detectar mascota
app.get('/api/presence/auto-feed', (req, res) => {
  res.json({ enabled: presenceAutoFeed.enabled, cooldown_min: presenceAutoFeed.cooldown_min });
});

app.post('/api/presence/auto-feed', (req, res) => {
  const enabled = !!req.body.enabled;
  let cooldown = parseInt(req.body.cooldown_min, 10) || presenceAutoFeed.cooldown_min;
  if (cooldown < 1 || cooldown > 120) cooldown = 10;
  presenceAutoFeed.enabled = enabled;
  presenceAutoFeed.cooldown_min = cooldown;
  saveSetting('presence_auto_feed_enabled', enabled);
  saveSetting('presence_auto_feed_cooldown_min', cooldown);
  if (enabled) presenceAutoFeed.last_fire_at = 0;
  console.log(`[PRESENCIA] Auto-alimentación: ${enabled ? 'ACTIVADA (espera ' + cooldown + ' min)' : 'desactivada'}`);
  res.json({ status: 'ok', enabled, cooldown_min: cooldown });
});

// Limpieza automática de faja al retirarse la mascota
app.get('/api/presence/clean', (req, res) => {
  res.json({ enabled: presClean.enabled, delay_min: presClean.delay_min });
});

app.post('/api/presence/clean', (req, res) => {
  const enabled = !!req.body.enabled;
  let delay = parseInt(req.body.delay_min, 10);
  if (isNaN(delay) || delay < 0) delay = 0;
  if (delay > 120) delay = 120;
  presClean.enabled = enabled;
  presClean.delay_min = delay;
  saveSetting('pres_clean_enabled', enabled);
  saveSetting('pres_clean_delay_min', delay);
  if (!enabled) { presClean.armed = false; presClean.departedAt = 0; }
  console.log(`[LIMPIEZA] Limpieza al retirarse: ${enabled ? 'ACTIVADA (espera ' + delay + ' min)' : 'desactivada'}`);
  res.json({ status: 'ok', enabled, delay_min: delay });
});

// ─── Gestor WiFi (nmcli) ────────────────────────────────────────────
function runCmd(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function splitNmFields(line) {
  return line.split(/(?<!\\):/).map((f) => f.replace(/\\:/g, ':'));
}

function parseNmcliWifi(out) {
  const map = {};
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const fields = splitNmFields(line);
    const inuse = fields[0] === '*';
    const ssid = fields[1];
    const signal = parseInt(fields[2], 10) || 0;
    const security = fields[3] ? fields[3].trim() : '';
    if (!ssid) continue;
    if (!map[ssid] || map[ssid].signal < signal) {
      map[ssid] = { ssid, signal, security: security || 'abierta', inuse };
    }
  }
  return Object.values(map).sort((a, b) => b.signal - a.signal);
}

app.get('/api/wifi', async (req, res) => {
  const list = await runCmd('nmcli', ['-t', '-f', 'IN-USE,SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list']);
  const networks = list.ok ? parseNmcliWifi(list.stdout) : [];
  const savedR = await runCmd('nmcli', ['-t', '-f', 'NAME,TYPE', 'con', 'show']);
  const saved = savedR.ok
    ? savedR.stdout.split('\n').map(splitNmFields).filter((a) => a[1] === '802-11-wireless').map((a) => a[0])
    : [];
  const activeR = await runCmd('nmcli', ['-t', '-f', 'NAME,TYPE', 'con', 'show', '--active']);
  let active_ssid = null;
  if (activeR.ok) {
    const row = activeR.stdout.split('\n').map(splitNmFields).find((a) => a[1] === '802-11-wireless');
    if (row) active_ssid = row[0];
  }
  res.json({ wifi_on: list.ok, networks, saved, active_ssid });
});

app.post('/api/wifi/connect', (req, res) => {
  const { ssid, password } = req.body || {};
  if (!ssid) return res.status(400).json({ error: 'Falta el nombre de la red' });
  const s = String(ssid);
  const pwd = password ? String(password) : null;
  const doConnect = (r) => {
    console.log(`[WIFI] Conectando a ${s}: ${r.ok ? 'OK' : r.stderr.trim() || 'fallo'}`);
    if (!r.ok) console.log('[WIFI] ' + (r.stdout || '').trim());
  };
  runCmd('nmcli', ['-t', '-f', 'NAME,TYPE', 'con', 'show']).then((savedR) => {
    const savedNames = savedR.ok
      ? savedR.stdout.split('\n').map(splitNmFields).filter((a) => a[1] === '802-11-wireless').map((a) => a[0])
      : [];
    if (savedNames.includes(s)) {
      runCmd('nmcli', ['connection', 'up', s]).then(doConnect);
    } else if (pwd) {
      runCmd('nmcli', ['device', 'wifi', 'connect', s, 'password', pwd]).then(doConnect);
    } else {
      res.status(400).json({ error: 'Red no guardada: se necesita la contraseña' });
      return;
    }
    res.json({ status: 'connecting', ssid: s });
  });
});

// WebSocket
wss.on('connection', (ws) => {
  console.log('[WS] Cliente conectado');
  ws.send(JSON.stringify({ type: 'status', data: state }));
  ws.on('close', () => console.log('[WS] Cliente desconectado'));
});

// ─── Start ─────────────────────────────────────────────────────────
console.log('=== SmartPetFeeder v2.1 (Node.js + ESP32 + lgpio) ===');

const gpioOk = gpioInit();

setInterval(checkSchedules, 15000);
checkSchedules();
setInterval(checkPresenceFeed, 5000);
checkPresenceFeed();
setInterval(checkPresenceClean, 5000);
checkPresenceClean();
setInterval(auth.cleanupSessions, 60 * 60 * 1000);
auth.cleanupSessions();

// A controller restart also revokes consent if the camera service stayed up.
setCameraEnabled(false).finally(() => server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor: http://localhost:${PORT}`);
  console.log(`Red:      http://192.168.0.251:${PORT}`);
  console.log(`GPIO: ${gpioOk ? 'OK' : 'FALLIDO'}`);
}));

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
