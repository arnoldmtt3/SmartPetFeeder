#!/usr/bin/env node
/**
 * SmartPetFeeder - Node.js Server v2.1
 * Controla actuadores via PCA9685 (I2C) y GPIO - todo con lgpio.
 * Sirve la interfaz web y maneja WebSocket para tiempo real.
 *
 * Hardware:
 *   PCA9685 (I2C 0x40, bus 1):
 *     Canal 0  -> Servo compuerta superior (posicional)
 *     Canal 1  -> Servo dosificador (rotacion continua)
 *     Canal 2  -> Servo compuerta inferior (posicional)
 *   GPIO 5 -> Rele humidificador
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const lgpio = require('lgpio');
const Database = require('better-sqlite3');

// ─── Config ────────────────────────────────────────────────────────
const PORT = 3000;
const I2C_ADDR = 0x40;
const I2C_BUS = 1;
const RELAY_PIN = 5;

// PCA9685 registers
const MODE1 = 0x00;
const PRESCALE = 0xFE;
const LED0_ON_L = 0x06;

// Servo channels
const CH_SUPERIOR = 0;
const CH_DOSIFICADOR = 1;
const CH_INFERIOR = 2;

// Movement constants
const GRAMOS_POR_REV = 9;
const TIEMPO_POR_REV = 1.548;
const ABIERTO = 0;
const CERRADO = 180;

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
    portions INTEGER DEFAULT 18,
    humidify INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS last_feed (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    portions INTEGER DEFAULT 18,
    humidify INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS feed_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    time TEXT,
    portions TEXT,
    humidify TEXT,
    status TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

const feedLog = [];

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

function setThrottle(channel, throttle) {
  const pulseMs = 1.5 + throttle * 0.5;
  setPulse(channel, pulseMs);
}

// ─── GPIO relay ───────────────────────────────────────────────────
function gpioInit() {
  try {
    if (!gpioHandle) gpioHandle = lgpio.gpiochipOpen(0);
    lgpio.gpioClaimOutput(gpioHandle, RELAY_PIN, 0);
    console.log('[GPIO] Rele en GPIO' + RELAY_PIN);
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

// ─── Actuators ─────────────────────────────────────────────────────
function openUpperDoor() {
  setAngle(CH_SUPERIOR, ABIERTO);
  state.superior_open = true;
  broadcast();
}

function closeUpperDoor() {
  setAngle(CH_SUPERIOR, CERRADO);
  state.superior_open = false;
  broadcast();
}

function openLowerDoor() {
  setAngle(CH_INFERIOR, ABIERTO);
  state.inferior_open = true;
  broadcast();
}

function closeLowerDoor() {
  setAngle(CH_INFERIOR, CERRADO);
  state.inferior_open = false;
  broadcast();
}

function dispenseGrams(grams) {
  return new Promise((resolve) => {
    const revolutions = grams / GRAMOS_POR_REV;
    const seconds = Math.abs(revolutions * TIEMPO_POR_REV);
    const reverse = revolutions < 0;
    setThrottle(CH_DOSIFICADOR, reverse ? -1.0 : 1.0);
    setTimeout(() => {
      setThrottle(CH_DOSIFICADOR, 0);
      resolve();
    }, seconds * 1000);
  });
}

function stopDispenser() {
  setThrottle(CH_DOSIFICADOR, 0);
}

// ─── Feeding sequence ─────────────────────────────────────────────
async function runFeedingSequence(portions = 18, humidify = false) {
  if (state.sequence_running) return;
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

    state.sequence_success = true;
    updateStep(7, 'Comida servida', 100);
    addFeedLogEntry(portions, humidify, true);
    console.log(`[SECUENCIA] Completada: ${portions}g`);
  } catch (e) {
    console.error('[SECUENCIA] Error:', e.message);
    state.sequence_success = false;
    addFeedLogEntry(portions, humidify, false);
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

// ─── Feed log ──────────────────────────────────────────────────────
function addFeedLogEntry(portions, humidify, success) {
  const entry = {
    date: new Date().toLocaleDateString('es-PE'),
    time: new Date().toLocaleTimeString('es-PE'),
    portions: portions + 'g',
    humidify: humidify ? 'Si' : 'No',
    status: success ? 'Completada' : 'Fallida',
  };
  feedLog.unshift(entry);
  if (feedLog.length > 100) feedLog.length = 100;

  try {
    db.prepare('INSERT INTO feed_log (date, time, portions, humidify, status) VALUES (?, ?, ?, ?, ?)')
      .run(entry.date, entry.time, entry.portions, entry.humidify, entry.status);
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
function checkSchedules() {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  const schedules = loadSchedules();
  let changed = false;
  schedules.forEach((s) => {
    if (s.hour === h && s.minute === m && !s._fired) {
      s._fired = true;
      changed = true;
      console.log(`[HORARIO] Ejecutando: ${s.portions}g`);
      runFeedingSequence(s.portions, s.humidify);
    }
    if (s.minute !== m) s._fired = false;
  });
  if (changed) saveSchedules(schedules);
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
wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Door
app.post('/door/:type', (req, res) => {
  const { type } = req.params;
  const { action } = req.body;
  if (!['upper', 'lower'].includes(type)) return res.json({ status: 'error', message: 'Tipo invalido' });
  if (type === 'upper') action === 'open' ? openUpperDoor() : closeUpperDoor();
  else action === 'open' ? openLowerDoor() : closeLowerDoor();
  res.json({ status: 'ok' });
});
app.get('/door/:type', (req, res) => {
  if (req.params.type === 'upper') return res.json({ open: state.superior_open });
  if (req.params.type === 'lower') return res.json({ open: state.inferior_open });
  res.json({ status: 'error' });
});

// Dosifier
app.post('/dosifier/test', (req, res) => {
  dispenseGrams(req.body.grams || 9);
  res.json({ status: 'started' });
});

// Feed
app.post('/feed', async (req, res) => {
  const { portions = 18, humidify = false } = req.body;

  // Verificar presencia si está activado
  if (presenceState.feed_only_with_presence) {
    const presence = await fetchPresence('/status');
    if (!presence || !presence.presence_confirmed) {
      return res.json({ status: 'rejected', message: 'No se detectó mascota cerca' });
    }
  }

  runFeedingSequence(portions, humidify);
  res.json({ status: 'started' });
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

// Video feed - genera imagen de prueba cuando no hay cámara
const { execSync } = require('child_process');

app.get('/video_feed', async (req, res) => {
  try {
    // Consultar estado de presencia
    const presence = await new Promise((resolve) => {
      http.get('http://127.0.0.1:5001/status', (r) => {
        let d = '';
        r.on('data', (c) => { d += c; });
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    });

    // Generar imagen con script Python separado
    const pythonScript = path.join(__dirname, 'generate_video.py');
    const result = execSync(`echo '${JSON.stringify(presence || {})}' | python3 ${pythonScript}`, {
      timeout: 10000,
      maxBuffer: 1024 * 1024
    });

    res.set('Content-Type', 'image/jpeg');
    res.send(result);
  } catch (e) {
    res.status(503).send('Error generando video');
  }
});

// Last feed
app.get('/api/last-feed', (req, res) => {
  try {
    const row = db.prepare('SELECT portions, humidify FROM last_feed WHERE id = 1').get();
    res.json(row || { portions: 18, humidify: false });
  } catch { res.json({ portions: 18, humidify: false }); }
});
app.post('/api/last-feed', (req, res) => {
  try {
    const { portions = 18, humidify = false } = req.body;
    db.prepare('INSERT OR REPLACE INTO last_feed (id, portions, humidify) VALUES (1, ?, ?)').run(portions, humidify ? 1 : 0);
    res.json({ status: 'ok' });
  } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// Faja (stubs)
app.post('/faja/manual', (req, res) => res.json({ status: 'ok' }));
app.post('/faja/stop', (req, res) => res.json({ status: 'ok' }));
app.post('/faja/setup', (req, res) => res.json({ status: 'ok', message: 'Pendiente' }));
app.post('/faja/cycle', (req, res) => res.json({ status: 'ok', message: 'Pendiente' }));
app.get('/faja/busy', (req, res) => res.json({ busy: false }));
app.get('/faja/params', (req, res) => res.json({ pulsos_seteo_m2: 1800, pulsos_avance: 600, pulsos_retorno: 1700 }));
app.post('/faja/params', (req, res) => res.json({ status: 'ok', updated: req.body }));
app.get('/faja/status', (req, res) => res.json({ encoder_m1: 0, encoder_m2: 0 }));
app.post('/faja/reset-encoders', (req, res) => res.json({ status: 'ok' }));

// Schedules
app.get('/schedules', (req, res) => res.json(loadSchedules()));
app.post('/schedules', (req, res) => {
  const { time, portions = 18, humidify = false } = req.body;
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

// Feed log
app.get('/api/feed-log', (req, res) => {
  try {
    const rows = db.prepare('SELECT date, time, portions, humidify, status FROM feed_log ORDER BY id DESC LIMIT 50').all();
    res.json(rows);
  } catch { res.json([]); }
});

// ─── Presence Detection (proxy a Python detector) ──────────────────
const PRESENCE_URL = 'http://127.0.0.1:5001';
const presenceState = { enabled: false, feed_only_with_presence: false };

function fetchPresence(path) {
  return new Promise((resolve) => {
    http.get(PRESENCE_URL + path, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

app.get('/api/presence', async (req, res) => {
  const status = await fetchPresence('/status');
  if (!status) return res.json({ camera: false, monitoring: false, detected: false });
  res.json({
    camera: status.camera,
    monitoring: status.monitoring,
    detected: status.presence_confirmed,
    presence_seconds: status.presence_seconds,
    threshold: status.presence_threshold,
    last_detection: status.last_detection
  });
});

app.post('/api/presence/start', async (req, res) => {
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
  res.json({ feed_only_with_presence: presenceState.feed_only_with_presence });
});

app.get('/api/presence/feed-only', (req, res) => {
  res.json({ feed_only_with_presence: presenceState.feed_only_with_presence });
});

// WebSocket
wss.on('connection', (ws) => {
  console.log('[WS] Cliente conectado');
  ws.send(JSON.stringify({ type: 'status', data: state }));
  ws.on('close', () => console.log('[WS] Cliente desconectado'));
});

// ─── Start ─────────────────────────────────────────────────────────
console.log('=== SmartPetFeeder v2.1 (Node.js + PCA9685 + lgpio) ===');

const i2cOk = pca9685Init();
const gpioOk = gpioInit();

if (i2cOk) {
  setAngle(CH_SUPERIOR, ABIERTO);
  setAngle(CH_INFERIOR, CERRADO);
  setThrottle(CH_DOSIFICADOR, 0);
} else {
  console.log('[WARN] PCA9685 no detectado - servos deshabilitados');
}

setInterval(checkSchedules, 60000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor: http://localhost:${PORT}`);
  console.log(`Red:      http://192.168.0.251:${PORT}`);
  console.log(`I2C:  ${i2cOk ? 'OK' : 'FALLIDO'}`);
  console.log(`GPIO: ${gpioOk ? 'OK' : 'FALLIDO'}`);
});

process.on('SIGINT', () => {
  console.log('\n[Cierre] Limpiando...');
  setRelay(false);
  stopDispenser();
  if (i2cReady && i2cHandle !== null) lgpio.i2cClose(i2cHandle);
  if (gpioHandle) lgpio.gpiochipClose(gpioHandle);
  process.exit(0);
});

process.on('SIGTERM', () => {
  setRelay(false);
  stopDispenser();
  process.exit(0);
});