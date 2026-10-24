// ============================================================================
// Order Management App - server.js
// Connection method: SQLite via sql.js, file stored on Nextcloud (WebDAV).
// (Identical approach to the Sqlite-Employee reference app.)
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

const express       = require('express');
const cookieSession = require('cookie-session');
const multer        = require('multer');
const http          = require('http');
const https         = require('https');
const crypto        = require('crypto');
const initSqlJs     = require('sql.js');
const XLSX          = require('xlsx');
const bcrypt        = require('bcryptjs');

const pkg = require('./package.json');
const APP_VERSION = pkg.version || 'unknown';

const app     = express();
const PORT    = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// ── Nextcloud config (from environment — never hardcode credentials) ─────
const NC_HOST     = process.env.NC_HOST     || '';
const NC_TOKEN    = process.env.NC_TOKEN    || '';
const NC_PASSWORD = process.env.NC_PASSWORD || '';
const DB_FILENAME = process.env.DB_FILENAME || 'Order_App.db';
const missingEnv = ['NC_HOST', 'NC_TOKEN', 'NC_PASSWORD'].filter(k => !process.env[k] && !(k === 'NC_HOST' && process.env.NC_URL));
if (missingEnv.length) {
  console.error(`\n  Missing required setting(s): ${missingEnv.join(', ')}`);
  console.error('  → Locally: copy .env.example to .env and fill it in.');
  console.error('  → On Render: add them under the service\'s Environment tab.\n');
  process.exit(1);
}

// NC_URL is optional (testing only): e.g. http://localhost:8099
// NC_HOST may be given with or without "https://".
const NC_BASE     = new URL(process.env.NC_URL || `https://${NC_HOST.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`);
const NC_CLIENT   = NC_BASE.protocol === 'http:' ? http : https;
const NC_PATH     = `/public.php/webdav/${encodeURIComponent(DB_FILENAME)}`;

// Session signing key. On Render this is generated once and kept, so
// logins survive restarts / spin-downs. Locally a random one is fine.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET && IS_PROD)
  console.warn('  ⚠ SESSION_SECRET not set — everyone will be logged out on every restart.');
// ─────────────────────────────────────────────────────────────────────────

function ncOptions(method, extraHeaders = {}) {
  return {
    protocol: NC_BASE.protocol,
    hostname: NC_BASE.hostname,
    port:     NC_BASE.port || undefined,
    path:     NC_PATH,
    method,
    headers:  { 'Authorization': authHeader, 'OCS-APIREQUEST': 'true', ...extraHeaders }
  };
}

const LOCAL_DB   = path.resolve(__dirname, DB_FILENAME);
const UPLOAD_DIR = path.resolve(__dirname, 'uploads');
const DRAFTS_DIR = path.resolve(__dirname, 'drafts');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DRAFTS_DIR)) fs.mkdirSync(DRAFTS_DIR, { recursive: true });

const upload     = multer({ dest: UPLOAD_DIR, limits: { fileSize: 25 * 1024 * 1024 } });
const authHeader = 'Basic ' + Buffer.from(`${NC_TOKEN}:${NC_PASSWORD}`).toString('base64');

let SQL; // sql.js engine, loaded once at startup

// ════════════════════════════════════════════════════════════════════════
// IN-MEMORY DB CACHE
// ════════════════════════════════════════════════════════════════════════
// The DB file lives on Nextcloud. Without caching, every read() call
// downloads the full file (~60KB+) — that's a round trip per API call.
// Instead we keep the latest DB bytes in memory and refresh only when:
//   1) The cache is cold (server just started / first request)
//   2) A write just happened (we always upload + update cache ourselves)
//   3) The Nextcloud ETag changed (external edit detected via HEAD request)
//
// The ETag check is a lightweight HEAD request (~30–80ms vs ~300ms for
// a full GET). We only run it if the cache is older than CACHE_TTL_MS.
// With a single server, writes always update the cache immediately, so
// User A's change is visible to User B on the very next read.

const CACHE_TTL_MS = 3000; // re-check ETag at most once every 3 seconds

const dbCache = {
  data:       null,   // Buffer — the raw .db bytes
  etag:       null,   // ETag / Last-Modified header from Nextcloud
  loadedAt:   0,      // Date.now() when cache was last populated
};

// ── Raw Nextcloud I/O ─────────────────────────────────────────────────

function ncDownload() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = NC_CLIENT.request({ ...ncOptions('GET'), timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      const etag = res.headers['etag'] || res.headers['last-modified'] || null;
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), etag }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Download timed out (>30s)')));
    req.end();
  });
}

function ncHead() {
  // Returns the current ETag from Nextcloud without downloading the body.
  return new Promise((resolve) => {
    const req = NC_CLIENT.request({ ...ncOptions('HEAD'), timeout: 5000 }, (res) => {
      const etag = res.headers['etag'] || res.headers['last-modified'] || null;
      resolve({ status: res.statusCode, etag });
      res.resume();
    });
    req.on('error',   () => resolve({ status: 0, etag: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, etag: null }); });
    req.end();
  });
}

function uploadDB(data) {
  // Resolves with the new ETag Nextcloud reports (if any), so the cache
  // doesn't mistake our own upload for an external change.
  return new Promise((resolve, reject) => {
    const req = NC_CLIENT.request({
      ...ncOptions('PUT', {
        'Content-Type': 'application/octet-stream',
        'Content-Length': data.length
      }),
      timeout: 30000
    }, (res) => {
      (res.statusCode >= 200 && res.statusCode < 300)
        ? resolve(res.headers['etag'] || null)
        : reject(new Error(`Upload failed: HTTP ${res.statusCode}`));
      res.resume();
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Upload timed out (>30s)')));
    req.write(data);
    req.end();
  });
}

// ── Cache-aware DB access ─────────────────────────────────────────────

async function ensureFreshCache() {
  const now = Date.now();

  // Cold cache — must download unconditionally
  if (!dbCache.data) {
    const { buf, etag } = await ncDownload();
    fs.writeFileSync(LOCAL_DB, buf);
    dbCache.data = buf; dbCache.etag = etag; dbCache.loadedAt = now;
    return;
  }

  // Cache is warm but young — skip even the HEAD check
  if (now - dbCache.loadedAt < CACHE_TTL_MS) return;

  // Cache is old enough — do a cheap HEAD to check ETag
  const { status, etag } = await ncHead();
  if (status === 0) {
    // Network error on HEAD — use stale cache rather than failing hard
    dbCache.loadedAt = now;
    return;
  }
  if (etag && etag === dbCache.etag) {
    // ETag unchanged — Nextcloud file is the same, extend TTL
    dbCache.loadedAt = now;
    return;
  }

  // ETag changed (or Nextcloud returned no ETag) — download fresh copy
  const { buf, etag: newEtag } = await ncDownload();
  fs.writeFileSync(LOCAL_DB, buf);
  dbCache.data = buf; dbCache.etag = newEtag; dbCache.loadedAt = now;
}

// Keep downloadDB() as an alias so the startup/migration code still works
function downloadDB() { return ensureFreshCache(); }

// Lightweight connectivity check — HEAD request, no body download
function pingDB() {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = NC_CLIENT.request({ ...ncOptions('HEAD'), timeout: 5000 }, (res) => {
      const latency = Date.now() - started;
      if (res.statusCode === 200) {
        resolve({ ok: true, status: res.statusCode, latencyMs: latency, size: Number(res.headers['content-length'] || 0) });
      } else if (res.statusCode === 404) {
        resolve({ ok: false, status: 404, reason: 'File not found on Nextcloud', latencyMs: latency });
      } else if (res.statusCode === 401 || res.statusCode === 403) {
        resolve({ ok: false, status: res.statusCode, reason: 'Authentication failed', latencyMs: latency });
      } else {
        resolve({ ok: false, status: res.statusCode, reason: `HTTP ${res.statusCode}`, latencyMs: latency });
      }
      res.resume();
    });
    req.on('error',   (e) => resolve({ ok: false, reason: e.code || e.message, latencyMs: Date.now() - started }));
    req.on('timeout', ()  => { req.destroy(); resolve({ ok: false, reason: 'Timeout (>5s)', latencyMs: Date.now() - started }); });
    req.end();
  });
}

// ════════════════════════════════════════════════════════════════════════
// SQL HELPERS
// ════════════════════════════════════════════════════════════════════════
function openDB() {
  // Always open from the cache buffer if available; fall back to disk file.
  // Pass a COPY: sql.js would otherwise write straight into the cached
  // bytes, so a change whose upload failed would still look saved here.
  const buf = dbCache.data || fs.readFileSync(LOCAL_DB);
  return new SQL.Database(new Uint8Array(buf));
}

function selectAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function selectOne(db, sql, params = []) {
  const rows = selectAll(db, sql, params);
  return rows[0] || null;
}

// Read-only: ensure cache is fresh, open from cache, query, close.
// No Nextcloud GET unless the cache is cold or stale (ETag changed).
async function read(sql, params = []) {
  await ensureFreshCache();
  const db = openDB();
  try { return selectAll(db, sql, params); }
  finally { db.close(); }
}

// ── Live-sync version counter ───────────────────────────────────────────
// Bumps every time a write commits, so other browsers can detect changes.
let _dataVersion = 1;
let _lastChange  = { version: 1, type: 'startup', who: null, at: new Date().toISOString() };

function bumpVersion(type, who) {
  _dataVersion++;
  _lastChange = { version: _dataVersion, type: type || 'change', who: who || null, at: new Date().toISOString() };
}

// Read-write: ensure fresh cache, open, run callback, save, upload,
// update cache with the new bytes. Never requires a re-download.
//
// Writes are queued one at a time. Without this, two users saving at the
// same moment would both start from the same cached copy and the second
// upload would silently overwrite the first one's change.
let _writeQueue = Promise.resolve();

function withWriteDB(fn, change) {
  const run = _writeQueue.then(() => _withWriteDB(fn, change));
  _writeQueue = run.catch(() => {});   // keep the queue alive after errors
  return run;
}

async function _withWriteDB(fn, change) {
  await ensureFreshCache();
  const db = openDB();
  try {
    const result = await fn(db);
    const data = Buffer.from(db.export());
    fs.writeFileSync(LOCAL_DB, data);
    const newEtag = await uploadDB(data);
    // Update cache immediately so subsequent reads don't re-download
    dbCache.data = data; dbCache.loadedAt = Date.now();
    if (newEtag) dbCache.etag = newEtag;   // else: next HEAD fetches the real one
    if (change) bumpVersion(change.type, change.who);
    else bumpVersion('write', null);
    return result;
  } finally {
    db.close();
  }
}

// Single-statement write helper
async function write(sql, params = []) {
  return withWriteDB(db => db.run(sql, params));
}

// ════════════════════════════════════════════════════════════════════════
// AUDIT
// ════════════════════════════════════════════════════════════════════════
function nowIso() { return new Date().toISOString().replace('T', ' ').substring(0, 19); }

function auditIn(db, username, action, details) {
  db.run('INSERT INTO Audit_Log (LogDate, Username, Action, Details) VALUES (?, ?, ?, ?)',
    [nowIso(), username || '', action, details || '']);
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
// Doesn't touch Nextcloud, so it's free to call often.
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
    await withWriteDB(db => {
      for (const u of toReplace)
        db.run('UPDATE Users SET PasswordHash = ? WHERE Username = ?', [u.hash, u.username]);
      auditIn(db, 'system', 'DEFAULT_PASSWORD_REPLACED', toReplace.map(u => u.username).join(','));
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

    await withWriteDB(db => {
      const now = nowIso();
      for (const u of inserts) {
        db.run('INSERT INTO Users (Username, PasswordHash, Role, FullName, Email, Active, Created) VALUES (?,?,?,?,?,?,?)',
          [u.username, u.hash, u.role, u.fullName, u.email, 1, now]);
      }
      auditIn(db, 'system', 'SEED_USERS', `created: ${inserts.map(u => u.username).join(',')}`);
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
        postFn: (db) => {
          const pending = selectAll(db, 'SELECT DISTINCT Code FROM Orders WHERE Released = 0');
          for (const { Code } of pending) {
            const b = selectOne(db, 'SELECT Total_Debt FROM Customer_Balance WHERE Code = ?', [Code]);
            if (b) db.run('UPDATE Orders SET Uploaded_Balance = ? WHERE Code = ? AND Released = 0',
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
        postFn: (db) => {
          // Seed from existing Users table so the app keeps working immediately
          const users = selectAll(db,
            "SELECT Username, Email, Role, FullName FROM Users WHERE Email IS NOT NULL AND Email <> ''");
          const now = nowIso();
          for (const u of users) {
            const type = u.Role === 'finance' ? 'finance' : (u.Role === 'customer_service' ? 'customer_service' : null);
            if (!type) continue;
            db.run('INSERT INTO Email_Recipients (Recipient_Type, Email, DisplayName, Active, Created, Created_By) VALUES (?,?,?,?,?,?)',
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
    await withWriteDB(db => {
      for (const op of ops) {
        try {
          db.run(op.sql);
          console.log('    ✓ ' + op.label);
          if (op.postFn) op.postFn(db);
        } catch (e) {
          console.error('    ✗ ' + op.label + ' — ' + e.message);
        }
      }
      auditIn(db, 'system', 'MIGRATION', `applied: ${ops.map(o => o.label).join('; ')}`);
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
const HEALTH_CACHE_MS = 5000;  // 5-second cache; avoids hammering Nextcloud
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
    res.json({
      connected:   !!result.ok,
      status:      result.status || null,
      reason:      result.reason || null,
      latencyMs:   result.latencyMs || null,
      sizeBytes:   result.size || null,
      host:        NC_HOST,
      filename:    DB_FILENAME,
      lastChecked: new Date().toISOString()
    });
  } catch (e) {
    res.json({ connected: false, reason: e.message, lastChecked: new Date().toISOString() });
  }
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

    const result = await withWriteDB(db => {
      let inserted = 0, updated = 0, skipped = 0;
      for (const r of rows) {
        const code = (r['Customer 1C codes'] || r.Code || '').toString().trim();
        if (!code) { skipped++; continue; }
        const en   = r['EN company Name'] || r.EN_Name || '';
        const ar   = r['Ar company Name'] || r.AR_Name || '';
        const rep  = r['Sales rep']        || r.Sales_Rep || '';
        const mail = r['Sales Repr Email'] || r['Sales_Rep_Email'] || '';
        const exists = selectOne(db, 'SELECT 1 FROM Customers WHERE Code = ?', [code]);
        if (exists) {
          db.run('UPDATE Customers SET EN_Name=?, AR_Name=?, Sales_Rep=?, Sales_Rep_Email=? WHERE Code=?',
            [en, ar, rep, mail, code]);
          updated++;
        } else {
          db.run('INSERT INTO Customers (Code, EN_Name, AR_Name, Sales_Rep, Sales_Rep_Email) VALUES (?,?,?,?,?)',
            [code, en, ar, rep, mail]);
          inserted++;
        }
      }
      auditIn(db, req.session.user.username, 'IMPORT_CUSTOMERS',
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

    await withWriteDB(db => {
      db.run('INSERT INTO Email_Recipients (Recipient_Type, Email, DisplayName, Active, Created, Created_By) VALUES (?,?,?,?,?,?)',
        [recipient_type, e, (displayName || '').toString().trim(), active === false ? 0 : 1, nowIso(), req.session.user.username]);
      auditIn(db, req.session.user.username, 'RECIPIENT_ADD', `${recipient_type}: ${e}`);
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

    await withWriteDB(db => {
      db.run(`UPDATE Email_Recipients SET ${fields.join(', ')} WHERE ID = ?`, params);
      auditIn(db, req.session.user.username, 'RECIPIENT_UPDATE', `ID=${id} fields=${fields.join(',')}`);
    }, { type: 'RECIPIENTS_CHANGED', who: req.session.user.username });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Delete (CS only)
app.delete('/api/recipients/:id', requireRole('customer_service'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ success: false, error: 'Bad id' });
    await withWriteDB(db => {
      db.run('DELETE FROM Email_Recipients WHERE ID = ?', [id]);
      auditIn(db, req.session.user.username, 'RECIPIENT_DELETE', `ID=${id}`);
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
    const result = await withWriteDB(db => {
      let inserted = 0, duplicate = 0, skipped = 0;
      const touchedCodes = new Set();

      for (const r of rows) {
        const number = (r.Number || r.number || '').toString().trim();
        if (!number) { skipped++; continue; }
        const exists = selectOne(db, 'SELECT 1 FROM Orders WHERE Number = ?', [number]);
        if (exists) { duplicate++; continue; }

        let orderDate = r.Date || r.date;
        if (orderDate instanceof Date) orderDate = orderDate.toISOString().replace('T', ' ').substring(0, 19);
        else if (typeof orderDate === 'number') {
          const d = XLSX.SSF.parse_date_code(orderDate);
          if (d) orderDate = `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')} 00:00:00`;
        }

        const code = (r.Code || '').toString();
        db.run(`INSERT INTO Orders
          (Number, OrderDate, Code, Customer, Amount, Warehouse, Imported_On, Imported_By,
           Order_Status, CS_Mail_Sent, Released, Finance_Mail_Sent, Exception_Flag)
          VALUES (?,?,?,?,?,?,?,?,?,0,0,0,0)`,
          [number, orderDate || null, code, (r.Customer || '').toString(),
           Number(r.Amount) || 0, (r.Warehouse || '').toString(),
           now, req.session.user.username,
           r['State, Reserve exceeds balance'] || r.Order_Status || 'Pending']);
        inserted++;
        if (code) touchedCodes.add(code);
      }

      // Update Uploaded_Balance + Remaining_Balance on every pending order
      // of each customer who received new orders (so new rows show the right balance).
      for (const code of touchedCodes) recalcRemaining(db, code);

      auditIn(db, req.session.user.username, 'IMPORT_ORDERS',
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
    await withWriteDB(db => {
      for (const o of orders) {
        db.run('UPDATE Orders SET CS_Mail_Sent = 1, CS_Mail_Date = ? WHERE Number = ?', [now, o.Number]);
      }
      auditIn(db, req.session.user.username, 'CS_NOTIFY_FINANCE',
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

    const result = await withWriteDB(db => {
      let deleted = 0, skipped = 0, deletedReleased = 0;
      const skippedDetails = [];
      // Track which customers had a PENDING order deleted — those need
      // their pending pool recalculated. Released-order deletions don't
      // affect the pool (we deliberately keep Remaining as-is).
      const touchedCodesPending = new Set();

      for (const num of numbers) {
        const o = selectOne(db, 'SELECT Number, Code, Released FROM Orders WHERE Number = ?', [num]);
        if (!o) { skipped++; skippedDetails.push({ number: num, reason: 'not found' }); continue; }

        if (o.Released && !force) {
          skipped++;
          skippedDetails.push({ number: num, reason: 'already released by Finance' });
          continue;
        }

        db.run('DELETE FROM Orders WHERE Number = ?', [num]);
        deleted++;
        if (o.Released) deletedReleased++;
        else if (o.Code) touchedCodesPending.add(o.Code);
      }

      // Only refresh pending pool for customers whose PENDING orders changed.
      // For released deletions we leave Remaining_Balance untouched (per spec).
      for (const code of touchedCodesPending) recalcRemaining(db, code);

      auditIn(db, req.session.user.username, force ? 'CS_DELETE_ORDERS_FORCE' : 'CS_DELETE_ORDERS',
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
    const result = await withWriteDB(db => {
      // Remember which customers had pending orders BEFORE we wipe the table,
      // so we can update their Remaining/Uploaded values afterward.
      const pendingCustomers = selectAll(db, 'SELECT DISTINCT Code FROM Orders WHERE Released = 0').map(r => r.Code);

      // Wipe the previous balance entries entirely.
      db.run('DELETE FROM Customer_Balance');

      // Insert one row per unique customer (sign flipped: negative debt → positive credit).
      let inserted = 0;
      for (const [code, rawTotal] of aggregated.entries()) {
        const debt = -rawTotal;   // sign flip
        db.run('INSERT INTO Customer_Balance (Code, Total_Debt, Updated) VALUES (?, ?, ?)',
          [code, debt, now]);
        inserted++;
      }

      // ───── Step 6: Reset Remaining_Balance = Uploaded_Balance on pending orders ─────
      // For customers in the new file: Uploaded = Remaining = the new aggregated balance.
      // For customers MISSING from the new file but with pending orders: set both to 0
      //   so Finance cannot release them until the customer reappears.
      for (const code of pendingCustomers) {
        const b = selectOne(db, 'SELECT Total_Debt FROM Customer_Balance WHERE Code = ?', [code]);
        const credit = b ? (Number(b.Total_Debt) || 0) : 0;
        db.run('UPDATE Orders SET Uploaded_Balance = ?, Remaining_Balance = ? WHERE Code = ? AND Released = 0',
          [credit, credit, code]);
      }

      // Save this upload's summary so we can detect duplicates next time.
      db.run(`INSERT INTO Balance_Upload_Log
              (Uploaded_At, Uploaded_By, Cust_Count, Total_Balance, Rows_Inserted, Rows_Updated)
              VALUES (?, ?, ?, ?, ?, ?)`,
        [now, req.session.user.username, newCustCount, newTotalBalance, inserted, 0]);

      auditIn(db, req.session.user.username, 'IMPORT_BALANCE',
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

function getCredit(db, code) {
  const row = selectOne(db, 'SELECT Total_Debt FROM Customer_Balance WHERE Code = ?', [code]);
  return row ? Number(row.Total_Debt) || 0 : null;
}

// Used only when a brand-new pending order arrives for an existing customer:
// pick up the current Remaining_Balance the rest of that customer's pending
// orders share. If no other pending exists, fall back to the uploaded balance.
function currentRemainingForCustomer(db, code) {
  // Existing pending order's Remaining_Balance (they all share the same value)
  const r = selectOne(db,
    'SELECT Remaining_Balance, Uploaded_Balance FROM Orders WHERE Code = ? AND Released = 0 AND Remaining_Balance IS NOT NULL LIMIT 1',
    [code]);
  if (r && r.Remaining_Balance !== null && r.Remaining_Balance !== undefined) {
    return { remaining: Number(r.Remaining_Balance), uploaded: Number(r.Uploaded_Balance) || 0 };
  }
  const credit = getCredit(db, code);
  if (credit === null) return null;
  return { remaining: credit, uploaded: credit };
}

// Called when new orders are imported for an existing customer: stamp the
// current pool onto the new pending rows so the table is consistent.
function applyCurrentPoolToPending(db, code) {
  const snap = currentRemainingForCustomer(db, code);
  if (!snap) return;
  db.run('UPDATE Orders SET Remaining_Balance = ?, Uploaded_Balance = ? WHERE Code = ? AND Released = 0',
    [snap.remaining, snap.uploaded, code]);
}

// Backwards-compat alias used in a few places (imports, deletes).
// New orders for an existing customer must inherit the same pool; deletes
// don't change the pool so this is a no-op for them.
function recalcRemaining(db, code) {
  applyCurrentPoolToPending(db, code);
}

// ── Release one order ────────────────────────────────────────────────────
app.post('/api/orders/:number/release', requireRole('finance'), async (req, res) => {
  try {
    const number = req.params.number;
    const out = await withWriteDB(db => {
      const o = selectOne(db, 'SELECT * FROM Orders WHERE Number = ?', [number]);
      if (!o) throw new Error('Order not found');
      if (o.Released) throw new Error('Already released');

      // Source of truth: the order's STORED Remaining_Balance.
      // Fall back to the uploaded balance if (somehow) not set.
      let remaining = (o.Remaining_Balance !== null && o.Remaining_Balance !== undefined)
        ? Number(o.Remaining_Balance)
        : (o.Uploaded_Balance !== null && o.Uploaded_Balance !== undefined
            ? Number(o.Uploaded_Balance)
            : getCredit(db, o.Code));
      if (remaining === null) throw new Error('No balance imported for this customer');

      const amount = Number(o.Amount) || 0;
      if (amount > remaining) {
        throw new Error(`Balance too low. Remaining: ${remaining.toLocaleString()}, Order amount: ${amount.toLocaleString()}`);
      }

      const now = nowIso();
      const remainingAfter = remaining - amount;

      // 1) Mark this order released. Stash the post-release pool value on the row
      //    so the UI shows what was left right after release.
      db.run(`UPDATE Orders
              SET Released = 1, Release_Date = ?, Released_By = ?,
                  Balance_At_Release = ?, Remaining_Balance = ?, Order_Status = 'Released'
              WHERE Number = ?`,
        [now, req.session.user.username, remaining, remainingAfter, number]);

      // 2) Decrement the pool on every OTHER pending order of the same customer.
      db.run(`UPDATE Orders
              SET Remaining_Balance = COALESCE(Remaining_Balance, ?) - ?
              WHERE Code = ? AND Released = 0`,
        [remaining, amount, o.Code]);

      auditIn(db, req.session.user.username, 'RELEASE_ORDER',
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
    await withWriteDB(db => {
      const o = selectOne(db, 'SELECT * FROM Orders WHERE Number = ?', [number]);
      if (!o) throw new Error('Order not found');
      if (!o.Released) throw new Error('Order is not released');
      if (o.Finance_Mail_Sent) throw new Error('Mail already sent — undo not allowed');

      const amount = Number(o.Amount) || 0;

      // 1) Add the amount back to every OTHER pending order of the same customer.
      //    Their Remaining_Balance grows by the released amount returning to the pool.
      db.run(`UPDATE Orders
              SET Remaining_Balance = COALESCE(Remaining_Balance, 0) + ?
              WHERE Code = ? AND Released = 0`,
        [amount, o.Code]);

      // 2) Find the NEW shared pool value (any other pending order now has it).
      const peer = selectOne(db,
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
      db.run(`UPDATE Orders
              SET Released = 0, Release_Date = NULL, Released_By = NULL,
                  Balance_At_Release = NULL,
                  Remaining_Balance = ?, Uploaded_Balance = ?,
                  Order_Status = 'Pending'
              WHERE Number = ?`,
        [restoredRemaining, restoredUploaded, number]);

      auditIn(db, req.session.user.username, 'UNDO_RELEASE', `Number=${number} Amount=${amount}`);
    }, { type: 'UNDO_RELEASE', who: req.session.user.username });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

// ── Mark exception ───────────────────────────────────────────────────────
app.post('/api/orders/:number/exception', requireRole('finance'), async (req, res) => {
  try {
    const remark = (req.body && req.body.remark) || '';
    await withWriteDB(db => {
      db.run("UPDATE Orders SET Exception_Flag = 1, Exception_Remark = ?, Order_Status = 'Exception' WHERE Number = ?",
        [remark, req.params.number]);
      auditIn(db, req.session.user.username, 'MARK_EXCEPTION', `Number=${req.params.number} Remark=${remark}`);
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
    await withWriteDB(db => {
      for (const o of released) {
        db.run('UPDATE Orders SET Finance_Mail_Sent = 1, Finance_Mail_Date = ? WHERE Number = ?', [now, o.Number]);
      }
      auditIn(db, req.session.user.username, 'FIN_MAIL',
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
  SQL = await initSqlJs();

  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n  Orderflow — SQLite (sql.js) + Nextcloud sync   v${APP_VERSION}`);
    console.log('  ───────────────────────────────────────────────────────');
    if (IS_PROD) {
      console.log(`  Listening on port ${PORT} (production)`);
    } else {
      console.log(`  Local:   http://localhost:${PORT}`);
      console.log(`  Network: http://YOUR-IP:${PORT}  (run ipconfig to find your IP)`);
    }
    console.log(`  Nextcloud: ${NC_BASE.host}  →  ${DB_FILENAME}\n`);

    // Startup tasks need Nextcloud. If it's briefly unreachable (common on a
    // cloud cold start), keep retrying instead of running half-initialised.
    const startup = async (attempt = 1) => {
      console.log(`  Testing Nextcloud connection...${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      try {
        await downloadDB();
        const db = openDB();
        const rows = selectAll(db, 'SELECT COUNT(*) AS c FROM Users');
        db.close();
        console.log(`  Connected — ${rows[0].c} user(s) currently in the database.`);
        await runMigrations();
        await ensureDefaultUsers();
        await replaceDefaultPasswords();
        console.log('  Ready.\n');
      } catch (e) {
        console.error('  Nextcloud connection FAILED:', e.message);
        console.error('  → Check NC_HOST / NC_TOKEN / NC_PASSWORD, and that the file exists at:');
        console.error(`     ${NC_BASE.origin}${NC_PATH}`);
        console.error('  Retrying in 30 seconds...\n');
        setTimeout(() => startup(attempt + 1), 30000);
      }
    };
    startup();
  });
})();
