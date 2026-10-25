// ============================================================================
// Order Management App - server.js
// Database: hosted SQLite (Turso / libSQL). No Nextcloud dependency —
// Nextcloud is only read once, on first start, to copy the old data over.
//
// Runs the same way locally (start.bat) and on a cloud host (Render).
// All secrets come from environment variables — see .env.example.
// ============================================================================

const path      = require('path');
const fs        = require('fs');

// ── Load .env (local runs only — cloud hosts inject env vars directly) ───
(function loadDotEnv() {
  const p = path.resolve(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

const express        = require('express');
const cookieSession  = require('cookie-session');
const multer         = require('multer');
const http           = require('http');
const https          = require('https');
const crypto         = require('crypto');
const { createClient } = require('@libsql/client');
const XLSX           = require('xlsx');
const bcrypt         = require('bcryptjs');

const pkg = require('./package.json');
const APP_VERSION = pkg.version || 'unknown';

const app     = express();
const PORT    = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// ── Database (Turso / libSQL) — from environment, never hardcoded ─────────
//   TURSO_DATABASE_URL   libsql://<db>-<org>.turso.io   (or file:Order_App.db
//                        to use a plain local SQLite file, e.g. offline)
//   TURSO_AUTH_TOKEN     database token from the Turso dashboard
const DB_URL   = (process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || '').trim();
const DB_TOKEN = (process.env.TURSO_AUTH_TOKEN || '').trim();

if (!DB_URL) {
  console.error('\n  Missing required setting: TURSO_DATABASE_URL');
  console.error('  → Locally: copy .env.example to .env and fill it in.');
  console.error('  → On Render: add it under the service\'s Environment tab.\n');
  process.exit(1);
}
if (!DB_TOKEN && !DB_URL.startsWith('file:') && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(DB_URL)) {
  console.error('\n  Missing required setting: TURSO_AUTH_TOKEN (create one in the Turso dashboard)\n');
  process.exit(1);
}
const DB_LABEL = DB_URL.startsWith('file:') ? 'local file' : (() => {
  try { return new URL(DB_URL.replace(/^libsql:/, 'https:')).hostname; } catch (e) { return 'database'; }
})();

// ── One-time import sources (optional; only used while the DB is empty) ──
// Copies the existing Order_App.db into the new database on first start.
//   IMPORT_DB_FILE                     path to a local .db file, or
//   NC_HOST + NC_TOKEN + NC_PASSWORD   the old Nextcloud share
// After the first successful start these are ignored and can be removed.
const IMPORT_DB_FILE = (process.env.IMPORT_DB_FILE || '').trim();
const NC_HOST        = (process.env.NC_HOST || '').trim();
const NC_TOKEN       = (process.env.NC_TOKEN || '').trim();
const NC_PASSWORD    = process.env.NC_PASSWORD || '';
const NC_FILENAME    = process.env.DB_FILENAME || 'Order_App.db';
// Start with an empty database instead of importing (new installs only).
const INIT_EMPTY_DB  = /^(1|yes|true)$/i.test(process.env.INIT_EMPTY_DB || '');

// Session signing key. On Render this is generated once and kept, so
// logins survive restarts / spin-downs. Locally a random one is fine.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET && IS_PROD)
  console.warn('  ⚠ SESSION_SECRET not set — everyone will be logged out on every restart.');
// ─────────────────────────────────────────────────────────────────────────

const UPLOAD_DIR = path.resolve(__dirname, 'uploads');
const DRAFTS_DIR = path.resolve(__dirname, 'drafts');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DRAFTS_DIR)) fs.mkdirSync(DRAFTS_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 25 * 1024 * 1024 } });

// ════════════════════════════════════════════════════════════════════════
// DATABASE ACCESS
// ════════════════════════════════════════════════════════════════════════
// Every read is a query against the hosted database (no file downloads).
// Every write runs inside one database transaction: it either fully
// commits or fully rolls back. Writes from this server are also queued one
// at a time so they never trip over each other.

const dbClient = createClient({ url: DB_URL, authToken: DB_TOKEN || undefined });
let dbReady = false;   // true once startup (import/migrations) has finished

function rowsOf(rs) {
  const cols = rs.columns;
  return rs.rows.map(r => {
    const o = {};
    for (let i = 0; i < cols.length; i++) o[cols[i]] = r[i];
    return o;
  });
}

// libSQL rejects `undefined` (sql.js stored it as NULL) — normalise.
const argsOf = (params) => (params || []).map(v => v === undefined ? null : v);

// Statement helpers used inside write transactions (and by migrations).
function txHandle(tx) {
  return {
    run:   (sql, params = []) => tx.execute({ sql, args: argsOf(params) }),
    all:   async (sql, params = []) => rowsOf(await tx.execute({ sql, args: argsOf(params) })),
    one:   async (sql, params = []) => rowsOf(await tx.execute({ sql, args: argsOf(params) }))[0] || null,
    // Many statements in a single round trip: [[sql, params], ...]
    batch: (stmts) => stmts.length
      ? tx.batch(stmts.map(([sql, params]) => ({ sql, args: argsOf(params) })))
      : Promise.resolve([])
  };
}
const selectAll = (db, sql, params = []) => db.all(sql, params);
const selectOne = (db, sql, params = []) => db.one(sql, params);

// Read-only query
async function read(sql, params = []) {
  return rowsOf(await dbClient.execute({ sql, args: argsOf(params) }));
}

// ── Live-sync version counter ───────────────────────────────────────────
// Bumps every time a write commits, so other browsers can detect changes.
let _dataVersion = 1;
let _lastChange  = { version: 1, type: 'startup', who: null, at: new Date().toISOString() };

function bumpVersion(type, who) {
  _dataVersion++;
  _lastChange = { version: _dataVersion, type: type || 'change', who: who || null, at: new Date().toISOString() };
}

// Read-write: run the callback inside a transaction; commit on success,
// roll back on any error. Queued so only one write runs at a time.
let _writeQueue = Promise.resolve();

function withWriteDB(fn, change) {
  const run = _writeQueue.then(() => _withWriteDB(fn, change));
  _writeQueue = run.catch(() => {});   // keep the queue alive after errors
  return run;
}

async function _withWriteDB(fn, change) {
  const tx = await dbClient.transaction('write');
  try {
    const result = await fn(txHandle(tx));
    await tx.commit();
    if (change) bumpVersion(change.type, change.who);
    else bumpVersion('write', null);
    return result;
  } catch (e) {
    try { await tx.rollback(); } catch (_) {}
    throw e;
  } finally {
    try { tx.close(); } catch (_) {}
  }
}

// Single-statement write helper
async function write(sql, params = []) {
  return withWriteDB(async db => { await db.run(sql, params); });
}

// Lightweight connectivity check for the status indicator
async function pingDB() {
  const started = Date.now();
  try {
    await dbClient.execute('SELECT 1');
    return { ok: true, latencyMs: Date.now() - started };
  } catch (e) {
    const msg = String(e && (e.code || e.message) || e);
    const auth = /401|403|unauthori|forbidden|token/i.test(msg);
    return { ok: false, reason: auth ? 'Authentication failed (check TURSO_AUTH_TOKEN)' : msg.slice(0, 200), latencyMs: Date.now() - started };
  }
}

// ════════════════════════════════════════════════════════════════════════
// AUDIT
// ════════════════════════════════════════════════════════════════════════
function nowIso() { return new Date().toISOString().replace('T', ' ').substring(0, 19); }

function auditIn(db, username, action, details) {
  return db.run('INSERT INTO Audit_Log (LogDate, Username, Action, Details) VALUES (?, ?, ?, ?)',
    [nowIso(), username || '', action, details || '']);
}

// ════════════════════════════════════════════════════════════════════════
// FIRST START: create / import the database
// ════════════════════════════════════════════════════════════════════════
// Full schema of Order_App.db (used only with INIT_EMPTY_DB=yes).
const SCHEMA_SQL = [
  `CREATE TABLE Users (
    Username      TEXT PRIMARY KEY,
    PasswordHash  TEXT NOT NULL,
    Role          TEXT NOT NULL,
    FullName      TEXT,
    Email         TEXT,
    Active        INTEGER NOT NULL DEFAULT 1,
    Created       TEXT
)`,
  `CREATE TABLE Customers (
    Code            TEXT PRIMARY KEY,
    EN_Name         TEXT,
    AR_Name         TEXT,
    Sales_Rep       TEXT,
    Sales_Rep_Email TEXT
)`,
  `CREATE TABLE Customer_Balance (
    Code       TEXT PRIMARY KEY,
    Total_Debt REAL,
    Updated    TEXT
)`,
  `CREATE TABLE Orders (
    Number              TEXT PRIMARY KEY,
    OrderDate           TEXT,
    Code                TEXT,
    Customer            TEXT,
    Amount              REAL,
    Warehouse           TEXT,
    Imported_On         TEXT,
    Imported_By         TEXT,
    Order_Status        TEXT,
    CS_Mail_Sent        INTEGER NOT NULL DEFAULT 0,
    CS_Mail_Date        TEXT,
    Released            INTEGER NOT NULL DEFAULT 0,
    Release_Date        TEXT,
    Released_By         TEXT,
    Balance_At_Release  REAL,
    Remaining_Balance   REAL,
    Finance_Mail_Sent   INTEGER NOT NULL DEFAULT 0,
    Finance_Mail_Date   TEXT,
    Exception_Flag      INTEGER NOT NULL DEFAULT 0,
    Exception_Remark    TEXT,
    Uploaded_Balance    REAL
)`,
  `CREATE TABLE Audit_Log (
    LogID    INTEGER PRIMARY KEY AUTOINCREMENT,
    LogDate  TEXT,
    Username TEXT,
    Action   TEXT,
    Details  TEXT
)`,
  `CREATE TABLE Email_Recipients (
    ID             INTEGER PRIMARY KEY AUTOINCREMENT,
    Recipient_Type TEXT NOT NULL,
    Email          TEXT NOT NULL,
    DisplayName    TEXT,
    Active         INTEGER NOT NULL DEFAULT 1,
    Created        TEXT,
    Created_By     TEXT
)`,
  `CREATE TABLE Balance_Upload_Log (
    ID            INTEGER PRIMARY KEY AUTOINCREMENT,
    Uploaded_At   TEXT,
    Uploaded_By   TEXT,
    Cust_Count    INTEGER,
    Total_Balance REAL,
    Rows_Inserted INTEGER,
    Rows_Updated  INTEGER
)`,
  'CREATE INDEX idx_orders_code      ON Orders(Code)',
  'CREATE INDEX idx_orders_released  ON Orders(Released)'
];

async function databaseIsEmpty() {
  const rows = await read("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'Users'");
  return rows.length === 0;
}

// Downloads the old Order_App.db from the Nextcloud share (import only).
function downloadFromNextcloud() {
  const host = NC_HOST.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const base = new URL(process.env.NC_URL || `https://${host}`);   // NC_URL: testing only
  const client = base.protocol === 'http:' ? http : https;
  const auth = 'Basic ' + Buffer.from(`${NC_TOKEN}:${NC_PASSWORD}`).toString('base64');
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = client.request({
      protocol: base.protocol, hostname: base.hostname, port: base.port || undefined,
      path: `/public.php/webdav/${encodeURIComponent(NC_FILENAME)}`, method: 'GET',
      headers: { 'Authorization': auth, 'OCS-APIREQUEST': 'true' }, timeout: 60000
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Nextcloud download failed: HTTP ${res.statusCode}`)); }
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Nextcloud download timed out')));
    req.end();
  });
}

// Copies every table, row and index from a SQLite file into the (empty)
// hosted database — all inside ONE transaction, so it either completes
// fully or leaves the database untouched and is retried on next start.
async function importSqliteFile(buf, label) {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const src = new SQL.Database(new Uint8Array(buf));
  const q = (sql, params = []) => {
    const st = src.prepare(sql); st.bind(params);
    const out = []; while (st.step()) out.push(st.getAsObject()); st.free(); return out;
  };
  try {
    const check = q('PRAGMA integrity_check')[0];
    if (!check || Object.values(check)[0] !== 'ok') throw new Error('Source database failed its integrity check');

    const objects = q(`SELECT type, name, sql FROM sqlite_master
                       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
                       ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, rowid`);
    const tables = objects.filter(o => o.type === 'table');
    if (!tables.some(t => t.name === 'Users')) throw new Error('Source file has no Users table — is it the Orderflow database?');

    console.log(`  Importing ${tables.length} table(s) from ${label} ...`);
    const counts = {};
    const tx = await dbClient.transaction('write');
    try {
      for (const t of tables) await tx.execute(t.sql);
      for (const t of tables) {
        const cols = q(`PRAGMA table_info("${t.name.replace(/"/g, '""')}")`).map(c => c.name);
        const rows = q(`SELECT * FROM "${t.name.replace(/"/g, '""')}"`);
        const insert = `INSERT INTO "${t.name}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
        for (let i = 0; i < rows.length; i += 200) {
          await tx.batch(rows.slice(i, i + 200).map(r => ({ sql: insert, args: cols.map(c => r[c] === undefined ? null : r[c]) })));
        }
        counts[t.name] = rows.length;
      }
      for (const o of objects.filter(o => o.type !== 'table')) await tx.execute(o.sql);
      await tx.commit();
    } catch (e) {
      try { await tx.rollback(); } catch (_) {}
      throw e;
    } finally {
      try { tx.close(); } catch (_) {}
    }

    // Verify: every table has exactly the same number of rows
    for (const [name, n] of Object.entries(counts)) {
      const got = (await read(`SELECT COUNT(*) AS n FROM "${name}"`))[0].n;
      if (Number(got) !== n) throw new Error(`Import check failed for ${name}: expected ${n} rows, found ${got}`);
    }
    console.log('  Import complete and verified:');
    for (const [name, n] of Object.entries(counts)) console.log(`     ${name.padEnd(20)} ${n} row(s)`);
    return counts;
  } finally {
    src.close();
  }
}

// Returns 'ready' when the database has data, or 'awaiting-upload' when it
// is empty and nothing was configured to import (→ browser setup page).
async function prepareDatabase() {
  if (!(await databaseIsEmpty())) {
    if (NC_HOST || IMPORT_DB_FILE)
      console.log('  Database already has data — import settings (NC_* / IMPORT_DB_FILE) are ignored and can be removed.');
    return 'ready';
  }
  console.log('  Database is empty.');
  let buf = null, label = '';
  if (IMPORT_DB_FILE) {
    label = IMPORT_DB_FILE;
    buf = fs.readFileSync(path.resolve(__dirname, IMPORT_DB_FILE));
  } else if (NC_HOST && NC_TOKEN && NC_PASSWORD) {
    label = `Nextcloud (${NC_HOST.replace(/^https?:\/\//, '')} / ${NC_FILENAME})`;
    console.log(`  Downloading existing data from ${label} ...`);
    buf = await downloadFromNextcloud();
  }
  if (buf) {
    await importAndLog(buf, label, 'system');
    return 'ready';
  }
  if (INIT_EMPTY_DB) {
    console.log('  Creating a fresh, empty database (INIT_EMPTY_DB) ...');
    await withWriteDB(async db => {
      for (const sql of SCHEMA_SQL) await db.run(sql);
    });
    return 'ready';
  }
  return 'awaiting-upload';
}

async function importAndLog(buf, label, who) {
  const counts = await importSqliteFile(buf, label);
  await withWriteDB(db => auditIn(db, who, 'IMPORT_DATABASE',
    `from ${label}: ` + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')),
    { type: 'IMPORT_DATABASE', who });
  return counts;
}

// ── Startup sequence (also re-run right after a browser upload) ──────────
// Connect, import old data if configured, apply migrations, check users.
// If anything fails (e.g. the database is briefly unreachable), retry
// instead of running half-initialised.
let setupMode = false;      // true = empty database, waiting for an upload
let _startupTimer = null;

async function runStartup(attempt = 1) {
  clearTimeout(_startupTimer);
  console.log(`  Connecting to the database...${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
  try {
    await dbClient.execute('SELECT 1');
    const state = await prepareDatabase();
    if (state === 'awaiting-upload') {
      setupMode = true;
      console.log('  The database is empty. Open the app in a browser to upload your Order_App.db');
      console.log('  (setup key = the FINANCE_PASSWORD or CS_PASSWORD you configured).\n');
      return false;
    }
    setupMode = false;
    const rows = await read('SELECT COUNT(*) AS c FROM Users');
    console.log(`  Connected — ${rows[0].c} user(s) currently in the database.`);
    await runMigrations();
    await ensureDefaultUsers();
    await replaceDefaultPasswords();
    dbReady = true;
    console.log('  Ready.\n');
    return true;
  } catch (e) {
    console.error('  Startup FAILED:', e.message);
    console.error('  → Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.');
    console.error('  Retrying in 30 seconds...\n');
    _startupTimer = setTimeout(() => runStartup(attempt + 1), 30000);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ════════════════════════════════════════════════════════════════════════
// Behind Render's HTTPS proxy: trust X-Forwarded-* so secure cookies and
// client IPs (for login rate-limiting) work correctly.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Basic security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// Lightweight health check for the hosting platform / uptime pingers.
// Doesn't touch the database, so it's free to call often.
app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Sessions live in a signed cookie (not server memory), so users stay
// logged in when the free cloud instance sleeps or restarts.
app.use(cookieSession({
  name: 'orderflow.sid',
  keys: [SESSION_SECRET],
  httpOnly: true,
  sameSite: 'lax',
  secure: IS_PROD,
  maxAge: 8 * 60 * 60 * 1000
}));

app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ success: false, error: 'Not logged in' });
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.status(401).json({ success: false, error: 'Not logged in' });
    if (req.session.user.role !== role)
      return res.status(403).json({ success: false, error: 'Forbidden — wrong role' });
    next();
  };
}

// Generated email drafts contain order data — only logged-in users may download.
app.use('/drafts', requireAuth, express.static(DRAFTS_DIR));

// Until startup (first-time import, migrations) has finished, data APIs
// answer "starting up" instead of touching a half-prepared database.
app.use('/api', (req, res, next) => {
  if (dbReady || ['/health', '/app-info', '/me', '/setup/status', '/setup/import'].includes(req.path)) return next();
  if (setupMode)
    return res.status(503).json({ success: false, setupMode: true, error: 'The database is empty — open /setup.html to upload your data first.' });
  res.status(503).json({ success: false, error: 'The app is starting up — please try again in a few seconds.' });
});

// ════════════════════════════════════════════════════════════════════════
// FIRST-TIME SETUP — upload an existing Order_App.db from the browser
// ════════════════════════════════════════════════════════════════════════
// Only available while the hosted database is completely empty. Protected
// by a setup key = the FINANCE_PASSWORD or CS_PASSWORD set on the host.
let _setupBusy = false;

function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

app.get('/api/setup/status', (req, res) => {
  res.json({ setupMode, ready: dbReady, version: APP_VERSION });
});

app.post('/api/setup/import', upload.single('file'), async (req, res) => {
  const cleanup = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  try {
    if (!setupMode) {
      cleanup();
      return res.status(409).json({ success: false, error: 'The database is already set up — nothing to import.' });
    }
    const ip = clientIp(req);
    if (loginBlocked(ip, '__setup__')) {
      cleanup();
      return res.status(429).json({ success: false, error: 'Too many wrong setup keys. Try again in 15 minutes.' });
    }
    const keys = [process.env.FINANCE_PASSWORD, process.env.CS_PASSWORD].filter(k => k && k.length >= 8);
    if (!keys.length) {
      cleanup();
      return res.status(400).json({ success: false, error: 'No setup key configured. Set FINANCE_PASSWORD (8+ characters) in the hosting settings, then try again.' });
    }
    const key = String((req.body && req.body.key) || '');
    if (!keys.some(k => sameSecret(k, key))) {
      noteLoginFail(ip, '__setup__');
      cleanup();
      return res.status(403).json({ success: false, error: 'Wrong setup key. Use the FINANCE_PASSWORD (or CS_PASSWORD) you set in the hosting settings.' });
    }
    if (!req.file) return res.status(400).json({ success: false, error: 'Choose your Order_App.db file first.' });

    const buf = fs.readFileSync(req.file.path);
    const original = req.file.originalname || 'Order_App.db';
    cleanup();
    if (buf.length < 100 || buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000')
      return res.status(400).json({ success: false, error: `"${original}" is not a SQLite database file. Choose Order_App.db.` });

    if (_setupBusy) return res.status(409).json({ success: false, error: 'An import is already running — please wait.' });
    _setupBusy = true;
    try {
      if (!(await databaseIsEmpty())) {
        setupMode = false;
        runStartup();
        return res.status(409).json({ success: false, error: 'The database already has data — nothing to import.' });
      }
      const label = `uploaded file "${original}"`;
      console.log(`  Setup: importing ${label} (${buf.length} bytes) from ${ip}`);
      const counts = await importAndLog(buf, label, 'setup');
      const ok = await runStartup();
      res.json({ success: true, counts, ready: ok });
    } finally {
      _setupBusy = false;
    }
  } catch (e) {
    cleanup();
    console.error('  Setup import failed:', e.message);
    res.status(500).json({ success: false, error: 'Import failed: ' + e.message + ' — nothing was saved; you can try again.' });
  }
});

// ── Login brute-force protection (in memory) ────────────────────────────
// Two limits within a 15-minute window:
//   • per client IP   — 10 failed attempts
//   • per username    — 20 failed attempts (holds even if an attacker
//                       rotates or spoofs IP addresses)
const LOGIN_WINDOW_MS     = 15 * 60 * 1000;
const LOGIN_MAX_FAILS_IP   = 10;
const LOGIN_MAX_FAILS_USER = 20;
const _loginFails = new Map();   // key -> { count, first }

// Render sits behind Cloudflare, which passes the visitor's address in
// True-Client-IP. Fall back to Express's proxy-aware req.ip elsewhere.
function clientIp(req) {
  return (req.get('true-client-ip') || req.ip || '').trim();
}
function _failCount(key) {
  const e = _loginFails.get(key);
  if (!e) return 0;
  if (Date.now() - e.first > LOGIN_WINDOW_MS) { _loginFails.delete(key); return 0; }
  return e.count;
}
function loginBlocked(ip, username) {
  return _failCount('ip:' + ip) >= LOGIN_MAX_FAILS_IP ||
         _failCount('user:' + username) >= LOGIN_MAX_FAILS_USER;
}
function noteLoginFail(ip, username) {
  for (const key of ['ip:' + ip, 'user:' + username]) {
    if (_failCount(key) === 0) _loginFails.set(key, { count: 1, first: Date.now() });
    else _loginFails.get(key).count++;
  }
  if (_loginFails.size > 10000) _loginFails.clear();   // memory safety valve
}

// ════════════════════════════════════════════════════════════════════════
// SEED DEFAULT USERS  (only if Users table is empty)
// ════════════════════════════════════════════════════════════════════════
// The factory passwords. On the internet these must not keep working.
const DEFAULT_PASSWORDS = { cs: 'cs123', finance: 'fin123' };
// Replacement passwords supplied via environment (Render prompts for them).
const REPLACEMENT_PASSWORDS = {
  cs:      process.env.CS_PASSWORD      || '',
  finance: process.env.FINANCE_PASSWORD || ''
};
// In production, signing in with a factory password is always refused
// (see /api/login). At startup we swap it for the configured replacement.
async function replaceDefaultPasswords() {
  try {
    const users = await read('SELECT Username, PasswordHash FROM Users');
    const toReplace = [];
    for (const u of users) {
      const def = DEFAULT_PASSWORDS[u.Username];
      if (!def || !(await bcrypt.compare(def, u.PasswordHash))) continue;   // already changed
      const repl = REPLACEMENT_PASSWORDS[u.Username];
      if (repl && repl.length >= 8 && repl !== def) {
        toReplace.push({ username: u.Username, hash: await bcrypt.hash(repl, 10) });
      } else {
        console.warn(`  ⚠ User "${u.Username}" still has the default password.` +
          (IS_PROD ? ` Sign-in is blocked until ${u.Username === 'cs' ? 'CS_PASSWORD' : 'FINANCE_PASSWORD'} (8+ chars) is set.` : ''));
      }
    }
    if (!toReplace.length) return;
    await withWriteDB(async db => {
      for (const u of toReplace)
        await db.run('UPDATE Users SET PasswordHash = ? WHERE Username = ?', [u.hash, u.username]);
      await auditIn(db, 'system', 'DEFAULT_PASSWORD_REPLACED', toReplace.map(u => u.username).join(','));
    }, { type: 'USERS_CHANGED', who: 'system' });
    console.log(`  Default password replaced for: ${toReplace.map(u => u.username).join(', ')}`);
  } catch (e) {
    console.error('  Could not check default passwords:', e.message);
  }
}

async function ensureDefaultUsers() {
  try {
    // Build the list of defaults we want present.
    const defaults = [
      { username: 'cs',      password: REPLACEMENT_PASSWORDS.cs      || DEFAULT_PASSWORDS.cs,      role: 'customer_service', fullName: 'Customer Service', email: 'cs@example.com' },
      { username: 'finance', password: REPLACEMENT_PASSWORDS.finance || DEFAULT_PASSWORDS.finance, role: 'finance',          fullName: 'Finance Team',     email: 'finance@example.com' }
    ];

    // Find which ones are already there.
    const existing = await read('SELECT Username FROM Users');
    const have = new Set(existing.map(u => u.Username));
    const missing = defaults.filter(d => !have.has(d.username));
    if (!missing.length) return;

    console.log(`  Seeding ${missing.length} missing default user(s)...`);
    const inserts = [];
    for (const d of missing) {
      const hash = await bcrypt.hash(d.password, 10);
      inserts.push({ ...d, hash });
    }

    await withWriteDB(async db => {
      const now = nowIso();
      for (const u of inserts) {
        await db.run('INSERT INTO Users (Username, PasswordHash, Role, FullName, Email, Active, Created) VALUES (?,?,?,?,?,?,?)',
          [u.username, u.hash, u.role, u.fullName, u.email, 1, now]);
      }
      await auditIn(db, 'system', 'SEED_USERS', `created: ${inserts.map(u => u.username).join(',')}`);
    });

    console.log(`  Seeded user(s): ${inserts.map(u => u.username).join(', ')}`);
  } catch (e) {
    console.error('  Could not seed users:', e.message);
  }
}

// ── Lightweight migrations: add new columns / tables as the app evolves ──
async function runMigrations() {
  try {
    const ops = [];   // array of {label, sql, postFn?}

    // 1) Orders.Uploaded_Balance column
    const orderCols = await read("PRAGMA table_info(Orders)");
    if (!orderCols.some(c => c.name === 'Uploaded_Balance')) {
      ops.push({
        label: 'Add Orders.Uploaded_Balance',
        sql:   'ALTER TABLE Orders ADD COLUMN Uploaded_Balance REAL',
        postFn: async (db) => {
          const pending = await selectAll(db, 'SELECT DISTINCT Code FROM Orders WHERE Released = 0');
          for (const { Code } of pending) {
            const b = await selectOne(db, 'SELECT Total_Debt FROM Customer_Balance WHERE Code = ?', [Code]);
            if (b) await db.run('UPDATE Orders SET Uploaded_Balance = ? WHERE Code = ? AND Released = 0',
              [Number(b.Total_Debt) || 0, Code]);
          }
        }
      });
    }

    // 2) Email_Recipients table
    const tables = await read("SELECT name FROM sqlite_master WHERE type='table'");
    const tableNames = new Set(tables.map(t => t.name));
    if (!tableNames.has('Email_Recipients')) {
      ops.push({
        label: 'Create Email_Recipients table',
        sql: `CREATE TABLE Email_Recipients (
                ID         INTEGER PRIMARY KEY AUTOINCREMENT,
                Recipient_Type TEXT NOT NULL,   -- 'finance' or 'customer_service'
                Email      TEXT NOT NULL,
                DisplayName TEXT,
                Active     INTEGER NOT NULL DEFAULT 1,
                Created    TEXT,
                Created_By TEXT
              )`,
        postFn: async (db) => {
          // Seed from existing Users table so the app keeps working immediately
          const users = await selectAll(db,
            "SELECT Username, Email, Role, FullName FROM Users WHERE Email IS NOT NULL AND Email <> ''");
          const now = nowIso();
          for (const u of users) {
            const type = u.Role === 'finance' ? 'finance' : (u.Role === 'customer_service' ? 'customer_service' : null);
            if (!type) continue;
            await db.run('INSERT INTO Email_Recipients (Recipient_Type, Email, DisplayName, Active, Created, Created_By) VALUES (?,?,?,?,?,?)',
              [type, u.Email, u.FullName || u.Username, 1, now, 'system_migration']);
          }
        }
      });
    }

    // 3) Balance_Upload_Log table — for duplicate-upload protection
    if (!tableNames.has('Balance_Upload_Log')) {
      ops.push({
        label: 'Create Balance_Upload_Log table',
        sql: `CREATE TABLE Balance_Upload_Log (
                ID            INTEGER PRIMARY KEY AUTOINCREMENT,
                Uploaded_At   TEXT,
                Uploaded_By   TEXT,
                Cust_Count    INTEGER,
                Total_Balance REAL,
                Rows_Inserted INTEGER,
                Rows_Updated  INTEGER
              )`
      });
    }

    if (!ops.length) return;

    console.log(`  Running ${ops.length} migration(s)...`);
    await withWriteDB(async db => {
      for (const op of ops) {
        try {
          await db.run(op.sql);
          console.log('    ✓ ' + op.label);
          if (op.postFn) await op.postFn(db);
        } catch (e) {
          console.error('    ✗ ' + op.label + ' — ' + e.message);
        }
      }
      await auditIn(db, 'system', 'MIGRATION', `applied: ${ops.map(o => o.label).join('; ')}`);
    });
    console.log('  Migrations applied.');
  } catch (e) {
    console.error('  Migration error:', e.message);
  }
}

// ════════════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════════════
// ────────────────────────────────────────────────────────────────────────
// HEALTH / CONNECTION STATUS
// ────────────────────────────────────────────────────────────────────────
let _healthCache = { result: null, ts: 0 };
const HEALTH_CACHE_MS = 5000;  // 5-second cache; avoids hammering the database
app.get('/api/health', async (req, res) => {
  try {
    const now = Date.now();
    let result;
    if (_healthCache.result && (now - _healthCache.ts) < HEALTH_CACHE_MS) {
      result = _healthCache.result;
    } else {
      result = await pingDB();
      _healthCache = { result, ts: now };
    }
    if (result.ok && !dbReady) result = { ok: false, reason: 'Database is starting up', latencyMs: result.latencyMs };
    res.json({
      connected:   !!result.ok,
      reason:      result.reason || null,
      latencyMs:   result.latencyMs ?? null,
      host:        DB_LABEL,
      label:       'Database',
      lastChecked: new Date().toISOString()
    });
  } catch (e) {
    res.json({ connected: false, reason: e.message, lastChecked: new Date().toISOString() });
  }
});

// ── Full database backup as a SQLite file (Order_App.db) ─────────────────
// Same file format as before, so it opens in DB Browser for SQLite and can
// be used to restore (IMPORT_DB_FILE) if ever needed.
app.get('/api/backup', requireAuth, async (req, res) => {
  try {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const out = new SQL.Database();
    const snap = await dbClient.transaction('read');   // one consistent snapshot
    try {
      const src = txHandle(snap);
      const objects = await src.all(`SELECT type, name, sql FROM sqlite_master
                                  WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' AND name NOT LIKE 'libsql_%'
                                  ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`);
      const tables = objects.filter(o => o.type === 'table');
      out.run('BEGIN');
      for (const t of tables) out.run(t.sql);
      for (const t of tables) {
        const rows = await src.all(`SELECT * FROM "${t.name.replace(/"/g, '""')}" ORDER BY rowid`);
        if (!rows.length) continue;
        const cols = Object.keys(rows[0]);
        const st = out.prepare(`INSERT INTO "${t.name}" (${cols.map(c => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
        for (const r of rows) st.run(cols.map(c => (typeof r[c] === 'bigint' ? Number(r[c]) : r[c])));
        st.free();
      }
      for (const o of objects.filter(o => o.type !== 'table')) out.run(o.sql);
      out.run('COMMIT');
      const data = Buffer.from(out.export());
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/vnd.sqlite3');
      res.setHeader('Content-Disposition', `attachment; filename="Order_App_backup_${stamp}.db"`);
      res.send(data);
      write('INSERT INTO Audit_Log (LogDate, Username, Action, Details) VALUES (?,?,?,?)',
        [nowIso(), req.session.user.username, 'DOWNLOAD_BACKUP', `${data.length} bytes`]).catch(() => {});
    } finally {
      try { snap.close(); } catch (_) {}
      out.close();
    }
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Returns the current data version. Frontend polls this every 10s to detect
// changes made by other users and auto-refresh accordingly.
app.get('/api/version', requireAuth, (req, res) => {
  res.json({
    success: true,
    version:    _dataVersion,
    lastChange: _lastChange
  });
});

app.post('/api/login', async (req, res) => {
  try {
    const ip = clientIp(req);
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, error: 'Missing credentials' });
    const uname = String(username).slice(0, 100);
    if (loginBlocked(ip, uname))
      return res.status(429).json({ success: false, error: 'Too many failed sign-in attempts. Try again in 15 minutes.' });
    const rows = await read('SELECT * FROM Users WHERE Username = ?', [uname]);
    if (!rows.length) { noteLoginFail(ip, uname); return res.status(401).json({ success: false, error: 'Invalid credentials' }); }
    const u = rows[0];
    if (!u.Active) return res.status(403).json({ success: false, error: 'Account disabled' });
    const ok = await bcrypt.compare(String(password), u.PasswordHash);
    if (!ok) { noteLoginFail(ip, uname); return res.status(401).json({ success: false, error: 'Invalid credentials' }); }
    // Fail-safe: online, a factory password never signs in (even if the
    // startup replacement hasn't run yet).
    if (IS_PROD && String(password) === DEFAULT_PASSWORDS[u.Username])
      return res.status(403).json({ success: false, error: 'This account still uses its default password, which is disabled on the hosted app. The administrator must set a new one in the hosting settings.' });
    _loginFails.delete('ip:' + ip);
    _loginFails.delete('user:' + uname);
    req.session.user = { username: u.Username, role: u.Role, fullName: u.FullName, email: u.Email };
    // audit (non-blocking)
    write('INSERT INTO Audit_Log (LogDate, Username, Action, Details) VALUES (?,?,?,?)',
      [nowIso(), u.Username, 'LOGIN', '']).catch(()=>{});
    res.json({ success: true, user: req.session.user });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/logout', (req, res) => {
  const u = req.session && req.session.user;
  req.session = null;   // clears the session cookie
  res.json({ success: true });
  if (u) write('INSERT INTO Audit_Log (LogDate, Username, Action, Details) VALUES (?,?,?,?)',
    [nowIso(), u.username, 'LOGOUT', '']).catch(()=>{});
});

app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.user) return res.json({ success: false, version: APP_VERSION });
  res.json({ success: true, user: req.session.user, version: APP_VERSION });
});

// Build info — usable by the login page (no auth required)
app.get('/api/app-info', (req, res) => {
  res.json({ name: 'Orderflow', version: APP_VERSION });
});

app.post('/api/change-password', requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!newPassword || String(newPassword).length < 8)
      return res.status(400).json({ success: false, error: 'New password must be at least 8 characters' });
    if (Object.values(DEFAULT_PASSWORDS).includes(String(newPassword)))
      return res.status(400).json({ success: false, error: 'Please choose a password other than the default one' });
    const rows = await read('SELECT PasswordHash FROM Users WHERE Username = ?', [req.session.user.username]);
    const ok = await bcrypt.compare(oldPassword || '', rows[0].PasswordHash);
    if (!ok) return res.status(400).json({ success: false, error: 'Old password is wrong' });
    const newHash = await bcrypt.hash(newPassword, 10);
    await write('UPDATE Users SET PasswordHash = ? WHERE Username = ?', [newHash, req.session.user.username]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// CUSTOMERS
// ════════════════════════════════════════════════════════════════════════
app.get('/api/customers', requireAuth, async (req, res) => {
  try {
    const rows = await read('SELECT * FROM Customers ORDER BY Code');
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/customers/import', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const wb = XLSX.readFile(req.file.path);
    const sh = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sh, { defval: null });
    fs.unlink(req.file.path, () => {});

    const result = await withWriteDB(async db => {
      let inserted = 0, updated = 0, skipped = 0;
      // One query for all existing codes, then all changes in batches
      // (instead of 2 round trips per row).
      const existing = new Set((await selectAll(db, 'SELECT Code FROM Customers')).map(r => String(r.Code)));
      const stmts = [];
      for (const r of rows) {
        const code = (r['Customer 1C codes'] || r.Code || '').toString().trim();
        if (!code) { skipped++; continue; }
        const en   = r['EN company Name'] || r.EN_Name || '';
        const ar   = r['Ar company Name'] || r.AR_Name || '';
        const rep  = r['Sales rep']        || r.Sales_Rep || '';
        const mail = r['Sales Repr Email'] || r['Sales_Rep_Email'] || '';
        if (existing.has(code)) {
          stmts.push(['UPDATE Customers SET EN_Name=?, AR_Name=?, Sales_Rep=?, Sales_Rep_Email=? WHERE Code=?',
            [en, ar, rep, mail, code]]);
          updated++;
        } else {
          stmts.push(['INSERT INTO Customers (Code, EN_Name, AR_Name, Sales_Rep, Sales_Rep_Email) VALUES (?,?,?,?,?)',
            [code, en, ar, rep, mail]]);
          existing.add(code);
          inserted++;
        }
      }
      for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
      await auditIn(db, req.session.user.username, 'IMPORT_CUSTOMERS',
        `inserted=${inserted} updated=${updated} skipped=${skipped}`);
      return { inserted, updated, skipped, total: rows.length };
    }, { type: 'IMPORT_CUSTOMERS', who: req.session.user.username });
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// EMAIL RECIPIENTS  (managed by Customer Service)
// ════════════════════════════════════════════════════════════════════════

// List all recipients (both finance + cs)
app.get('/api/recipients', requireAuth, async (req, res) => {
  try {
    const rows = await read('SELECT * FROM Email_Recipients ORDER BY Recipient_Type, DisplayName, Email');
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Add new recipient (CS only)
app.post('/api/recipients', requireRole('customer_service'), async (req, res) => {
  try {
    const { recipient_type, email, displayName, active } = req.body || {};
    if (!recipient_type || !['finance', 'customer_service'].includes(recipient_type))
      return res.status(400).json({ success: false, error: 'recipient_type must be "finance" or "customer_service"' });
    const e = (email || '').toString().trim();
    if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
      return res.status(400).json({ success: false, error: 'Invalid email address' });

    await withWriteDB(async db => {
      await db.run('INSERT INTO Email_Recipients (Recipient_Type, Email, DisplayName, Active, Created, Created_By) VALUES (?,?,?,?,?,?)',
        [recipient_type, e, (displayName || '').toString().trim(), active === false ? 0 : 1, nowIso(), req.session.user.username]);
      await auditIn(db, req.session.user.username, 'RECIPIENT_ADD', `${recipient_type}: ${e}`);
    }, { type: 'RECIPIENTS_CHANGED', who: req.session.user.username });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Update (CS only) — toggle active, edit email/name
app.put('/api/recipients/:id', requireRole('customer_service'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { email, displayName, active, recipient_type } = req.body || {};
    if (Number.isNaN(id)) return res.status(400).json({ success: false, error: 'Bad id' });

    const existing = await read('SELECT * FROM Email_Recipients WHERE ID = ?', [id]);
    if (!existing.length) return res.status(404).json({ success: false, error: 'Recipient not found' });

    const fields = [], params = [];
    if (typeof email === 'string') {
      const e = email.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
        return res.status(400).json({ success: false, error: 'Invalid email address' });
      fields.push('Email = ?'); params.push(e);
    }
    if (typeof displayName === 'string') { fields.push('DisplayName = ?'); params.push(displayName.trim()); }
    if (typeof active === 'boolean')     { fields.push('Active = ?');      params.push(active ? 1 : 0); }
    if (typeof recipient_type === 'string' && ['finance','customer_service'].includes(recipient_type)) {
      fields.push('Recipient_Type = ?'); params.push(recipient_type);
    }
    if (!fields.length) return res.status(400).json({ success: false, error: 'Nothing to update' });
    params.push(id);

    await withWriteDB(async db => {
      await db.run(`UPDATE Email_Recipients SET ${fields.join(', ')} WHERE ID = ?`, params);
      await auditIn(db, req.session.user.username, 'RECIPIENT_UPDATE', `ID=${id} fields=${fields.join(',')}`);
    }, { type: 'RECIPIENTS_CHANGED', who: req.session.user.username });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Delete (CS only)
app.delete('/api/recipients/:id', requireRole('customer_service'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ success: false, error: 'Bad id' });
    await withWriteDB(async db => {
      await db.run('DELETE FROM Email_Recipients WHERE ID = ?', [id]);
      await auditIn(db, req.session.user.username, 'RECIPIENT_DELETE', `ID=${id}`);
    }, { type: 'RECIPIENTS_CHANGED', who: req.session.user.username });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Internal helper — fetch active emails by type
async function getRecipientEmails(type) {
  const rows = await read('SELECT Email FROM Email_Recipients WHERE Recipient_Type = ? AND Active = 1', [type]);
  return rows.map(r => r.Email).filter(Boolean);
}

// ════════════════════════════════════════════════════════════════════════
// ORDERS — list with filters
// ════════════════════════════════════════════════════════════════════════
app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const { status, search, includeMailed, code, month, year } = req.query;
    let sql = `SELECT o.*, c.Sales_Rep, c.Sales_Rep_Email
               FROM Orders o LEFT JOIN Customers c ON o.Code = c.Code`;
    const where = [], params = [];
    if (status === 'pending')   where.push('o.Released = 0');
    if (status === 'released')  where.push('o.Released = 1');
    if (status === 'unmailed')  where.push('o.Released = 1 AND o.Finance_Mail_Sent = 0');
    if (status === 'mailed')    where.push('o.Released = 1 AND o.Finance_Mail_Sent = 1');
    // Default behaviour: hide released-AND-mailed orders unless explicitly asked for.
    // (They're considered "settled" — the next balance upload reflects them.)
    if (!includeMailed && status !== 'released' && status !== 'mailed') {
      where.push('(o.Released = 0 OR o.Finance_Mail_Sent = 0)');
    }
    if (code) {
      where.push('o.Code = ?');
      params.push(code);
    }
    // ── Month / Year filter on OrderDate (the Date column from the import) ──
    const monthNum = month ? parseInt(month, 10) : null;
    const yearNum  = year  ? parseInt(year, 10)  : null;
    if (monthNum && monthNum >= 1 && monthNum <= 12) {
      where.push("CAST(strftime('%m', o.OrderDate) AS INTEGER) = ?");
      params.push(monthNum);
    }
    if (yearNum && yearNum >= 1900 && yearNum <= 9999) {
      where.push("CAST(strftime('%Y', o.OrderDate) AS INTEGER) = ?");
      params.push(yearNum);
    }
    if (search) {
      where.push('(o.Number LIKE ? OR o.Customer LIKE ? OR o.Code LIKE ?)');
      const w = `%${search}%`; params.push(w, w, w);
    }
    if (where.length) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY o.OrderDate DESC, o.Number DESC';
    const rows = await read(sql, params);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── List of customers that currently have at least one PENDING order ─────
app.get('/api/customers/pending', requireAuth, async (req, res) => {
  try {
    const { month, year } = req.query;
    const where = ["o.Released = 0", "o.Code IS NOT NULL", "o.Code <> ''"];
    const params = [];
    const monthNum = month ? parseInt(month, 10) : null;
    const yearNum  = year  ? parseInt(year, 10)  : null;
    if (monthNum && monthNum >= 1 && monthNum <= 12) {
      where.push("CAST(strftime('%m', o.OrderDate) AS INTEGER) = ?");
      params.push(monthNum);
    }
    if (yearNum && yearNum >= 1900 && yearNum <= 9999) {
      where.push("CAST(strftime('%Y', o.OrderDate) AS INTEGER) = ?");
      params.push(yearNum);
    }
    const rows = await read(`
      SELECT o.Code,
             COALESCE(o.Customer, '') AS Customer,
             COUNT(*)        AS PendingCount,
             SUM(o.Amount)   AS PendingAmount
      FROM Orders o
      WHERE ${where.join(' AND ')}
      GROUP BY o.Code, o.Customer
      ORDER BY o.Customer, o.Code`, params);
    res.json({ success: true, data: rows });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── CS imports orders from Excel  (skip duplicate Numbers) ───────────────
app.post('/api/orders/import', requireRole('customer_service'), upload.single('file'), async (req, res) => {
  try {
    const wb = XLSX.readFile(req.file.path);
    // Pick the first sheet that has a "Number" column
    let rows = [];
    for (const n of wb.SheetNames) {
      const r = XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: null });
      if (r.length && (r[0].Number !== undefined || r[0].number !== undefined)) { rows = r; break; }
    }
    if (!rows.length) rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
    fs.unlink(req.file.path, () => {});

    const now = nowIso();
    const result = await withWriteDB(async db => {
      let inserted = 0, duplicate = 0, skipped = 0;
      const touchedCodes = new Set();
      // One query for all existing order numbers, then inserts in batches
      // (instead of 2 round trips per row).
      const existing = new Set((await selectAll(db, 'SELECT Number FROM Orders')).map(r => String(r.Number)));
      const stmts = [];

      for (const r of rows) {
        const number = (r.Number || r.number || '').toString().trim();
        if (!number) { skipped++; continue; }
        if (existing.has(number)) { duplicate++; continue; }
        existing.add(number);

        let orderDate = r.Date || r.date;
        if (orderDate instanceof Date) orderDate = orderDate.toISOString().replace('T', ' ').substring(0, 19);
        else if (typeof orderDate === 'number') {
          const d = XLSX.SSF.parse_date_code(orderDate);
          if (d) orderDate = `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')} 00:00:00`;
        }

        const code = (r.Code || '').toString();
        stmts.push([`INSERT INTO Orders
          (Number, OrderDate, Code, Customer, Amount, Warehouse, Imported_On, Imported_By,
           Order_Status, CS_Mail_Sent, Released, Finance_Mail_Sent, Exception_Flag)
          VALUES (?,?,?,?,?,?,?,?,?,0,0,0,0)`,
          [number, orderDate || null, code, (r.Customer || '').toString(),
           Number(r.Amount) || 0, (r.Warehouse || '').toString(),
           now, req.session.user.username,
           String(r['State, Reserve exceeds balance'] || r.Order_Status || 'Pending')]]);
        inserted++;
        if (code) touchedCodes.add(code);
      }
      for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));

      // Update Uploaded_Balance + Remaining_Balance on every pending order
      // of each customer who received new orders (so new rows show the right balance).
      for (const code of touchedCodes) await recalcRemaining(db, code);

      await auditIn(db, req.session.user.username, 'IMPORT_ORDERS',
        `inserted=${inserted} duplicates=${duplicate} skipped=${skipped}`);
      return { inserted, duplicate, skipped, total: rows.length };
    }, { type: 'IMPORT_ORDERS', who: req.session.user.username });
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── CS notify finance → build outlook .eml draft ─────────────────────────
app.post('/api/orders/notify-finance', requireRole('customer_service'), async (req, res) => {
  try {
    const orders = await read(`SELECT o.*, c.Sales_Rep_Email
                               FROM Orders o LEFT JOIN Customers c ON o.Code = c.Code
                               WHERE o.CS_Mail_Sent = 0
                               ORDER BY o.OrderDate, o.Number`);
    if (!orders.length) return res.status(400).json({ success: false, error: 'No new orders to notify' });

    // Build CC list of unique sales reps
    const ccSet = new Set();
    orders.forEach(o => { if (o.Sales_Rep_Email) ccSet.add(o.Sales_Rep_Email); });

    // Build Excel attachment
    const attachmentRows = orders.map(o => ({
      Number: o.Number, Date: o.OrderDate, Code: o.Code,
      Customer: o.Customer, Amount: o.Amount, Warehouse: o.Warehouse
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(attachmentRows), 'New Orders');
    const stamp = Date.now();
    const attachmentPath = path.join(DRAFTS_DIR, `New_Orders_${stamp}.xlsx`);
    XLSX.writeFile(wb, attachmentPath);

    // To = finance users with email
    // To = active finance recipients (from Email_Recipients table)
    const financeEmails = await getRecipientEmails('finance');
    const to = financeEmails.join('; ');
    if (!to) return res.status(400).json({ success: false, error: 'No Finance recipients configured. Add some in Email Recipients.' });

    const total = orders.reduce((s, o) => s + (Number(o.Amount) || 0), 0);
    const subject = `New Orders for Review - ${orders.length} order(s)`;
    const body =
`Dear Finance Team,

Please find attached ${orders.length} new order(s) for your review and release.

Summary:
  - Total orders : ${orders.length}
  - Total amount : ${total.toLocaleString()}

Customers in this batch:
${[...new Set(orders.map(o => `  - ${o.Code}  ${o.Customer}`))].join('\n')}

The detailed list is in the attached Excel file.

Kind regards,
${req.session.user.fullName || req.session.user.username}
Customer Service`;

    const emlPath = buildEml({
      to, cc: [...ccSet].join('; '), subject, body, attachmentPath, stamp, prefix: 'cs_notify'
    });

    // Try to open it directly in Outlook
    const ccStr = [...ccSet].join('; ');
    const outlookResult = await openInOutlook({
      to, cc: ccStr, subject, body, attachmentPath, emlPath
    });

    // Mark orders as mailed (draft prepared, regardless of which method opened it)
    const now = nowIso();
    await withWriteDB(async db => {
      const stmts = orders.map(o => ['UPDATE Orders SET CS_Mail_Sent = 1, CS_Mail_Date = ? WHERE Number = ?', [now, o.Number]]);
      for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
      await auditIn(db, req.session.user.username, 'CS_NOTIFY_FINANCE',
        `${orders.length} orders, draft=${outlookResult.ok ? 'outlook' : (outlookResult.reason === 'not_windows' ? 'download' : 'fallback:'+outlookResult.reason)}`);
    }, { type: 'CS_NOTIFY_FINANCE', who: req.session.user.username });

    res.json({
      success: true, count: orders.length,
      to, cc: ccStr, subject,
      outlookOpened: outlookResult.ok,
      outlookMethod: outlookResult.method || null,
      // On the cloud host (Linux) Outlook can't be driven — the browser
      // downloads the .eml draft instead. That's expected, not an error.
      outlookError:  (outlookResult.ok || outlookResult.reason === 'not_windows') ? null : (outlookResult.reason || 'unknown'),
      deliveryMode:  outlookResult.ok ? 'outlook' : 'download',
      // Lets the Outlook helper on the user's PC fetch this email (15 min)
      draftToken:    outlookResult.ok ? null : createMailToken({ to, cc: ccStr, subject, body, attachmentPath, emlPath }),
      // Always return fallback links so frontend can offer them if Outlook didn't open
      emlUrl: '/drafts/' + path.basename(emlPath),
      attachmentUrl: '/drafts/' + path.basename(attachmentPath)
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── CS bulk-delete orders (only those NOT yet released) ──────────────────
app.post('/api/orders/delete', requireRole('customer_service'), async (req, res) => {
  try {
    const numbers = Array.isArray(req.body && req.body.numbers) ? req.body.numbers : [];
    const force = !!(req.body && req.body.force);
    if (!numbers.length) return res.status(400).json({ success: false, error: 'No orders selected' });

    const result = await withWriteDB(async db => {
      let deleted = 0, skipped = 0, deletedReleased = 0;
      const skippedDetails = [];
      // Track which customers had a PENDING order deleted — those need
      // their pending pool recalculated. Released-order deletions don't
      // affect the pool (we deliberately keep Remaining as-is).
      const touchedCodesPending = new Set();

      // Look up all selected orders in a few queries, delete in batches.
      const wanted = numbers.map(n => String(n));
      const found = new Map();
      for (let i = 0; i < wanted.length; i += 500) {
        const chunk = wanted.slice(i, i + 500);
        const rows = await selectAll(db,
          `SELECT Number, Code, Released FROM Orders WHERE Number IN (${chunk.map(() => '?').join(',')})`, chunk);
        for (const r of rows) found.set(String(r.Number), r);
      }
      const stmts = [];
      for (const num of wanted) {
        const o = found.get(num);
        if (!o) { skipped++; skippedDetails.push({ number: num, reason: 'not found' }); continue; }

        if (o.Released && !force) {
          skipped++;
          skippedDetails.push({ number: num, reason: 'already released by Finance' });
          continue;
        }

        stmts.push(['DELETE FROM Orders WHERE Number = ?', [num]]);
        found.delete(num);   // a repeated number counts as "not found", as before
        deleted++;
        if (o.Released) deletedReleased++;
        else if (o.Code) touchedCodesPending.add(o.Code);
      }
      for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));

      // Only refresh pending pool for customers whose PENDING orders changed.
      // For released deletions we leave Remaining_Balance untouched (per spec).
      for (const code of touchedCodesPending) await recalcRemaining(db, code);

      await auditIn(db, req.session.user.username, force ? 'CS_DELETE_ORDERS_FORCE' : 'CS_DELETE_ORDERS',
        `deleted=${deleted} (${deletedReleased} released) skipped=${skipped} numbers=${numbers.join(',')}`);
      return { deleted, deletedReleased, skipped, skippedDetails };
    }, { type: 'CS_DELETE_ORDERS', who: req.session.user.username });

    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.post('/api/balance/import', requireRole('finance'), upload.single('file'), async (req, res) => {
  try {
    const wb = XLSX.readFile(req.file.path);

    // ───── Step 1: Find and validate the Summary sheet ─────
    // The file MUST contain a "Summary" sheet with Cust_Count and Total Balance
    const summarySheetName = wb.SheetNames.find(n => n.trim().toLowerCase() === 'summary');
    if (!summarySheetName) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({
        success: false,
        error: 'Customer_Balance.xlsx must contain a "Summary" sheet with Cust_Count and Total Balance columns. Upload rejected.'
      });
    }
    const summarySheet = wb.Sheets[summarySheetName];
    const summaryRows  = XLSX.utils.sheet_to_json(summarySheet, { defval: null });
    if (!summaryRows.length) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({
        success: false,
        error: 'The "Summary" sheet is empty. Upload rejected.'
      });
    }

    // Extract Cust_Count + Total Balance from the first summary row (case-insensitive)
    const sumRow = summaryRows[0];
    const getKey = (obj, target) => {
      for (const k of Object.keys(obj)) {
        if (k.replace(/[\s_]/g, '').toLowerCase() === target.replace(/[\s_]/g, '').toLowerCase()) return obj[k];
      }
      return undefined;
    };
    const newCustCount     = Number(getKey(sumRow, 'Cust_Count') ?? getKey(sumRow, 'Customer Count') ?? NaN);
    const newTotalBalance  = Number(getKey(sumRow, 'Total Balance') ?? getKey(sumRow, 'Total_Balance') ?? NaN);
    if (Number.isNaN(newCustCount) || Number.isNaN(newTotalBalance)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({
        success: false,
        error: 'The "Summary" sheet must contain valid Cust_Count and Total Balance values. Upload rejected.'
      });
    }

    // ───── Step 2: Compare to the last upload — duplicate check (hard reject) ─────
    const lastUpload = await read('SELECT * FROM Balance_Upload_Log ORDER BY ID DESC LIMIT 1');
    if (lastUpload.length) {
      const prev = lastUpload[0];
      const sameCount = Number(prev.Cust_Count) === newCustCount;
      const sameTotal = Math.abs(Number(prev.Total_Balance) - newTotalBalance) < 0.01;
      if (sameCount && sameTotal) {
        fs.unlink(req.file.path, () => {});
        return res.status(409).json({
          success: false,
          error: `Duplicate upload detected. This file's Summary (Cust_Count=${newCustCount}, Total Balance=${newTotalBalance.toLocaleString()}) matches the last upload on ${prev.Uploaded_At} by ${prev.Uploaded_By}. Upload rejected to prevent duplication.`,
          isDuplicate: true,
          previousUpload: {
            uploadedAt: prev.Uploaded_At,
            uploadedBy: prev.Uploaded_By,
            custCount:  Number(prev.Cust_Count),
            totalBalance: Number(prev.Total_Balance)
          }
        });
      }
    }

    // ───── Step 3: Read the main data sheet (first sheet that isn't Summary) ─────
    const dataSheetName = wb.SheetNames.find(n => n !== summarySheetName) || wb.SheetNames[0];
    const dataSheet     = wb.Sheets[dataSheetName];
    const rows          = XLSX.utils.sheet_to_json(dataSheet, { defval: null });
    fs.unlink(req.file.path, () => {});

    // ───── Step 4: Aggregate rows by customer code (raw file may contain duplicates) ─────
    // Sum Total Debt for each unique code, then flip sign once at the end.
    const aggregated = new Map();   // Code -> raw_total (before sign flip)
    let rowsRead = 0, rowsSkipped = 0;
    for (const r of rows) {
      rowsRead++;
      const code = (r.Code || r.code || '').toString().trim();
      const raw  = Number(r['Total Debt'] || r.Total_Debt || r.Balance || 0);
      if (!code) { rowsSkipped++; continue; }
      aggregated.set(code, (aggregated.get(code) || 0) + raw);
    }

    // ───── Step 5: Clean-slate replace Customer_Balance + handle pending orders ─────
    const now = nowIso();
    const result = await withWriteDB(async db => {
      // Remember which customers had pending orders BEFORE we wipe the table,
      // so we can update their Remaining/Uploaded values afterward.
      const pendingCustomers = (await selectAll(db, 'SELECT DISTINCT Code FROM Orders WHERE Released = 0')).map(r => r.Code);

      // Wipe the previous balance entries entirely.
      await db.run('DELETE FROM Customer_Balance');

      // Insert one row per unique customer (sign flipped: negative debt → positive credit).
      let inserted = 0;
      const newBalance = new Map();   // code -> stored Total_Debt (after flip)
      const inserts = [];
      for (const [code, rawTotal] of aggregated.entries()) {
        const debt = -rawTotal;   // sign flip
        inserts.push(['INSERT INTO Customer_Balance (Code, Total_Debt, Updated) VALUES (?, ?, ?)', [code, debt, now]]);
        newBalance.set(String(code), debt);
        inserted++;
      }
      for (let i = 0; i < inserts.length; i += 200) await db.batch(inserts.slice(i, i + 200));

      // ───── Step 6: Reset Remaining_Balance = Uploaded_Balance on pending orders ─────
      // For customers in the new file: Uploaded = Remaining = the new aggregated balance.
      // For customers MISSING from the new file but with pending orders: set both to 0
      //   so Finance cannot release them until the customer reappears.
      const updates = pendingCustomers.map(code => {
        const credit = newBalance.has(String(code)) ? (Number(newBalance.get(String(code))) || 0) : 0;
        return ['UPDATE Orders SET Uploaded_Balance = ?, Remaining_Balance = ? WHERE Code = ? AND Released = 0',
          [credit, credit, code]];
      });
      for (let i = 0; i < updates.length; i += 200) await db.batch(updates.slice(i, i + 200));

      // Save this upload's summary so we can detect duplicates next time.
      await db.run(`INSERT INTO Balance_Upload_Log
              (Uploaded_At, Uploaded_By, Cust_Count, Total_Balance, Rows_Inserted, Rows_Updated)
              VALUES (?, ?, ?, ?, ?, ?)`,
        [now, req.session.user.username, newCustCount, newTotalBalance, inserted, 0]);

      await auditIn(db, req.session.user.username, 'IMPORT_BALANCE',
        `rowsRead=${rowsRead} rowsSkipped=${rowsSkipped} uniqueCustomers=${inserted} custCount=${newCustCount} totalBalance=${newTotalBalance}`);

      return {
        rowsRead,
        rowsSkipped,
        uniqueCustomers: inserted,
        // Backwards-compat fields the frontend already displays:
        inserted, updated: 0, unchanged: 0, skipped: rowsSkipped,
        total: rows.length,
        changes: [],
        summary: { custCount: newCustCount, totalBalance: newTotalBalance }
      };
    }, { type: 'IMPORT_BALANCE', who: req.session.user.username });
    res.json({ success: true, ...result });
  } catch (e) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── Balance helpers ──────────────────────────────────────────────────────
// Logic (updated):
//   Uploaded_Balance  = the balance loaded from Excel (snapshot per pending order)
//   Remaining_Balance = the per-customer available pool, STORED on every pending
//                       order row. This is the source of truth for release.
//
// Balance import resets Remaining_Balance = Uploaded_Balance for all pending
// orders (clean slate — prior releases are forgotten because the new balance
// file already reflects them).
//
// Releasing an order: subtract Amount from Remaining_Balance of every other
// pending order of the same customer, and store the post-release value on the
// released row itself.
//
// Undoing a release: add Amount back to every other pending order of the same
// customer (still within the current balance cycle).
//
// Release allowed if: Order.Amount <= the pending order's stored Remaining_Balance

async function getCredit(db, code) {
  const row = await selectOne(db, 'SELECT Total_Debt FROM Customer_Balance WHERE Code = ?', [code]);
  return row ? Number(row.Total_Debt) || 0 : null;
}

// Used only when a brand-new pending order arrives for an existing customer:
// pick up the current Remaining_Balance the rest of that customer's pending
// orders share. If no other pending exists, fall back to the uploaded balance.
async function currentRemainingForCustomer(db, code) {
  // Existing pending order's Remaining_Balance (they all share the same value)
  const r = await selectOne(db,
    'SELECT Remaining_Balance, Uploaded_Balance FROM Orders WHERE Code = ? AND Released = 0 AND Remaining_Balance IS NOT NULL LIMIT 1',
    [code]);
  if (r && r.Remaining_Balance !== null && r.Remaining_Balance !== undefined) {
    return { remaining: Number(r.Remaining_Balance), uploaded: Number(r.Uploaded_Balance) || 0 };
  }
  const credit = await getCredit(db, code);
  if (credit === null) return null;
  return { remaining: credit, uploaded: credit };
}

// Called when new orders are imported for an existing customer: stamp the
// current pool onto the new pending rows so the table is consistent.
async function applyCurrentPoolToPending(db, code) {
  const snap = await currentRemainingForCustomer(db, code);
  if (!snap) return;
  await db.run('UPDATE Orders SET Remaining_Balance = ?, Uploaded_Balance = ? WHERE Code = ? AND Released = 0',
    [snap.remaining, snap.uploaded, code]);
}

// Backwards-compat alias used in a few places (imports, deletes).
// New orders for an existing customer must inherit the same pool; deletes
// don't change the pool so this is a no-op for them.
async function recalcRemaining(db, code) {
  await applyCurrentPoolToPending(db, code);
}

// ── Release one order ────────────────────────────────────────────────────
app.post('/api/orders/:number/release', requireRole('finance'), async (req, res) => {
  try {
    const number = req.params.number;
    const out = await withWriteDB(async db => {
      const o = await selectOne(db, 'SELECT * FROM Orders WHERE Number = ?', [number]);
      if (!o) throw new Error('Order not found');
      if (o.Released) throw new Error('Already released');

      // Source of truth: the order's STORED Remaining_Balance.
      // Fall back to the uploaded balance if (somehow) not set.
      let remaining = (o.Remaining_Balance !== null && o.Remaining_Balance !== undefined)
        ? Number(o.Remaining_Balance)
        : (o.Uploaded_Balance !== null && o.Uploaded_Balance !== undefined
            ? Number(o.Uploaded_Balance)
            : await getCredit(db, o.Code));
      if (remaining === null) throw new Error('No balance imported for this customer');

      const amount = Number(o.Amount) || 0;
      if (amount > remaining) {
        throw new Error(`Balance too low. Remaining: ${remaining.toLocaleString()}, Order amount: ${amount.toLocaleString()}`);
      }

      const now = nowIso();
      const remainingAfter = remaining - amount;

      // 1) Mark this order released. Stash the post-release pool value on the row
      //    so the UI shows what was left right after release.
      await db.run(`UPDATE Orders
              SET Released = 1, Release_Date = ?, Released_By = ?,
                  Balance_At_Release = ?, Remaining_Balance = ?, Order_Status = 'Released'
              WHERE Number = ?`,
        [now, req.session.user.username, remaining, remainingAfter, number]);

      // 2) Decrement the pool on every OTHER pending order of the same customer.
      await db.run(`UPDATE Orders
              SET Remaining_Balance = COALESCE(Remaining_Balance, ?) - ?
              WHERE Code = ? AND Released = 0`,
        [remaining, amount, o.Code]);

      await auditIn(db, req.session.user.username, 'RELEASE_ORDER',
        `Number=${number} Amount=${amount} RemainingBefore=${remaining} RemainingAfter=${remainingAfter}`);
      return { remaining_before: remaining, remaining_after: remainingAfter };
    }, { type: 'RELEASE_ORDER', who: req.session.user.username });
    res.json({ success: true, number, ...out });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// ── Undo release (only if mail not yet sent) ─────────────────────────────
app.post('/api/orders/:number/undo-release', requireRole('finance'), async (req, res) => {
  try {
    const number = req.params.number;
    await withWriteDB(async db => {
      const o = await selectOne(db, 'SELECT * FROM Orders WHERE Number = ?', [number]);
      if (!o) throw new Error('Order not found');
      if (!o.Released) throw new Error('Order is not released');
      if (o.Finance_Mail_Sent) throw new Error('Mail already sent — undo not allowed');

      const amount = Number(o.Amount) || 0;

      // 1) Add the amount back to every OTHER pending order of the same customer.
      //    Their Remaining_Balance grows by the released amount returning to the pool.
      await db.run(`UPDATE Orders
              SET Remaining_Balance = COALESCE(Remaining_Balance, 0) + ?
              WHERE Code = ? AND Released = 0`,
        [amount, o.Code]);

      // 2) Find the NEW shared pool value (any other pending order now has it).
      const peer = await selectOne(db,
        'SELECT Remaining_Balance, Uploaded_Balance FROM Orders WHERE Code = ? AND Released = 0 AND Number <> ? LIMIT 1',
        [o.Code, number]);
      // If there are no other pendings, fall back to pre-release value:
      //   the row's stored Remaining_Balance (post-release) + amount = pre-release
      const restoredRemaining = peer
        ? Number(peer.Remaining_Balance)
        : ((o.Remaining_Balance !== null && o.Remaining_Balance !== undefined)
            ? Number(o.Remaining_Balance) + amount
            : null);
      const restoredUploaded = peer ? Number(peer.Uploaded_Balance) : Number(o.Uploaded_Balance);

      // 3) Restore the row to pending with the SHARED pool value (consistent with peers).
      await db.run(`UPDATE Orders
              SET Released = 0, Release_Date = NULL, Released_By = NULL,
                  Balance_At_Release = NULL,
                  Remaining_Balance = ?, Uploaded_Balance = ?,
                  Order_Status = 'Pending'
              WHERE Number = ?`,
        [restoredRemaining, restoredUploaded, number]);

      await auditIn(db, req.session.user.username, 'UNDO_RELEASE', `Number=${number} Amount=${amount}`);
    }, { type: 'UNDO_RELEASE', who: req.session.user.username });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// ── Mark exception ───────────────────────────────────────────────────────
app.post('/api/orders/:number/exception', requireRole('finance'), async (req, res) => {
  try {
    const remark = (req.body && req.body.remark) || '';
    await withWriteDB(async db => {
      await db.run("UPDATE Orders SET Exception_Flag = 1, Exception_Remark = ?, Order_Status = 'Exception' WHERE Number = ?",
        [remark, req.params.number]);
      await auditIn(db, req.session.user.username, 'MARK_EXCEPTION', `Number=${req.params.number} Remark=${remark}`);
    }, { type: 'MARK_EXCEPTION', who: req.session.user.username });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ── Finance mail for released orders ─────────────────────────────────────
app.post('/api/orders/finance-mail', requireRole('finance'), async (req, res) => {
  try {
    const released = await read(`SELECT o.*, c.Sales_Rep_Email
                                 FROM Orders o LEFT JOIN Customers c ON o.Code = c.Code
                                 WHERE o.Released = 1 AND o.Finance_Mail_Sent = 0
                                 ORDER BY o.Release_Date, o.Number`);
    if (!released.length) return res.status(400).json({ success: false, error: 'No released orders waiting for mail' });

    const ccSet = new Set();
    released.forEach(o => { if (o.Sales_Rep_Email) ccSet.add(o.Sales_Rep_Email); });

    const attachmentRows = released.map(o => ({
      'Number':           o.Number,
      'Code':             o.Code,
      'Customer':         o.Customer,
      'Amount':           o.Amount,
      'Release Date':     o.Release_Date ? o.Release_Date.split('T')[0].split(' ')[0] : '',
      'Release':          o.Released ? 'TRUE' : 'FALSE',
      'Exception':        o.Exception_Flag ? 'TRUE' : 'FALSE',
      'Exception_Remark': o.Exception_Remark || '',
      'Remaining_Balance': o.Remaining_Balance != null ? o.Remaining_Balance : ''
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(attachmentRows), 'Released Orders');
    const stamp = Date.now();
    const attachmentPath = path.join(DRAFTS_DIR, `Released_Orders_${stamp}.xlsx`);
    XLSX.writeFile(wb, attachmentPath);

    // To = active customer-service recipients (from Email_Recipients table)
    const csEmails = await getRecipientEmails('customer_service');
    const to = csEmails.join('; ');
    if (!to) return res.status(400).json({ success: false, error: 'No Customer Service recipients configured. Ask CS to add some in Email Recipients.' });

    const total = released.reduce((s, o) => s + (Number(o.Amount) || 0), 0);
    const subject = `Released Orders - ${released.length} order(s)`;
    const body =
`Dear Customer Service,

Please find attached the list of orders released by Finance.

Summary:
  - Total released : ${released.length}
  - Total amount   : ${total.toLocaleString()}

Customers in this batch:
${[...new Set(released.map(o => `  - ${o.Code}  ${o.Customer}`))].join('\n')}

Detailed list is in the attached Excel file.

Kind regards,
${req.session.user.fullName || req.session.user.username}
Finance`;

    const emlPath = buildEml({
      to, cc: [...ccSet].join('; '), subject, body, attachmentPath, stamp, prefix: 'fin_release'
    });

    // Try to open it directly in Outlook
    const ccStr = [...ccSet].join('; ');
    const outlookResult = await openInOutlook({
      to, cc: ccStr, subject, body, attachmentPath, emlPath
    });

    const now = nowIso();
    await withWriteDB(async db => {
      const stmts = released.map(o => ['UPDATE Orders SET Finance_Mail_Sent = 1, Finance_Mail_Date = ? WHERE Number = ?', [now, o.Number]]);
      for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
      await auditIn(db, req.session.user.username, 'FIN_MAIL',
        `${released.length} orders, draft=${outlookResult.ok ? 'outlook' : (outlookResult.reason === 'not_windows' ? 'download' : 'fallback:'+outlookResult.reason)}`);
    }, { type: 'FIN_MAIL', who: req.session.user.username });

    res.json({
      success: true, count: released.length,
      to, cc: ccStr, subject,
      outlookOpened: outlookResult.ok,
      outlookMethod: outlookResult.method || null,
      // On the cloud host (Linux) Outlook can't be driven — the browser
      // downloads the .eml draft instead. That's expected, not an error.
      outlookError:  (outlookResult.ok || outlookResult.reason === 'not_windows') ? null : (outlookResult.reason || 'unknown'),
      deliveryMode:  outlookResult.ok ? 'outlook' : 'download',
      // Lets the Outlook helper on the user's PC fetch this email (15 min)
      draftToken:    outlookResult.ok ? null : createMailToken({ to, cc: ccStr, subject, body, attachmentPath, emlPath }),
      emlUrl: '/drafts/' + path.basename(emlPath),
      attachmentUrl: '/drafts/' + path.basename(attachmentPath)
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// DASHBOARD — pending orders
// ════════════════════════════════════════════════════════════════════════
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const { month, year } = req.query;
    const where = ['o.Released = 0'];
    const params = [];
    const monthNum = month ? parseInt(month, 10) : null;
    const yearNum  = year  ? parseInt(year, 10)  : null;
    if (monthNum && monthNum >= 1 && monthNum <= 12) {
      where.push("CAST(strftime('%m', o.OrderDate) AS INTEGER) = ?");
      params.push(monthNum);
    }
    if (yearNum && yearNum >= 1900 && yearNum <= 9999) {
      where.push("CAST(strftime('%Y', o.OrderDate) AS INTEGER) = ?");
      params.push(yearNum);
    }
    const rows = await read(`SELECT o.*, c.Sales_Rep,
                                    (SELECT Total_Debt FROM Customer_Balance b WHERE b.Code = o.Code) AS Credit
                             FROM Orders o LEFT JOIN Customers c ON o.Code = c.Code
                             WHERE ${where.join(' AND ')}
                             ORDER BY o.OrderDate DESC, o.Number DESC`, params);
    const totalAmount   = rows.reduce((s, o) => s + (Number(o.Amount) || 0), 0);
    const customerCount = new Set(rows.map(o => o.Code)).size;
    res.json({
      success: true,
      pendingCount: rows.length,
      pendingAmount: totalAmount,
      pendingCustomers: customerCount,
      orders: rows.slice(0, 50)
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════
// OUTLOOK .EML DRAFT BUILDER
// X-Unsent: 1 makes Outlook open the file as a NEW DRAFT (not received mail)
// ════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════
// OUTLOOK HELPER — open the email straight in Outlook on the user's PC
// ════════════════════════════════════════════════════════════════════════
// A website can't control desktop Outlook, so each PC installs a tiny
// helper once (Orderflow-Outlook-Setup.cmd — no admin rights). It registers
// the "orderflow-mail:" link type for that Windows user. When someone clicks
// Notify Finance / Send Release Mail, the browser opens
//   orderflow-mail://open/?url=<this app>/api/mail-draft/<short-lived token>
// and the helper downloads that one email and creates it in Outlook through
// Outlook automation (COM) — the same method the original local app used.
const MAIL_TOKEN_TTL_MS   = 15 * 60 * 1000;
const MAIL_TOKEN_MAX_USES = 5;
const _mailTokens = new Map();   // token -> { to, cc, subject, body, attachmentPath, emlPath, expires, uses }

function createMailToken(d) {
  const now = Date.now();
  for (const [t, e] of _mailTokens) if (e.expires < now) _mailTokens.delete(t);
  const token = crypto.randomBytes(24).toString('hex');
  _mailTokens.set(token, { ...d, expires: now + MAIL_TOKEN_TTL_MS, uses: 0 });
  return token;
}

// Read by the helper on the user's PC (no browser cookie there — the
// unguessable, short-lived token is the permission).
app.get('/api/mail-draft/:token', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const token = String(req.params.token || '');
  const e = _mailTokens.get(token);
  if (!e || e.expires < Date.now() || e.uses >= MAIL_TOKEN_MAX_USES) {
    _mailTokens.delete(token);
    return res.status(404).json({ success: false, error: 'This email link has expired. Click the email button in Orderflow again.' });
  }
  e.uses++;
  try {
    res.json({
      success: true,
      to: e.to, cc: e.cc, subject: e.subject, body: e.body,
      attachmentName:   path.basename(e.attachmentPath),
      attachmentBase64: fs.readFileSync(e.attachmentPath).toString('base64'),
      emlName:          path.basename(e.emlPath),
      emlBase64:        fs.readFileSync(e.emlPath).toString('base64')
    });
  } catch (err) {
    res.status(404).json({ success: false, error: 'This email link has expired. Click the email button in Orderflow again.' });
  }
});

// The helper only accepts links from the app address it was installed from.
function appOrigin(req) {
  const host = String(req.get('host') || '');
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return null;
  return `${req.protocol}://${host}`;
}
function outlookHelperScript(origin) {
  return fs.readFileSync(path.join(__dirname, 'outlook-helper', 'OrderflowOutlook.ps1'), 'utf8')
    .replace('__ORIGIN__', origin)
    .replace(/\r?\n/g, '\r\n');
}

// One-time setup file: double-click on the PC (no admin rights needed).
app.get('/outlook-helper/Orderflow-Outlook-Setup.cmd', (req, res) => {
  const origin = appOrigin(req);
  if (!origin) return res.status(400).type('text').send('Bad host');
  const header = fs.readFileSync(path.join(__dirname, 'outlook-helper', 'setup-header.cmd'), 'utf8').replace(/\r?\n/g, '\r\n');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="Orderflow-Outlook-Setup.cmd"');
  res.send(header + '#__HELPER__\r\n' + outlookHelperScript(origin));
});

// Same helper as a plain script (used by the copy-paste PowerShell setup).
app.get('/outlook-helper/OrderflowOutlook.ps1', (req, res) => {
  const origin = appOrigin(req);
  if (!origin) return res.status(400).type('text').send('Bad host');
  res.type('text/plain').send(outlookHelperScript(origin));
});

// Drafts are only needed for a short while after they're generated.
function cleanupDrafts(maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const f of fs.readdirSync(DRAFTS_DIR)) {
      const p = path.join(DRAFTS_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (e) {}
    }
  } catch (e) {}
}

function buildEml({ to, cc, subject, body, attachmentPath, stamp, prefix }) {
  cleanupDrafts();
  const boundary = `=_Part_${stamp}_${Math.random().toString(36).slice(2)}`;
  const attachmentName = attachmentPath ? path.basename(attachmentPath) : null;
  const attachmentB64  = attachmentPath ? fs.readFileSync(attachmentPath).toString('base64') : null;

  const lines = [];
  lines.push('X-Unsent: 1');
  lines.push(`To: ${to || ''}`);
  if (cc) lines.push(`Cc: ${cc}`);
  lines.push(`Subject: ${subject}`);
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push('');
  lines.push(`--${boundary}`);
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(body);
  if (attachmentB64) {
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="${attachmentName}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${attachmentName}"`);
    lines.push('');
    lines.push(attachmentB64.match(/.{1,76}/g).join('\n'));
  }
  lines.push('');
  lines.push(`--${boundary}--`);

  const emlPath = path.join(DRAFTS_DIR, `${prefix}_${stamp}.eml`);
  fs.writeFileSync(emlPath, lines.join('\r\n'), 'utf8');
  return emlPath;
}

// ════════════════════════════════════════════════════════════════════════
// OPEN NEW DRAFT DIRECTLY IN OUTLOOK
//
// Tries three methods in order:
//   1. Outlook COM via `New-Object -ComObject` (cleanest, works when
//      Outlook and Node run at the same elevation level)
//   2. Outlook COM via `[Activator]::CreateInstance` (alternative binding,
//      sometimes works when method 1 fails)
//   3. Open the .eml file with the default handler (Outlook opens it as
//      a new draft because of `X-Unsent: 1` header)
//
// Each attempt writes its output to a temp file so we get clean error
// messages. The draft is opened — NEVER sent automatically.
// ════════════════════════════════════════════════════════════════════════
function openInOutlook({ to, cc, subject, body, attachmentPath, emlPath }) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, reason: 'not_windows' });

    const { spawn } = require('child_process');
    const os = require('os');
    const stamp = Date.now() + '_' + Math.random().toString(36).slice(2);
    const psFile  = path.join(os.tmpdir(), `orderflow_${stamp}.ps1`);
    const logFile = path.join(os.tmpdir(), `orderflow_${stamp}.log`);

    // Escape values for PowerShell single-quoted strings (' -> '')
    const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");

    // Build a script that tries multiple methods and logs every step
    const script = `
$ErrorActionPreference = 'Continue'
$logPath = '${esc(logFile)}'
function Log($msg) { Add-Content -Path $logPath -Value $msg -Encoding UTF8 }

$attemptedMethods = @()
$success = $false

# ───── Method 1: New-Object -ComObject (the standard way) ─────
$attemptedMethods += 'COM1'
try {
  Log 'Method 1: Trying New-Object -ComObject Outlook.Application'
  $ol = New-Object -ComObject Outlook.Application
  $mail = $ol.CreateItem(0)
  $mail.To      = '${esc(to)}'
  $mail.CC      = '${esc(cc)}'
  $mail.Subject = '${esc(subject)}'
  $mail.Body    = @'
${body || ''}
'@
${attachmentPath ? `  try { $mail.Attachments.Add('${esc(attachmentPath)}') | Out-Null } catch { Log ('Attachment add failed: ' + $_.Exception.Message) }` : ''}
  $mail.Display($false)
  Log 'Method 1: SUCCESS'
  Write-Output 'OK:COM1'
  $success = $true
} catch {
  Log ('Method 1 failed: ' + $_.Exception.Message)
}

# ───── Method 2: Activator.CreateInstance ─────
if (-not $success) {
  $attemptedMethods += 'COM2'
  try {
    Log 'Method 2: Trying [Activator]::CreateInstance'
    $type = [Type]::GetTypeFromProgID('Outlook.Application')
    if ($null -eq $type) { throw 'ProgID Outlook.Application not registered' }
    $ol = [Activator]::CreateInstance($type)
    $mail = $ol.CreateItem(0)
    $mail.To      = '${esc(to)}'
    $mail.CC      = '${esc(cc)}'
    $mail.Subject = '${esc(subject)}'
    $mail.Body    = @'
${body || ''}
'@
${attachmentPath ? `    try { $mail.Attachments.Add('${esc(attachmentPath)}') | Out-Null } catch { Log ('Attachment add failed: ' + $_.Exception.Message) }` : ''}
    $mail.Display($false)
    Log 'Method 2: SUCCESS'
    Write-Output 'OK:COM2'
    $success = $true
  } catch {
    Log ('Method 2 failed: ' + $_.Exception.Message)
  }
}

# ───── Method 3: Open the .eml file with the default handler ─────
# This is the most reliable fallback. The X-Unsent header makes Outlook
# open it as a NEW DRAFT instead of a received message.
if (-not $success -and '${esc(emlPath || '')}'.Length -gt 0) {
  $attemptedMethods += 'EML'
  try {
    Log 'Method 3: Opening .eml file via default handler'
    Start-Process -FilePath '${esc(emlPath || '')}'
    Log 'Method 3: SUCCESS'
    Write-Output 'OK:EML'
    $success = $true
  } catch {
    Log ('Method 3 failed: ' + $_.Exception.Message)
  }
}

if (-not $success) {
  Log ('All methods failed. Attempted: ' + ($attemptedMethods -join ', '))
  Write-Output ('ERR: All methods failed. Attempted: ' + ($attemptedMethods -join ', '))
  exit 1
}
`;

    try {
      fs.writeFileSync(psFile, script, 'utf8');
    } catch (e) {
      return resolve({ ok: false, reason: 'cant_write_ps', detail: e.message });
    }

    // -ExecutionPolicy Bypass: ignore execution policy for this run
    // We deliberately do NOT use -NonInteractive so Outlook's first-time
    // security prompt can be answered by the user.
    const proc = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile],
      { windowsHide: true });

    let stdout = '', stderr = '';
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      // Read the log file for diagnostics, then clean up
      let log = '';
      try { log = fs.readFileSync(logFile, 'utf8'); } catch (e) {}
      try { fs.unlinkSync(psFile); } catch (e) {}
      try { fs.unlinkSync(logFile); } catch (e) {}
      // Echo log to server console so we can debug
      if (log) console.log('[Outlook]\n' + log.replace(/^/gm, '   '));
      resolve(Object.assign({ log }, result));
    };

    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('error',  e => finish({ ok: false, reason: 'spawn_error', detail: e.message }));
    proc.on('close',  code => {
      const out = stdout.trim();
      if (code === 0 && out.startsWith('OK:')) {
        const method = out.split(':')[1];
        finish({ ok: true, method });
      } else {
        const detail = (stderr || stdout || '').trim().substring(0, 500);
        finish({ ok: false, reason: detail || `exit ${code}`, detail });
      }
    });

    // Hard timeout — Outlook should respond in 5–15 seconds usually.
    // First-time COM access can take longer if Outlook needs to launch.
    setTimeout(() => {
      try { proc.kill(); } catch (e) {}
      finish({ ok: false, reason: 'timeout (60s)' });
    }, 60000);
  });
}

// ════════════════════════════════════════════════════════════════════════
// ERROR HANDLER — always answer the frontend with JSON
// ════════════════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
  if (req.file) fs.unlink(req.file.path, () => {});
  const tooBig = err && err.code === 'LIMIT_FILE_SIZE';
  if (!tooBig) console.error('  Request error:', err && err.message);
  res.status(tooBig ? 413 : 500).json({
    success: false,
    error: tooBig ? 'File is too large (max 25 MB).' : (err && err.message) || 'Server error'
  });
});

// ════════════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════════════
(async () => {
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n  Orderflow — hosted SQLite (Turso / libSQL)   v${APP_VERSION}`);
    console.log('  ───────────────────────────────────────────────────────');
    if (IS_PROD) {
      console.log(`  Listening on port ${PORT} (production)`);
    } else {
      console.log(`  Local:   http://localhost:${PORT}`);
      console.log(`  Network: http://YOUR-IP:${PORT}  (run ipconfig to find your IP)`);
    }
    console.log(`  Database: ${DB_LABEL}\n`);

    runStartup();
  });
})();
