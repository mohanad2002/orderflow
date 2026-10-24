// ============================================================================
// app.js — Frontend logic for Orderflow
// ============================================================================

let me = null;
let orderFilter = '';

// ── Global month filter (applies to all order lists) ────────────────────
const CURRENT_YEAR  = new Date().getFullYear();
const CURRENT_MONTH = new Date().getMonth() + 1;  // 1-12
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Load stored value, default to current month
let monthFilter = (() => {
  const stored = localStorage.getItem('orderflow-month-filter');
  if (stored === '') return '';                        // user previously chose "All"
  if (stored && /^\d+$/.test(stored)) {
    const n = parseInt(stored, 10);
    if (n >= 1 && n <= 12) return n;
  }
  return CURRENT_MONTH;
})();

function setMonthFilter(v) {
  if (v === '' || v === null || v === undefined) {
    monthFilter = '';
    localStorage.setItem('orderflow-month-filter', '');
  } else {
    monthFilter = parseInt(v, 10);
    localStorage.setItem('orderflow-month-filter', String(monthFilter));
  }
  // Sync all dropdowns on the page
  document.querySelectorAll('.month-filter-select').forEach(sel => {
    sel.value = monthFilter === '' ? '' : String(monthFilter);
  });
  // Re-load the visible page
  refreshCurrentPage();
}

// Build query-string params for the active filter (always uses current year)
function monthQueryParams() {
  if (!monthFilter) return {};
  return { month: String(monthFilter), year: String(CURRENT_YEAR) };
}

// Build the HTML for a month dropdown (used in every page toolbar)
function monthFilterHtml(id) {
  let opts = `<option value="">All months</option>`;
  for (let m = 1; m <= 12; m++) {
    const sel = (monthFilter === m) ? 'selected' : '';
    opts += `<option value="${m}" ${sel}>${MONTH_NAMES[m-1]} ${CURRENT_YEAR}</option>`;
  }
  return `<select id="${id}" class="month-filter-select" onchange="setMonthFilter(this.value)" title="Filter orders by month">${opts}</select>`;
}

// ── Bootstrap ────────────────────────────────────────────────────────────
(async function init() {
  try {
    const r = await fetch('/api/me', { credentials:'include' }).then(r=>r.json());
    if (!r.success) { window.location.href = '/index.html'; return; }
    me = r.user;
    renderUser();
    showRoleNav();
    showVersion(r.version);
    injectMonthDropdowns();
    loadDashboard();
    startConnectionMonitor();
    startDataSyncMonitor();
  } catch (e) {
    window.location.href = '/index.html';
  }
})();

function showVersion(v) {
  const el = document.getElementById('app-version');
  if (el && v) el.textContent = 'v' + v;
}

// ── Live data sync — polls /api/version, refreshes when other users change data ──
const SYNC_POLL_MS = 10000;        // 10 seconds
let _syncTimer  = null;
let _lastVersion = null;
let _myLastAction = 0;             // timestamp of my own last write (to suppress self-toast)

// Reload whatever's currently visible on the screen
function refreshCurrentPage() {
  const active = document.querySelector('.page.active');
  if (!active) return;
  const id = active.id;
  if (id === 'page-dashboard')   loadDashboard();
  if (id === 'page-fin-review')  loadFinReview();
  if (id === 'page-orders')      loadOrders();
  if (id === 'page-customers')   loadCustomers();
  if (id === 'page-cs-import')   loadCsActiveOrders();
  if (id === 'page-recipients')  loadRecipients();
}

function startDataSyncMonitor() {
  syncTick();  // immediate
  if (_syncTimer) clearInterval(_syncTimer);
  _syncTimer = setInterval(syncTick, SYNC_POLL_MS);

  // When user comes back to tab, do an immediate check
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncTick();
  });
}

async function syncTick() {
  if (document.hidden) return;          // pause when tab not visible
  try {
    const r = await fetch('/api/version', { credentials:'include', cache:'no-store' });
    const j = await r.json();
    if (!j.success) return;
    if (_lastVersion === null) { _lastVersion = j.version; return; }
    if (j.version === _lastVersion) return;

    _lastVersion = j.version;
    const ch = j.lastChange || {};
    const isMine = ch.who && me && ch.who === me.username && (Date.now() - _myLastAction) < 3000;

    refreshCurrentPage();

    if (!isMine) {
      const friendly = describeChange(ch);
      toast(friendly, 'success');
    }
  } catch (e) { /* network blip — try again next tick */ }
}

// Map a change type into a human-friendly message
function describeChange(ch) {
  if (!ch || !ch.type) return 'Data updated by another user';
  const who = ch.who || 'another user';
  const map = {
    IMPORT_ORDERS:      `New orders imported by ${who}`,
    CS_NOTIFY_FINANCE:  `${who} notified Finance of new orders`,
    CS_DELETE_ORDERS:   `${who} deleted orders`,
    IMPORT_BALANCE:     `Customer balances updated by ${who}`,
    RELEASE_ORDER:      `${who} released an order`,
    UNDO_RELEASE:       `${who} undid a release`,
    MARK_EXCEPTION:     `${who} marked an exception`,
    FIN_MAIL:           `${who} sent release mail`,
    IMPORT_CUSTOMERS:   `Customer list updated by ${who}`,
    RECIPIENTS_CHANGED: `Email recipients updated by ${who}`
  };
  return map[ch.type] || `Data updated by ${who}`;
}

// Mark "I just did something" so we don't toast our own change
function markMyAction() { _myLastAction = Date.now(); }

// ── Connection monitor ──────────────────────────────────────────────────
const CONN_POLL_MS = 20000;  // 20 seconds
let _connTimer = null;
let _connLast  = null;

function startConnectionMonitor() {
  checkConnection();  // immediate
  if (_connTimer) clearInterval(_connTimer);
  _connTimer = setInterval(() => checkConnection(false), CONN_POLL_MS);
}

async function checkConnection(forceUserFeedback) {
  const wrap  = document.getElementById('conn-status');
  const label = document.getElementById('conn-label');
  const meta  = document.getElementById('conn-meta');
  if (!wrap) return;

  if (forceUserFeedback) {
    wrap.classList.remove('ok','bad'); wrap.classList.add('warn');
    label.textContent = 'Checking…';
    meta.textContent  = 'Nextcloud';
  }

  try {
    const r = await fetch('/api/health', { credentials:'include', cache: 'no-store' });
    const j = await r.json();
    _connLast = j;
    wrap.classList.remove('warn');
    if (j.connected) {
      wrap.classList.add('ok');
      wrap.classList.remove('bad');
      label.textContent = 'Connected';
      meta.textContent  = `Nextcloud · ${j.latencyMs ?? '?'} ms`;
      wrap.title = `Nextcloud: ${j.host}\nFile: ${j.filename}\nLatency: ${j.latencyMs ?? '?'} ms\nLast checked: ${formatLocalTime(j.lastChecked)}\n(Click to refresh)`;
    } else {
      wrap.classList.add('bad');
      wrap.classList.remove('ok');
      label.textContent = 'Disconnected';
      meta.textContent  = j.reason || 'unreachable';
      wrap.title = `Nextcloud: ${j.host}\nFile: ${j.filename}\nReason: ${j.reason || 'unknown'}\nLast checked: ${formatLocalTime(j.lastChecked)}\n(Click to retry)`;
    }
  } catch (e) {
    wrap.classList.remove('ok','warn');
    wrap.classList.add('bad');
    label.textContent = 'Disconnected';
    meta.textContent  = 'server unreachable';
    wrap.title = `Cannot reach app server.\nLast error: ${e.message}\n(Click to retry)`;
  }
}

function formatLocalTime(iso) {
  if (!iso) return '?';
  try { return new Date(iso).toLocaleTimeString(); } catch (e) { return iso; }
}

function renderUser() {
  const initials = (me.fullName || me.username).split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase();
  document.getElementById('user-avatar').textContent = initials;
  document.getElementById('user-name').textContent  = me.fullName || me.username;
  document.getElementById('user-role').textContent  = me.role.replace('_', ' ');
}

function showRoleNav() {
  const isCS  = me.role === 'customer_service';
  const isFin = me.role === 'finance';
  document.querySelectorAll('.cs-only').forEach(el => el.style.display = isCS ? '' : 'none');
  document.querySelectorAll('.fin-only').forEach(el => el.style.display = isFin ? '' : 'none');
  if (isCS)  document.getElementById('nav-cs-label').style.display = '';
  if (isFin) document.getElementById('nav-fin-label').style.display = '';
}

// Render the month dropdown into each placeholder slot.
// Called once on bootstrap; dropdowns kept in sync via setMonthFilter().
function injectMonthDropdowns() {
  const slots = [
    ['dashboard-month-wrap', 'month-select-dashboard'],
    ['fin-month-wrap',       'month-select-fin'],
    ['orders-month-wrap',    'month-select-orders']
  ];
  for (const [slotId, selectId] of slots) {
    const wrap = document.getElementById(slotId);
    if (wrap && !wrap.firstChild) wrap.innerHTML = monthFilterHtml(selectId);
  }
}

// ── Navigation ───────────────────────────────────────────────────────────
function showPage(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  if (btn) btn.classList.add('active');

  // Lazy load per page
  if (name === 'dashboard')   loadDashboard();
  if (name === 'fin-review')  loadFinReview();
  if (name === 'orders')      loadOrders();
  if (name === 'customers')   loadCustomers();
  if (name === 'cs-import')   loadCsActiveOrders();
  if (name === 'recipients')  loadRecipients();
}

// ── Auth actions ─────────────────────────────────────────────────────────
async function doLogout() {
  await fetch('/api/logout', { method:'POST', credentials:'include' });
  window.location.href = '/index.html';
}

function changePassword() {
  document.getElementById('pw-old').value = '';
  document.getElementById('pw-new').value = '';
  document.getElementById('pw-modal').classList.add('open');
}
async function submitPassword() {
  const oldPassword = document.getElementById('pw-old').value;
  const newPassword = document.getElementById('pw-new').value;
  if (!newPassword || newPassword.length < 8) return toast('Password too short (min 8 characters)', 'error');
  try {
    const r = await api('POST', '/api/change-password', { oldPassword, newPassword });
    document.getElementById('pw-modal').classList.remove('open');
    toast('Password updated', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ── API helper ───────────────────────────────────────────────────────────
async function api(method, url, body) {
  const opts = { method, credentials:'include', headers: { 'Content-Type':'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  if (method !== 'GET') markMyAction();  // suppress self-toast on auto-refresh
  const r = await fetch(url, opts);
  const j = await readJson(r);
  if (!j.success) throw new Error(j.error || 'Request failed');
  return j;
}
// Parses a JSON reply; handles session expiry and the hosting platform's
// "waking up" / maintenance pages (which are HTML, not JSON).
async function readJson(r) {
  if (r.status === 401) { window.location.href = '/index.html'; throw new Error('Session expired — please sign in again'); }
  try { return await r.json(); }
  catch (e) { throw new Error(`Server is starting up or briefly unavailable (HTTP ${r.status}). Please try again in a moment.`); }
}
async function upload(url, file) {
  markMyAction();
  const fd = new FormData(); fd.append('file', file);
  const r = await fetch(url, { method:'POST', credentials:'include', body: fd });
  const j = await readJson(r);
  if (!j.success) {
    const err = new Error(j.error || 'Upload failed');
    err.data = j;       // attach the full payload so callers can inspect e.g. isDuplicate
    throw err;
  }
  return j;
}

// ── Toast ────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.className = '', 3500);
}

// ── Format helpers ───────────────────────────────────────────────────────
function fmt(n) {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  if (Number.isNaN(num)) return n;
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtDate(s) {
  if (!s) return '—';
  return String(s).substring(0, 10);
}
function escHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;');
}

// ════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════════════════
async function loadDashboard() {
  try {
    const qs = new URLSearchParams(monthQueryParams());
    const j = await api('GET', '/api/dashboard' + (qs.toString() ? '?' + qs.toString() : ''));
    const grid = document.getElementById('stats-grid');
    grid.innerHTML = `
      <div class="stat">
        <div class="stat-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <div class="stat-label">Pending Orders</div>
        <div class="stat-value">${j.pendingCount}</div>
      </div>
      <div class="stat">
        <div class="stat-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        </div>
        <div class="stat-label">Total Amount</div>
        <div class="stat-value">${fmt(j.pendingAmount)}</div>
      </div>
      <div class="stat">
        <div class="stat-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
        </div>
        <div class="stat-label">Customers</div>
        <div class="stat-value">${j.pendingCustomers}</div>
      </div>`;

    if (!j.orders.length) {
      document.getElementById('dashboard-table').innerHTML =
        `<div class="empty"><strong>All caught up</strong>No pending orders</div>`;
      return;
    }
    document.getElementById('dashboard-table').innerHTML = `
      <div class="table-wrap" style="margin-top:8px;">
        <table class="data-table">
          <thead><tr>
            <th>Number</th><th>Date</th><th>Code</th><th>Customer</th>
            <th style="text-align:right;">Amount</th><th>Sales Rep</th><th>Status</th>
          </tr></thead>
          <tbody>${j.orders.map(rowOrder).join('')}</tbody>
        </table>
      </div>`;
  } catch (e) { toast(e.message, 'error'); }
}

function rowOrder(o) {
  return `<tr>
    <td class="cell-mono">${escHtml(o.Number)}</td>
    <td>${fmtDate(o.OrderDate)}</td>
    <td class="cell-mono">${escHtml(o.Code)}</td>
    <td>${escHtml(o.Customer)}</td>
    <td class="cell-amount">${fmt(o.Amount)}</td>
    <td class="muted">${escHtml(o.Sales_Rep || '—')}</td>
    <td>${statusBadge(o)}</td>
  </tr>`;
}

function statusBadge(o) {
  if (o.Released && o.Finance_Mail_Sent) return `<span class="badge badge-green"><span class="badge-dot"></span>Mailed</span>`;
  if (o.Released)                         return `<span class="badge badge-blue"><span class="badge-dot"></span>Released</span>`;
  if (o.Exception_Flag)                   return `<span class="badge badge-red"><span class="badge-dot"></span>Exception</span>`;
  if (o.CS_Mail_Sent)                     return `<span class="badge badge-amber"><span class="badge-dot"></span>With Finance</span>`;
  return `<span class="badge badge-muted"><span class="badge-dot"></span>New</span>`;
}

// ════════════════════════════════════════════════════════════════════════
// CS: IMPORT ORDERS
// ════════════════════════════════════════════════════════════════════════
async function importOrders(file) {
  if (!file) return;
  const out = document.getElementById('import-orders-result');
  out.innerHTML = progressBar('Importing orders…', `Uploading ${escHtml(file.name)} (${formatFileSize(file.size)})`);
  try {
    const j = await upload('/api/orders/import', file);
    out.innerHTML = `
      <div class="card" style="background: var(--surface-2);">
        <div class="card-title" style="margin-bottom:12px;">Import complete</div>
        <div class="row" style="gap:20px;">
          <div><div class="text-sm muted">New rows</div><div style="font-size:22px; font-weight:700; color: var(--green);">${j.inserted}</div></div>
          <div><div class="text-sm muted">Duplicates ignored</div><div style="font-size:22px; font-weight:700; color: var(--amber);">${j.duplicate}</div></div>
          <div><div class="text-sm muted">Skipped</div><div style="font-size:22px; font-weight:700; color: var(--muted);">${j.skipped}</div></div>
          <div><div class="text-sm muted">Total in file</div><div style="font-size:22px; font-weight:700;">${j.total}</div></div>
        </div>
      </div>`;
    toast(`Imported ${j.inserted} new order(s)`);
    loadCsActiveOrders();  // refresh right-side list
  } catch (e) {
    out.innerHTML = `<div class="card" style="border-color: var(--red);">Error: ${escHtml(e.message)}</div>`;
  } finally {
    const el = document.getElementById('order-file');
    if (el) el.value = '';
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// ── CS Active orders list (right side of Import page) ───────────────────
let csSelected = new Set();

async function loadCsActiveOrders() {
  const tbody = document.getElementById('cs-active-table');
  if (!tbody) return;  // not on cs-import page
  const searchInp = document.getElementById('cs-active-search');
  const search = searchInp ? searchInp.value.trim() : '';
  try {
    const q = new URLSearchParams();
    q.set('status', 'pending');  // Released = 0 only
    if (search) q.set('search', search);
    const r = await fetch('/api/orders?' + q.toString(), { credentials:'include' });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);

    const rows = j.data;
    document.getElementById('cs-active-count').textContent = rows.length;

    // Drop selections that no longer exist in the list
    const existing = new Set(rows.map(o => o.Number));
    for (const n of [...csSelected]) if (!existing.has(n)) csSelected.delete(n);
    updateCsSelectionUI();

    if (!rows.length) {
      tbody.innerHTML = `<div class="empty"><strong>No active orders</strong>Import some orders or wait for Finance to release the current ones.</div>`;
      return;
    }

    tbody.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>
            <th class="cs-row-checkbox">
              <input type="checkbox" class="row-checkbox" id="cs-master-check" onchange="toggleAllCs(this.checked)" title="Select all">
            </th>
            <th>Number</th><th>Date</th><th>Code</th><th>Customer</th>
            <th style="text-align:right;">Amount</th>
            <th>Status</th>
          </tr></thead>
          <tbody>
            ${rows.map(o => `
              <tr data-number="${escAttr(o.Number)}">
                <td class="cs-row-checkbox">
                  <input type="checkbox" class="row-checkbox cs-row" data-number="${escAttr(o.Number)}"
                         ${csSelected.has(o.Number) ? 'checked' : ''}
                         onchange="toggleCsRow('${escAttr(o.Number)}', this.checked)">
                </td>
                <td class="cell-mono">${escHtml(o.Number)}</td>
                <td>${fmtDate(o.OrderDate)}</td>
                <td class="cell-mono">${escHtml(o.Code)}</td>
                <td>${escHtml(o.Customer)}</td>
                <td class="cell-amount">${fmt(o.Amount)}</td>
                <td>${statusBadge(o)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    syncMasterCheckbox();
  } catch (e) {
    tbody.innerHTML = `<div class="card" style="border-color: var(--red);">${escHtml(e.message)}</div>`;
  }
}

function toggleAllCs(checked) {
  const boxes = document.querySelectorAll('#cs-active-table .cs-row');
  boxes.forEach(b => {
    b.checked = checked;
    const n = b.getAttribute('data-number');
    if (checked) csSelected.add(n);
    else csSelected.delete(n);
  });
  updateCsSelectionUI();
}

function toggleCsRow(number, checked) {
  if (checked) csSelected.add(number);
  else csSelected.delete(number);
  syncMasterCheckbox();
  updateCsSelectionUI();
}

function syncMasterCheckbox() {
  const master = document.getElementById('cs-master-check');
  if (!master) return;
  const boxes = document.querySelectorAll('#cs-active-table .cs-row');
  if (!boxes.length) { master.checked = false; master.indeterminate = false; return; }
  const total = boxes.length;
  let checked = 0;
  boxes.forEach(b => { if (b.checked) checked++; });
  master.checked = checked === total;
  master.indeterminate = checked > 0 && checked < total;
}

function updateCsSelectionUI() {
  const btn   = document.getElementById('cs-delete-btn');
  const count = document.getElementById('cs-selected-count');
  if (count) count.textContent = csSelected.size;
  if (btn)   btn.disabled = csSelected.size === 0;
}

async function deleteSelectedOrders() {
  if (!csSelected.size) return;
  const numbers = [...csSelected];
  if (!confirm(`Delete ${numbers.length} selected order(s)?\n\nOnly orders not yet released by Finance can be deleted. Already-released ones will be skipped.`)) return;
  try {
    const j = await api('POST', '/api/orders/delete', { numbers });
    let msg = `Deleted ${j.deleted} order(s)`;
    if (j.skipped) msg += ` — ${j.skipped} skipped (already released)`;
    toast(msg, j.deleted ? 'success' : 'error');
    csSelected.clear();
    loadCsActiveOrders();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ════════════════════════════════════════════════════════════════════════
// EMAIL DRAFT — download flow (used when the server can't open Outlook,
// e.g. on the cloud host). The .eml opens in Outlook as a new draft with
// the Excel already attached, because it carries the "X-Unsent: 1" header.
// ════════════════════════════════════════════════════════════════════════
function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url; a.download = '';
  a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
}

function renderDraftDownload(out, j, what) {
  const failed = !!j.outlookError;   // a real Outlook failure (local Windows run)
  const color  = failed ? 'var(--amber)' : 'var(--green)';
  const title  = failed
    ? `⚠ Could not open Outlook automatically (${escHtml(j.outlookError)}) — draft downloaded instead`
    : '📧 Email draft downloaded';
  out.innerHTML = `
    <div class="card mt-4" style="border-color: ${color};">
      <div style="font-weight:600; color: ${color}; margin-bottom:6px;">${title}</div>
      <div class="text-sm muted">Open the downloaded <strong>.eml</strong> file — it opens in Outlook as a new draft with the Excel attached. Review it and click <strong>Send</strong>.</div>
      <div class="kv mt-2" style="display:grid; grid-template-columns:90px 1fr; gap:6px 12px; font-size:13px;">
        <b style="color:var(--muted); font-weight:500; font-size:12px;">To</b><span>${escHtml(j.to)}</span>
        <b style="color:var(--muted); font-weight:500; font-size:12px;">CC</b><span>${escHtml(j.cc || '(none)')}</span>
        <b style="color:var(--muted); font-weight:500; font-size:12px;">Subject</b><span>${escHtml(j.subject)}</span>
        <b style="color:var(--muted); font-weight:500; font-size:12px;">Orders</b><span>${j.count}</span>
      </div>
      <div class="row mt-4">
        <a class="btn btn-primary" href="${j.emlUrl}" download>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download draft again
        </a>
        <a class="btn btn-ghost" href="${j.attachmentUrl}" download>Download Excel only</a>
      </div>
    </div>`;
  triggerDownload(j.emlUrl);
  toast(`Email draft ready for ${j.count} ${what}`, 'success');
}

// ════════════════════════════════════════════════════════════════════════
// CS: NOTIFY FINANCE
// ════════════════════════════════════════════════════════════════════════
async function notifyFinance() {
  const out = document.getElementById('notify-result');
  out.innerHTML = `<div class="muted mt-4">Building email draft…</div>`;
  try {
    const j = await api('POST', '/api/orders/notify-finance');

    if (j.outlookOpened) {
      // Outlook opened directly — clean confirmation, no card
      out.innerHTML = `
        <div class="card mt-4" style="background: var(--surface-2); border-color: var(--green);">
          <div class="row" style="gap:12px; align-items:center;">
            <div style="font-size:24px;">📧</div>
            <div>
              <div style="font-weight:600; color: var(--green);">Outlook draft opened</div>
              <div class="text-sm muted">${j.count} order(s) — review the draft in Outlook and click <strong>Send</strong>.</div>
            </div>
          </div>
        </div>`;
      toast(`Outlook draft opened for ${j.count} order(s)`, 'success');
      // refresh the list since orders are now marked as "with finance"
      if (typeof loadCsActiveOrders === 'function') loadCsActiveOrders();
      return;
    }

    // Cloud host (or Outlook unavailable) — download the .eml draft
    renderDraftDownload(out, j, 'order(s)');
    if (typeof loadCsActiveOrders === 'function') loadCsActiveOrders();
  } catch (e) {
    out.innerHTML = `<div class="card mt-4" style="border-color: var(--red);">${escHtml(e.message)}</div>`;
  }
}

// ════════════════════════════════════════════════════════════════════════
// FIN: IMPORT BALANCE
// ════════════════════════════════════════════════════════════════════════
async function importBalance(file) {
  if (!file) return;
  const out = document.getElementById('import-balance-result');
  out.innerHTML = progressBar('Importing balances…', `Uploading ${escHtml(file.name)} (${formatFileSize(file.size)})`);
  try {
    const j = await upload('/api/balance/import', file);

    // Optional details table (first 50 changes)
    let changesHtml = '';
    if (j.changes && j.changes.length) {
      changesHtml = `
        <div class="card mt-4" style="background: var(--surface);">
          <div class="card-title" style="margin-bottom:8px;">What changed</div>
          <div class="card-sub" style="margin-bottom:12px;">
            ${j.changes.length === 50 ? 'Showing the first 50 changes.' : `Showing ${j.changes.length} change(s).`}
            Values shown are after sign flip (positive = customer credit, negative = customer debt).
          </div>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr>
                <th>Customer Code</th>
                <th style="text-align:right;">Previous</th>
                <th style="text-align:right;">New</th>
                <th style="text-align:right;">Difference</th>
              </tr></thead>
              <tbody>
                ${j.changes.map(ch => {
                  const diff = ch.new - (ch.old || 0);
                  const diffCls = diff > 0 ? 'pos' : diff < 0 ? 'neg' : '';
                  return `<tr>
                    <td class="cell-mono">${escHtml(ch.code)}</td>
                    <td class="cell-amount">${ch.old === null ? '—' : fmt(ch.old)}</td>
                    <td class="cell-amount">${fmt(ch.new)}</td>
                    <td class="cell-amount ${diffCls}">${diff > 0 ? '+' : ''}${fmt(diff)}</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>`;
    }

    out.innerHTML = `
      <div class="card" style="background: var(--surface-2);">
        <div class="card-title" style="margin-bottom:12px;">Balance import complete</div>
        <div class="row" style="gap:24px;">
          <div><div class="text-sm muted">Rows read from file</div><div style="font-size:22px; font-weight:700;">${j.rowsRead != null ? j.rowsRead : (j.total || 0)}</div></div>
          <div><div class="text-sm muted">Unique customers</div><div style="font-size:22px; font-weight:700; color: var(--green);">${j.uniqueCustomers != null ? j.uniqueCustomers : (j.inserted || 0)}</div></div>
          <div><div class="text-sm muted">Rows skipped</div><div style="font-size:22px; font-weight:700; color: var(--muted);">${j.rowsSkipped != null ? j.rowsSkipped : (j.skipped || 0)}</div></div>
        </div>
        ${j.summary ? `
          <div class="row mt-4" style="gap:24px; padding-top:14px; border-top: 1px solid var(--border);">
            <div><div class="text-sm muted">Summary · Cust_Count</div><div style="font-size:16px; font-weight:600; font-family: var(--mono);">${j.summary.custCount}</div></div>
            <div><div class="text-sm muted">Summary · Total Balance</div><div style="font-size:16px; font-weight:600; font-family: var(--mono);">${fmt(j.summary.totalBalance)}</div></div>
          </div>` : ''}
        <div class="text-sm muted mt-4">
          Duplicate customer codes in the raw file were aggregated (summed). The previous balance table was fully replaced.
          Remaining Balance has been reset to the new aggregated balance for all pending orders.
          Pending orders for customers not present in this file now have Remaining = 0 (release will be blocked).
        </div>
      </div>
      ${changesHtml}`;
    const rr = j.rowsRead || j.total || 0;
    const uc = j.uniqueCustomers || j.inserted || 0;
    toast(`Balance: ${rr} row(s) → ${uc} unique customer(s)`, 'success');
  } catch (e) {
    const data = e.data || {};
    if (data.isDuplicate && data.previousUpload) {
      const p = data.previousUpload;
      out.innerHTML = `
        <div class="card" style="border-color: var(--amber); background: rgba(245,158,11,.05);">
          <div style="display:flex; gap:14px; align-items:flex-start;">
            <div style="font-size:28px;">⚠️</div>
            <div style="flex:1;">
              <div class="card-title" style="color: var(--amber); margin-bottom:6px;">Duplicate Balance Upload Rejected</div>
              <div class="text-sm" style="line-height:1.6;">
                The Summary sheet of this file matches your last balance upload. To protect against accidental double-import, this file was <strong>not</strong> processed.
              </div>
              <div class="card mt-4" style="background: var(--surface);">
                <div class="card-sub" style="margin-bottom:8px;">Last successful upload</div>
                <div class="kv" style="display:grid; grid-template-columns:140px 1fr; gap:6px 12px; font-size:13px;">
                  <b style="color:var(--muted); font-weight:500;">When</b><span>${escHtml(p.uploadedAt)}</span>
                  <b style="color:var(--muted); font-weight:500;">By</b><span>${escHtml(p.uploadedBy)}</span>
                  <b style="color:var(--muted); font-weight:500;">Cust_Count</b><span class="cell-mono">${p.custCount}</span>
                  <b style="color:var(--muted); font-weight:500;">Total Balance</b><span class="cell-mono">${fmt(p.totalBalance)}</span>
                </div>
              </div>
              <div class="text-sm muted mt-4">
                If you need to upload a corrected version, edit the Summary sheet first so the values differ.
              </div>
            </div>
          </div>
        </div>`;
      toast('Duplicate upload rejected', 'error');
    } else {
      out.innerHTML = `<div class="card" style="border-color: var(--red);">${escHtml(e.message)}</div>`;
    }
  } finally {
    // Reset the input so selecting the SAME file again still fires onchange
    const el = document.getElementById('balance-file');
    if (el) el.value = '';
  }
}

// ════════════════════════════════════════════════════════════════════════
// FIN: REVIEW & RELEASE
// ════════════════════════════════════════════════════════════════════════
let finShowMailed = false;

function toggleShowMailed() {
  finShowMailed = !finShowMailed;
  const btn = document.getElementById('btn-show-mailed');
  if (btn) {
    btn.textContent = finShowMailed ? 'Hide Mailed & Released' : 'Show Mailed & Released';
    btn.classList.toggle('btn-primary', finShowMailed);
    btn.classList.toggle('btn-ghost', !finShowMailed);
  }
  loadFinReview();
}

async function loadFinReview() {
  const search = document.getElementById('fin-search').value.trim();
  const sel    = document.getElementById('fin-customer-filter');
  const code   = sel ? sel.value : '';
  try {
    // Refresh customer dropdown (so released customers fall off) ─────────
    await refreshFinCustomerDropdown(code);

    const q = new URLSearchParams();
    if (search) q.set('search', search);
    if (code)   q.set('code', code);
    if (finShowMailed) q.set('includeMailed', '1');
    const mp = monthQueryParams();
    if (mp.month) { q.set('month', mp.month); q.set('year', mp.year); }
    const r = await fetch('/api/orders?' + q.toString(), { credentials:'include' });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);

    const rows = j.data;
    if (!rows.length) {
      let msg = 'Import orders or toggle "Show Mailed & Released" to see settled orders';
      if (code) msg = 'No orders found for this customer with current filters';
      else if (finShowMailed) msg = 'Nothing to show';
      document.getElementById('fin-review-table').innerHTML =
        `<div class="empty"><strong>No orders</strong>${msg}</div>`;
      return;
    }
    document.getElementById('fin-review-table').innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>
            <th>Number</th><th>Date</th><th>Code</th><th>Customer</th>
            <th style="text-align:right;">Amount</th>
            <th style="text-align:right;">Remaining Balance</th>
            <th style="text-align:right;">Uploaded Balance</th>
            <th>Status</th><th style="width:200px;">Actions</th>
          </tr></thead>
          <tbody>
            ${rows.map(o => {
              const upClass  = Number(o.Uploaded_Balance||0)  < 0 ? 'neg' : 'pos';
              const remClass = Number(o.Remaining_Balance||0) < 0 ? 'neg' : 'pos';
              return `<tr>
                <td class="cell-mono">${escHtml(o.Number)}</td>
                <td>${fmtDate(o.OrderDate)}</td>
                <td class="cell-mono">${escHtml(o.Code)}</td>
                <td>${escHtml(o.Customer)}</td>
                <td class="cell-amount">${fmt(o.Amount)}</td>
                <td class="cell-amount ${remClass}">${o.Remaining_Balance != null ? fmt(o.Remaining_Balance) : '—'}</td>
                <td class="cell-amount ${upClass}">${o.Uploaded_Balance != null ? fmt(o.Uploaded_Balance) : '—'}</td>
                <td>${statusBadge(o)}</td>
                <td>${actionButtons(o)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (e) { toast(e.message, 'error'); }
}

// Refresh the customer dropdown to only show customers with pending orders.
// If the currently-selected customer no longer has pending orders, fall back
// to "All customers" and the table will reflect that on next load.
async function refreshFinCustomerDropdown(currentSelection) {
  const sel = document.getElementById('fin-customer-filter');
  if (!sel) return;
  try {
    const qs = new URLSearchParams(monthQueryParams());
    const r = await fetch('/api/customers/pending' + (qs.toString() ? '?' + qs.toString() : ''), { credentials:'include' });
    const j = await r.json();
    if (!j.success) return;
    const items = j.data || [];

    const stillExists = items.some(c => c.Code === currentSelection);

    sel.innerHTML =
      `<option value="">All customers with pending orders (${items.length})</option>` +
      items.map(c => {
        const label = c.Customer ? `${c.Customer} — ${c.Code}` : c.Code;
        const meta  = ` · ${c.PendingCount} order${c.PendingCount === 1 ? '' : 's'}`;
        return `<option value="${escAttr(c.Code)}">${escHtml(label + meta)}</option>`;
      }).join('');

    if (currentSelection && stillExists) {
      sel.value = currentSelection;
    } else if (currentSelection && !stillExists) {
      // Customer's orders are all released — drop the filter silently
      sel.value = '';
      // (toast omitted to avoid noise on first load; the table re-render handles it)
    }
  } catch (e) {
    // non-fatal — leave existing dropdown content as-is
  }
}

function actionButtons(o) {
  if (o.Released && o.Finance_Mail_Sent) return `<span class="muted text-sm">Mailed — locked</span>`;
  if (o.Released)
    return `<button class="btn btn-amber btn-sm" onclick="undoRelease('${o.Number}')">Undo</button>`;
  return `
    <button class="btn btn-success btn-sm" onclick="releaseOrder('${o.Number}')">Release</button>
    <button class="btn btn-ghost btn-sm" onclick="markException('${o.Number}')">Exception</button>`;
}

async function releaseOrder(number) {
  try {
    const j = await api('POST', `/api/orders/${encodeURIComponent(number)}/release`);
    toast(`Released ${number}`);
    loadFinReview();
  } catch (e) { toast(e.message, 'error'); }
}
async function undoRelease(number) {
  if (!confirm(`Undo release for order ${number}?`)) return;
  try {
    await api('POST', `/api/orders/${encodeURIComponent(number)}/undo-release`);
    toast('Release undone');
    loadFinReview();
  } catch (e) { toast(e.message, 'error'); }
}
async function markException(number) {
  const remark = prompt('Exception remark (e.g. "Order Invoiced, Delivery only"):');
  if (remark === null) return;
  try {
    await api('POST', `/api/orders/${encodeURIComponent(number)}/exception`, { remark });
    toast('Marked as exception');
    loadFinReview();
  } catch (e) { toast(e.message, 'error'); }
}

// ════════════════════════════════════════════════════════════════════════
// FIN: SEND RELEASE MAIL
// ════════════════════════════════════════════════════════════════════════
async function financeMail() {
  const out = document.getElementById('fin-mail-result');
  out.innerHTML = `<div class="muted mt-4">Building email draft…</div>`;
  try {
    const j = await api('POST', '/api/orders/finance-mail');

    if (j.outlookOpened) {
      out.innerHTML = `
        <div class="card mt-4" style="background: var(--surface-2); border-color: var(--green);">
          <div class="row" style="gap:12px; align-items:center;">
            <div style="font-size:24px;">📧</div>
            <div>
              <div style="font-weight:600; color: var(--green);">Outlook draft opened</div>
              <div class="text-sm muted">${j.count} released order(s) — review the draft in Outlook and click <strong>Send</strong>.</div>
            </div>
          </div>
        </div>`;
      toast(`Outlook draft opened for ${j.count} order(s)`, 'success');
      // refresh review list since orders are now marked as mailed
      if (typeof loadFinReview === 'function') loadFinReview();
      return;
    }

    // Cloud host (or Outlook unavailable) — download the .eml draft
    renderDraftDownload(out, j, 'released order(s)');
    if (typeof loadFinReview === 'function') loadFinReview();
  } catch (e) {
    out.innerHTML = `<div class="card mt-4" style="border-color: var(--red);">${escHtml(e.message)}</div>`;
  }
}

// ════════════════════════════════════════════════════════════════════════
// ORDERS PAGE
// ════════════════════════════════════════════════════════════════════════
function filterOrders(btn, filter) {
  document.querySelectorAll('#page-orders .tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  orderFilter = filter;
  loadOrders();
}
// ── All Orders: bulk-delete selection (CS only) ─────────────────────────
let allOrdersSelected = new Set();

function isCsRole() { return me && me.role === 'customer_service'; }

async function loadOrders() {
  try {
    const q = new URLSearchParams();
    if (orderFilter) q.set('status', orderFilter);
    // The "All" tab and "Mailed" tab should include mailed orders;
    // pending/released/unmailed already filter explicitly.
    if (orderFilter === '' || orderFilter === 'mailed') q.set('includeMailed', '1');
    const s = document.getElementById('orders-search').value.trim();
    if (s) q.set('search', s);
    const mp = monthQueryParams();
    if (mp.month) { q.set('month', mp.month); q.set('year', mp.year); }
    const r = await fetch('/api/orders?' + q.toString(), { credentials:'include' });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);

    // Drop selections no longer in the visible list
    const visibleSet = new Set(j.data.map(o => o.Number));
    for (const n of [...allOrdersSelected]) if (!visibleSet.has(n)) allOrdersSelected.delete(n);
    updateAllOrdersSelectionUI();

    if (!j.data.length) {
      document.getElementById('orders-table').innerHTML =
        `<div class="empty"><strong>No orders</strong>${orderFilter ? 'Try another filter' : 'Import some orders to get started'}</div>`;
      return;
    }
    const showCheckboxes = isCsRole();
    document.getElementById('orders-table').innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>
            ${showCheckboxes ? `<th class="cs-row-checkbox"><input type="checkbox" class="row-checkbox" id="all-orders-master-check" onchange="toggleAllAllOrders(this.checked)" title="Select all"></th>` : ''}
            <th>Number</th><th>Date</th><th>Code</th><th>Customer</th>
            <th style="text-align:right;">Amount</th>
            <th>Sales Rep</th><th>Release Date</th><th>Status</th>
          </tr></thead>
          <tbody>${j.data.map(o => `
            <tr>
              ${showCheckboxes ? `<td class="cs-row-checkbox">
                <input type="checkbox" class="row-checkbox all-orders-row" data-number="${escAttr(o.Number)}"
                       ${allOrdersSelected.has(o.Number) ? 'checked' : ''}
                       onchange="toggleAllOrdersRow('${escAttr(o.Number)}', this.checked)">
              </td>` : ''}
              <td class="cell-mono">${escHtml(o.Number)}</td>
              <td>${fmtDate(o.OrderDate)}</td>
              <td class="cell-mono">${escHtml(o.Code)}</td>
              <td>${escHtml(o.Customer)}</td>
              <td class="cell-amount">${fmt(o.Amount)}</td>
              <td class="muted text-sm">${escHtml(o.Sales_Rep || '—')}</td>
              <td>${fmtDate(o.Release_Date)}</td>
              <td>${statusBadge(o)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    syncAllOrdersMasterCheckbox();
  } catch (e) { toast(e.message, 'error'); }
}

function toggleAllAllOrders(checked) {
  const boxes = document.querySelectorAll('#orders-table .all-orders-row');
  boxes.forEach(b => {
    b.checked = checked;
    const n = b.getAttribute('data-number');
    if (checked) allOrdersSelected.add(n);
    else allOrdersSelected.delete(n);
  });
  updateAllOrdersSelectionUI();
}

function toggleAllOrdersRow(number, checked) {
  if (checked) allOrdersSelected.add(number);
  else allOrdersSelected.delete(number);
  syncAllOrdersMasterCheckbox();
  updateAllOrdersSelectionUI();
}

function syncAllOrdersMasterCheckbox() {
  const master = document.getElementById('all-orders-master-check');
  if (!master) return;
  const boxes = document.querySelectorAll('#orders-table .all-orders-row');
  if (!boxes.length) { master.checked = false; master.indeterminate = false; return; }
  let checked = 0;
  boxes.forEach(b => { if (b.checked) checked++; });
  master.checked = checked === boxes.length;
  master.indeterminate = checked > 0 && checked < boxes.length;
}

function updateAllOrdersSelectionUI() {
  const btn   = document.getElementById('all-orders-delete-btn');
  const count = document.getElementById('all-orders-selected-count');
  if (count) count.textContent = allOrdersSelected.size;
  if (btn)   btn.disabled = allOrdersSelected.size === 0;
}

async function deleteSelectedAllOrders() {
  if (!allOrdersSelected.size) return;
  const numbers = [...allOrdersSelected];

  // Find which of the selected are released, to warn the user
  const releasedCount = await (async () => {
    try {
      // Cheap path: read the visible rows from the DOM
      let n = 0;
      document.querySelectorAll('#orders-table tbody tr').forEach(tr => {
        const checkbox = tr.querySelector('.all-orders-row');
        if (!checkbox || !checkbox.checked) return;
        const badge = tr.querySelector('.badge');
        const status = badge ? badge.textContent.trim().toLowerCase() : '';
        if (status === 'released' || status === 'mailed & released') n++;
      });
      return n;
    } catch (e) { return 0; }
  })();

  let msg = `Delete ${numbers.length} selected order(s)?`;
  if (releasedCount > 0) {
    msg += `\n\n⚠ WARNING: ${releasedCount} of these are RELEASED orders that Finance has already processed. Deleting them will NOT return their amounts to the customer's remaining balance.`;
  }
  msg += `\n\nThis action cannot be undone.`;
  if (!confirm(msg)) return;

  try {
    const j = await api('POST', '/api/orders/delete', { numbers, force: true });
    let result = `Deleted ${j.deleted} order(s)`;
    if (j.deletedReleased) result += ` (${j.deletedReleased} released)`;
    if (j.skipped) result += ` — ${j.skipped} skipped`;
    toast(result, j.deleted ? 'success' : 'error');
    allOrdersSelected.clear();
    loadOrders();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ════════════════════════════════════════════════════════════════════════
// CUSTOMERS
// ════════════════════════════════════════════════════════════════════════
async function loadCustomers() {
  try {
    const r = await fetch('/api/customers', { credentials:'include' });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    if (!j.data.length) {
      document.getElementById('customers-table').innerHTML =
        `<div class="empty"><strong>No customers</strong>${me.role === 'customer_service' ? 'Click "Import Customers" above to upload your list' : 'Ask Customer Service to import the customer list'}</div>`;
      return;
    }
    document.getElementById('customers-table').innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Code</th><th>Name (EN)</th><th>Name (AR)</th><th>Sales Rep</th><th>Sales Rep Email</th></tr></thead>
          <tbody>${j.data.map(c => `
            <tr>
              <td class="cell-mono">${escHtml(c.Code)}</td>
              <td>${escHtml(c.EN_Name)}</td>
              <td style="direction:rtl; text-align:right;">${escHtml(c.AR_Name)}</td>
              <td>${escHtml(c.Sales_Rep)}</td>
              <td class="muted text-sm">${escHtml(c.Sales_Rep_Email)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (e) { toast(e.message, 'error'); }
}
async function importCustomers(file) {
  if (!file) return;
  const target = document.getElementById('customers-table');
  let previousHTML = '';
  if (target) {
    previousHTML = target.innerHTML;
    target.innerHTML = progressBar('Importing customers…', `Uploading ${escHtml(file.name)} (${formatFileSize(file.size)})`);
  }
  try {
    const j = await upload('/api/customers/import', file);
    toast(`Customers: +${j.inserted} new, ${j.updated} updated`);
    loadCustomers();
  } catch (e) {
    toast(e.message, 'error');
    if (target) target.innerHTML = previousHTML;
  } finally {
    const el = document.getElementById('cust-file');
    if (el) el.value = '';
  }
}

// ════════════════════════════════════════════════════════════════════════
// EMAIL RECIPIENTS
// ════════════════════════════════════════════════════════════════════════
async function loadRecipients() {
  const finBox = document.getElementById('recipients-finance');
  const csBox  = document.getElementById('recipients-cs');
  if (!finBox || !csBox) return;
  finBox.innerHTML = `<div class="muted">Loading…</div>`;
  csBox.innerHTML  = `<div class="muted">Loading…</div>`;
  try {
    const r = await fetch('/api/recipients', { credentials:'include' });
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    finBox.innerHTML = renderRecipientList(j.data.filter(x => x.Recipient_Type === 'finance'));
    csBox.innerHTML  = renderRecipientList(j.data.filter(x => x.Recipient_Type === 'customer_service'));
  } catch (e) {
    finBox.innerHTML = `<div class="recipient-empty" style="color:var(--red);">${escHtml(e.message)}</div>`;
    csBox.innerHTML  = '';
  }
}

function renderRecipientList(list) {
  if (!list.length) {
    return `<div class="recipient-empty">No recipients yet. Click <strong>Add Recipient</strong> above.</div>`;
  }
  const isCS = me && me.role === 'customer_service';
  return list.map(r => `
    <div class="recipient-row ${r.Active ? '' : 'inactive'}">
      <div style="flex:1;">
        <div class="r-email">${escHtml(r.Email)}</div>
        <div class="r-name">${escHtml(r.DisplayName || '—')}${r.Active ? '' : ' · inactive'}</div>
      </div>
      ${isCS ? `
        <div class="r-actions">
          <button class="icon-btn" title="${r.Active ? 'Disable' : 'Enable'}" onclick="toggleRecipientActive(${r.ID}, ${r.Active ? 'false' : 'true'})">
            ${r.Active
              ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
              : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'}
          </button>
          <button class="icon-btn" title="Edit" onclick="openEditRecipientModal(${r.ID}, '${escAttr(r.Recipient_Type)}', '${escAttr(r.Email)}', '${escAttr(r.DisplayName || '')}', ${r.Active ? 'true' : 'false'})">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
          <button class="icon-btn danger" title="Delete" onclick="deleteRecipient(${r.ID}, '${escAttr(r.Email)}')">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          </button>
        </div>` : ''}
    </div>`).join('');
}

function openAddRecipientModal() {
  document.getElementById('recipient-modal-title').textContent = 'Add Email Recipient';
  document.getElementById('recipient-id').value = '';
  document.getElementById('recipient-type').value = 'finance';
  document.getElementById('recipient-email').value = '';
  document.getElementById('recipient-name').value = '';
  document.getElementById('recipient-active').checked = true;
  document.getElementById('recipient-modal').classList.add('open');
  setTimeout(() => document.getElementById('recipient-email').focus(), 50);
}

function openEditRecipientModal(id, type, email, name, active) {
  document.getElementById('recipient-modal-title').textContent = 'Edit Email Recipient';
  document.getElementById('recipient-id').value = id;
  document.getElementById('recipient-type').value = type;
  document.getElementById('recipient-email').value = email;
  document.getElementById('recipient-name').value = name;
  document.getElementById('recipient-active').checked = !!active;
  document.getElementById('recipient-modal').classList.add('open');
}

async function saveRecipient() {
  const id    = document.getElementById('recipient-id').value;
  const type  = document.getElementById('recipient-type').value;
  const email = document.getElementById('recipient-email').value.trim();
  const name  = document.getElementById('recipient-name').value.trim();
  const active = document.getElementById('recipient-active').checked;
  if (!email) return toast('Email is required', 'error');
  try {
    if (id) {
      await api('PUT', '/api/recipients/' + id, { recipient_type: type, email, displayName: name, active });
      toast('Recipient updated');
    } else {
      await api('POST', '/api/recipients', { recipient_type: type, email, displayName: name, active });
      toast('Recipient added');
    }
    document.getElementById('recipient-modal').classList.remove('open');
    loadRecipients();
  } catch (e) { toast(e.message, 'error'); }
}

async function toggleRecipientActive(id, active) {
  try {
    await api('PUT', '/api/recipients/' + id, { active });
    loadRecipients();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteRecipient(id, email) {
  if (!confirm(`Delete recipient "${email}"?`)) return;
  try {
    await api('DELETE', '/api/recipients/' + id);
    toast('Recipient deleted');
    loadRecipients();
  } catch (e) { toast(e.message, 'error'); }
}

// ════════════════════════════════════════════════════════════════════════
// PROGRESS BAR HELPERS
// ════════════════════════════════════════════════════════════════════════
function progressBar(label, sub) {
  return `<div class="progress-card">
    <div class="row">
      <div class="progress-spinner"></div>
      <div style="flex:1;">
        <div class="label">${escHtml(label || 'Processing…')}</div>
        <div class="sub">${escHtml(sub || '')}</div>
      </div>
    </div>
    <div class="progress-bar"></div>
  </div>`;
}
