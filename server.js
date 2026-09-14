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
    source TEXT DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now','localtime'))
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
async function runFeedingSequence(portions = 18, humidify = false, source = 'manual') {
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

    state.sequence_success = true;
    updateStep(7, 'Comida servida', 100);
    addFeedLogEntry(portions, humidify, true, source);
    console.log(`[SECUENCIA] Completada: ${portions}g (origen=${source})`);
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
  let source = 'manual';

  // Verificar presencia si está activado
  if (presenceState.feed_only_with_presence) {
    const presence = await fetchPresence('/status');
    if (!presence || !presence.presence_confirmed) {
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

// Video en vivo: snapshot de la fuente actual del detector
app.get('/video_feed', (req, res) => {
  http.get('http://127.0.0.1:5001/snapshot', (pres) => {
    if (pres.statusCode !== 200) {
      res.status(503).send('Camara no conectada');
      return;
    }
    res.set('Content-Type', 'image/jpeg');
    pres.pipe(res);
  }).on('error', () => res.status(503).send('Camara no conectada'));
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
    last_detection: status.last_detection,
    source: status.source,
    source_label: status.source_label,
    test_mode: status.test_mode
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

// ─── Cámara: fuentes configurables + subida de foto ────────────────
function postPresenceJSON(path, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const r = http.request({
      host: '127.0.0.1', port: 5001, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: null }); } });
    });
    r.on('error', () => resolve(null));
    r.write(body);
    r.end();
  });
}

app.get('/api/camera/sources', async (req, res) => {
  const result = await fetchPresence('/camera/sources');
  res.json(result || { error: 'Detector no disponible' });
});

app.post('/api/camera/source', async (req, res) => {
  const result = await postPresenceJSON('/camera/source', req.body || {});
  if (!result) return res.status(503).json({ error: 'Detector no disponible' });
  res.status(result.status).json(result.body);
});

// Subida de foto de prueba: reenvía el multipart tal cual al detector
app.post('/api/camera/upload', (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const r = http.request({
      host: '127.0.0.1', port: 5001, path: '/camera/upload', method: 'POST',
      headers: { 'Content-Type': req.headers['content-type'] || 'application/octet-stream', 'Content-Length': body.length }
    }, (pres) => {
      let data = '';
      pres.on('data', (c) => { data += c; });
      pres.on('end', () => {
        res.status(pres.statusCode);
        try { res.json(JSON.parse(data)); } catch { res.send(data); }
      });
    });
    r.on('error', () => res.status(503).json({ error: 'Detector no disponible' }));
    r.write(body);
    r.end();
  });
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

setInterval(checkSchedules, 15000);
checkSchedules();

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