const crypto = require('crypto');

const SESSION_COOKIE = 'smartpet_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    try { cookies[name] = decodeURIComponent(value); } catch { cookies[name] = value; }
  }
  return cookies;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function passwordMatches(password, salt, expectedHex) {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function validateCredentials(username, password) {
  const normalized = String(username || '').trim();
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(normalized)) {
    return { error: 'El usuario debe tener entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo.' };
  }
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    return { error: 'La contraseña debe tener entre 10 y 128 caracteres.' };
  }
  return { username: normalized, password };
}

function createAuth(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
  `);

  const failures = new Map();
  let setupCode = hasUsers() ? null : crypto.randomBytes(4).toString('hex').toUpperCase();
  if (setupCode) {
    console.log(`[AUTH] Código de configuración inicial: ${setupCode}`);
    console.log('[AUTH] Abre /login e ingresa este código para crear el administrador.');
  }

  function hasUsers() {
    return db.prepare('SELECT EXISTS(SELECT 1 FROM users) AS found').get().found === 1;
  }

  function isSecureRequest(req) {
    return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }

  function setSessionCookie(req, res, token) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isSecureRequest(req),
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_TTL_MS,
    });
  }

  function clearSessionCookie(req, res) {
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      secure: isSecureRequest(req),
      sameSite: 'strict',
      path: '/',
    });
  }

  function createSession(req, res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    const expiresAt = Date.now() + SESSION_TTL_MS;
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, userId, expiresAt);
    setSessionCookie(req, res, token);
  }

  function getSession(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const tokenHash = sha256(token);
    const session = db.prepare(`
      SELECT sessions.token_hash, sessions.expires_at, users.id AS user_id, users.username
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
    `).get(tokenHash);
    if (!session) return null;
    if (session.expires_at <= Date.now()) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    return session;
  }

  function requireAuth(req, res, next) {
    const session = getSession(req);
    if (session) {
      req.authUser = { id: session.user_id, username: session.username };
      req.authTokenHash = session.token_hash;
      return next();
    }
    const acceptsHtml = req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
    if (acceptsHtml) return res.redirect('/login');
    return res.status(401).json({ status: 'error', message: 'Debes iniciar sesión' });
  }

  function setup(req, res) {
    if (hasUsers()) return res.status(409).json({ status: 'error', message: 'La cuenta administradora ya fue creada' });
    const receivedCode = String(req.body?.setup_code || '').trim().toUpperCase();
    if (!setupCode || receivedCode !== setupCode) {
      return res.status(403).json({ status: 'error', message: 'Código de configuración incorrecto' });
    }
    const credentials = validateCredentials(req.body?.username, req.body?.password);
    if (credentials.error) return res.status(400).json({ status: 'error', message: credentials.error });

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(credentials.password, salt);
    try {
      const result = db.prepare('INSERT INTO users (username, password_hash, password_salt) VALUES (?, ?, ?)')
        .run(credentials.username, passwordHash, salt);
      setupCode = null;
      createSession(req, res, result.lastInsertRowid);
      return res.status(201).json({ status: 'ok', username: credentials.username });
    } catch (error) {
      console.error('[AUTH] Error creando usuario:', error.message);
      return res.status(500).json({ status: 'error', message: 'No se pudo crear la cuenta' });
    }
  }

  function loginKey(req) {
    return String(req.headers['cf-connecting-ip'] || req.ip || 'unknown');
  }

  function login(req, res) {
    if (!hasUsers()) return res.status(409).json({ status: 'setup_required', message: 'Primero crea la cuenta administradora' });
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const key = loginKey(req);
    const now = Date.now();
    let attempt = failures.get(key);
    if (!attempt || now - attempt.startedAt >= LOGIN_WINDOW_MS) {
      attempt = { count: 0, startedAt: now };
      failures.set(key, attempt);
    }
    if (attempt.count >= LOGIN_MAX_FAILURES) {
      return res.status(429).json({ status: 'error', message: 'Demasiados intentos. Espera 15 minutos.' });
    }

    const user = db.prepare('SELECT id, username, password_hash, password_salt FROM users WHERE username = ? COLLATE NOCASE')
      .get(username);
    const valid = user && passwordMatches(password, user.password_salt, user.password_hash);
    if (!valid) {
      attempt.count += 1;
      return res.status(401).json({ status: 'error', message: 'Usuario o contraseña incorrectos' });
    }

    failures.delete(key);
    createSession(req, res, user.id);
    return res.json({ status: 'ok', username: user.username });
  }

  function logout(req, res) {
    const session = getSession(req);
    if (session) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.token_hash);
    clearSessionCookie(req, res);
    return res.json({ status: 'ok' });
  }

  function status(req, res) {
    const session = getSession(req);
    return res.json({
      authenticated: !!session,
      setup_required: !hasUsers(),
      username: session ? session.username : null,
    });
  }

  function cleanupSessions() {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    const now = Date.now();
    for (const [key, attempt] of failures) {
      if (now - attempt.startedAt >= LOGIN_WINDOW_MS) failures.delete(key);
    }
  }

  return { cleanupSessions, getSession, login, logout, requireAuth, setup, status };
}

module.exports = { createAuth };
