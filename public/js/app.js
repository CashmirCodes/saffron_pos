// ---------- Bootstrap / guard ----------
if (!Api.getToken()) {
  window.location.href = 'login.html';
}
const CURRENT_USER = Api.getUser();
if (CURRENT_USER && CURRENT_USER.role === 'platform') {
  window.location.href = 'platform.html';
}

// Company Preferences cache -- loaded once at boot (below) and refreshed
// whenever the Preferences screen is viewed or saved. Read by helpers like
// settingBool()/confirmGuarded() from anywhere in the app, and directly by
// the Sale screen (discounts) and receipt (custom message).
let COMPANY_SETTINGS = {};
function settingBool(key, def) {
  const v = COMPANY_SETTINGS[key];
  return v == null ? def : v === '1';
}
// Gate an edit or delete action behind the company's "Warn when editing" /
// "Warn when deleting" preferences (Company Preferences > General). When the
// relevant warning is turned off, the action proceeds without a dialog.
function confirmGuarded(kind, message) {
  const key = kind === 'edit' ? 'warn_on_edit' : 'warn_on_delete';
  if (!settingBool(key, true)) return true;
  return confirm(message);
}

const content = document.getElementById('content');
const sidebar = document.getElementById('sidebar');
const userBadge = document.getElementById('userBadge');
const storeNameEl = document.getElementById('storeName');
const syncBadge = document.getElementById('syncBadge');
const clockEl = document.getElementById('clock');
const avatarEl = document.getElementById('avatarInitial');

userBadge.textContent = `${CURRENT_USER.full_name} (${CURRENT_USER.role})`;
if (avatarEl) avatarEl.textContent = (CURRENT_USER.full_name || '?').trim().charAt(0).toUpperCase();

if (CURRENT_USER.role !== 'admin') {
  document.querySelectorAll('[data-admin-only]').forEach((el) => el.remove());
}

document.getElementById('logoutBtn').addEventListener('click', () => {
  Api.clear();
  window.location.href = 'login.html';
});

const sidebarBackdrop = document.getElementById('sidebarBackdrop');
function setSidebarOpen(open) {
  sidebar.classList.toggle('open', open);
  if (sidebarBackdrop) sidebarBackdrop.classList.toggle('show', open);
}
document.getElementById('navToggle').addEventListener('click', () => setSidebarOpen(!sidebar.classList.contains('open')));
document.getElementById('sidebarClose').addEventListener('click', () => setSidebarOpen(false));
document.getElementById('tabMore').addEventListener('click', () => setSidebarOpen(true));
if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setSidebarOpen(false); });

function updateClock() {
  clockEl.textContent = new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
updateClock();
setInterval(updateClock, 30000);

function updateSyncBadge() {
  syncBadge.classList.toggle('offline', !navigator.onLine);
  syncBadge.querySelector('.sync-text').textContent = navigator.onLine ? 'Online' : 'Offline';
  syncBadge.title = navigator.onLine ? 'Online' : 'No internet connection -- this app needs one to reach the database';
}
updateSyncBadge();
window.addEventListener('online', updateSyncBadge);
window.addEventListener('offline', updateSyncBadge);

Api.get('/api/settings').then((s) => {
  if (s.store_name) storeNameEl.textContent = s.store_name;
}).catch(() => {});

// ---------- Router ----------
const VIEWS = {
  home: renderHome,
  sale: renderSale,
  receive: renderReceive,
  inventory: renderInventory,
  customers: renderCustomers,
  departments: renderDepartments,
  reports: renderReports,
  eod: renderEndOfDay,
  employees: renderEmployees,
  settings: renderSettings,
  heldReceipts: renderHeldReceipts,
  customerOrders: renderCustomerOrders,
  rewards: renderRewardManager,
  vendors: renderVendors,
  purchaseOrders: renderPurchaseOrders,
  receivingHistory: renderReceivingHistory,
  clockInOut: renderClockInOut,
  physicalInventory: renderPhysicalInventory,
  physicalInventoryHistory: renderPhysicalInventoryHistory,
  tools: renderTools,
  printDesigner: renderPrintDesigner
};

function setActiveNav(view) {
  document.querySelectorAll('.nav-item, .tab-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  // Views without their own tab (Receive Items, Reports, ...) light up "More".
  document.getElementById('tabMore').classList.toggle('active', !document.querySelector(`.tab-item[data-view="${view}"]`));
}

// A search typed in the top bar gets "handed off" to whichever view we land
// on -- set here, then applied once that view has actually finished
// rendering (instead of guessing with a fixed timeout, which broke whenever
// the view's data took longer than expected to load).
let pendingSearch = null;

// Page-to-page transition: the outgoing view slides/fades out, THEN (once
// that's finished) the new view loads and slides/fades in. A navToken guards
// against rapid clicks -- if the user taps three views in a row, only the
// most recent one is allowed to actually finish landing.
const VIEW_EXIT_MS = 140;
let navToken = 0;

function navigate(view) {
  if (!VIEWS[view]) view = 'sale';
  const myToken = ++navToken;
  setActiveNav(view);
  setSidebarOpen(false);

  const swapIn = () => {
    if (myToken !== navToken) return; // a newer navigation superseded this one
    content.classList.remove('view-exit', 'view-enter');
    content.innerHTML = '<div class="empty-state">Loading&hellip;</div>';
    VIEWS[view]().then(() => {
      if (myToken !== navToken) return;
      // Retrigger the fade/slide-in animation for the freshly rendered view.
      void content.offsetWidth;
      content.classList.add('view-enter');
      if (pendingSearch && pendingSearch.view === view) {
        const input = document.getElementById(pendingSearch.inputId);
        if (input) {
          input.value = pendingSearch.q;
          input.dispatchEvent(new Event('input'));
          input.focus();
        }
        pendingSearch = null;
      }
    }).catch((err) => {
      if (myToken !== navToken) return;
      content.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
      toast(err.message, 'error');
    });
  };

  if (content.children.length) {
    // Play the exit transition on whatever's currently on screen, then swap.
    content.classList.remove('view-enter');
    void content.offsetWidth;
    content.classList.add('view-exit');
    setTimeout(swapIn, VIEW_EXIT_MS);
  } else {
    swapIn();
  }
}

document.querySelectorAll('.nav-item[data-view], .tab-item[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => navigate(btn.dataset.view));
});

// ---------- Global search (top bar) ----------
// Checks items and customers and jumps to whichever list actually has
// matches (falling back to Item List if neither or both do).
async function performGlobalSearch(q) {
  let productMatches = [];
  let customerMatches = [];
  try {
    [productMatches, customerMatches] = await Promise.all([
      Api.get(`/api/products?q=${encodeURIComponent(q)}`).catch(() => []),
      Api.get(`/api/customers?q=${encodeURIComponent(q)}`).catch(() => [])
    ]);
  } catch (e) { /* fall through to the inventory default below */ }

  if (productMatches.length === 0 && customerMatches.length > 0) {
    pendingSearch = { view: 'customers', inputId: 'custSearch', q };
    navigate('customers');
  } else if (productMatches.length === 0 && customerMatches.length === 0) {
    pendingSearch = { view: 'inventory', inputId: 'invSearch', q };
    navigate('inventory');
    toast(`No items or customers matched "${q}".`, '');
  } else {
    pendingSearch = { view: 'inventory', inputId: 'invSearch', q };
    navigate('inventory');
  }
}

const globalSearchInput = document.getElementById('globalSearch');
if (globalSearchInput) {
  globalSearchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const q = globalSearchInput.value.trim();
    if (!q) return;
    performGlobalSearch(q);
  });
}

// ---------- Helpers ----------
const PESO_FORMATTER = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
function money(n) { return PESO_FORMATTER.format(Number(n) || 0); }
// Rounds a quantity to 3 decimal places and normalizes -0 to 0 -- used
// anywhere a raw DOUBLE PRECISION qty needs to display cleanly.
function fmtQty(n) {
  const r = Math.round(Number(n) * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

// Reports / history screens all share this exact date-range control, so it
// looks and behaves identically everywhere. Pair with wireDateRangePreset().
function dateRangeBarHtml({ presetId, fromId, toId, applyId, includeAll, preset = '', from = '', to = '', applyLabel = 'Apply' }) {
  return `
    <div class="range-bar">
      <select id="${presetId}" aria-label="Date range">${dateRangePresetOptions(includeAll, preset)}</select>
      <div class="range-dates">
        <label class="range-field"><span class="range-label">From</span><input type="date" id="${fromId}" value="${from}" aria-label="From date" /></label>
        <span class="range-sep">to</span>
        <label class="range-field"><span class="range-label">To</span><input type="date" id="${toId}" value="${to}" aria-label="To date" /></label>
      </div>
      <button type="button" class="btn btn-primary" id="${applyId}">${applyLabel}</button>
    </div>`;
}

// Opens a plain, self-contained print window for any generated document
// (receiving vouchers, worksheets, reports, ...) and triggers the browser's
// print dialog once it has rendered. Shared by anything in the app that
// needs to print something other than the on-screen UI.
// `autoPrint: false` opens the same window and lays out the same content,
// but skips the automatic browser print dialog and shows a "Print" button
// instead -- lets someone review exactly what's about to come out (e.g.
// which/how many tags) before committing to paper.
// `margin` sets BOTH the on-screen preview padding and the actual printed
// page margin (via @page) -- a thrifty person can shrink this toward 0 to
// reclaim page space, or grow it back up, from the Print Designer.
function openPrintDoc(title, bodyHtml, { autoPrint = true, margin = DEFAULT_PRINT_MARGIN } = {}) {
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) { toast('Your browser blocked the print window. Please allow pop-ups for this site.', 'error'); return; }
  const m = Math.max(0, Number(margin) || 0);
  // Closes up any blank space left by variable-height content (item
  // tables, etc.) before it ever hits the page -- see compactCanvasHtml().
  win.document.write(`
    <!DOCTYPE html><html><head><title>${escapeHtml(title)}</title>
    <style>
      @page { margin: ${m}px; }
      body { font-family: Arial, sans-serif; padding: ${m}px; color: #1a1a1a; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; }
      th, td { padding: 4px; }
      .no-print-bar { text-align:right; margin-bottom:16px; }
      .no-print-bar button { padding:8px 18px; font-size:14px; font-weight:600; cursor:pointer; border-radius:6px; border:1px solid #ccc; background:#f7b733; }
      @media print { body { padding: 0; } .no-print-bar { display:none; } }
    </style>
    </head><body>
      ${autoPrint ? '' : `<div class="no-print-bar"><button onclick="window.print()">\u{1F5A8} Print</button></div>`}
      ${compactCanvasHtml(bodyHtml)}
    </body></html>
  `);
  win.document.close();
  if (autoPrint) win.onload = () => { win.focus(); win.print(); };
  else win.focus();
}

// Opens a camera modal that reads a barcode (or a self-printed Item Number
// tag, which is just printed as a barcode too) straight out of the live
// video feed -- backed by the html5-qrcode library loaded in index.html.
// Calls onResult(decodedText) once and closes itself; the caller treats
// that text exactly like a typed/scanner-gun barcode (same exact-match
// lookup already used on Enter in every search box).
function openBarcodeScanner(onResult) {
  if (typeof Html5Qrcode === 'undefined') {
    toast("Barcode scanning isn't available right now (camera library failed to load). Check your connection and try again.", 'error');
    return;
  }
  const readerId = 'barcodeScannerReader';
  const overlay = openModal(`
    <h2>${icon('camera', 18)} Scan Barcode</h2>
    <p class="note">Point the camera at a barcode or Item Number tag.</p>
    <div id="${readerId}" class="scanner-reader"></div>
    <div class="modal-actions">
      <button type="button" class="btn" id="scannerCancelBtn">Cancel</button>
    </div>
  `);

  let scanner = null;
  let stopped = false;

  async function stopScanner() {
    if (stopped || !scanner) return;
    stopped = true;
    try { await scanner.stop(); } catch (e) { /* already stopped */ }
    try { scanner.clear(); } catch (e) { /* already cleared */ }
  }

  overlay.querySelector('#scannerCancelBtn').addEventListener('click', async () => {
    await stopScanner();
    overlay.remove();
  });
  // openModal already closes on backdrop click -- also stop the camera so
  // it doesn't keep running (and the camera light on) after the modal's gone.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) stopScanner(); });

  scanner = new Html5Qrcode(readerId);
  scanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 250, height: 150 } },
    async (decodedText) => {
      await stopScanner();
      overlay.remove();
      onResult(decodedText);
    },
    () => { /* per-frame "no code found yet" -- expected while aiming, ignore */ }
  ).catch(() => {
    toast('Could not access the camera. Check your browser/device permissions and try again.', 'error');
    overlay.remove();
  });
}

// Shared by the "Scan" button on every item-search box (Make a Sale,
// Receive Items, Purchase Order): opens the camera, and on a decoded code
// tries an exact barcode/SKU/item-number match (same priority the Enter key
// already uses) -- add it straight away if found, otherwise drop the code
// into the search box so the person can see the closest matches themselves.
function scanBarcodeInto(products, searchInput, matchesFor, drawSuggestions, addFn) {
  openBarcodeScanner((code) => {
    const q = code.trim().toLowerCase();
    const exact = products.find((p) => (p.barcode || '').toLowerCase() === q || (p.sku || '').toLowerCase() === q || (p.item_number || '').toLowerCase() === q);
    if (exact) {
      addFn(exact);
      toast(`Added ${exact.name}.`, 'success');
    } else {
      searchInput.value = code;
      drawSuggestions(matchesFor(code));
      toast("No exact match for that code -- showing closest matches.", '');
    }
  });
}

// ---------- Icon set (small inline SVGs -- no emoji) ----------
const ICON_PATHS = {
  clipboard: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 11h6M9 15h6"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z"/><path d="M9 8h6M9 12h6"/>',
  barChart: '<path d="M4 20V10M10 20V4M16 20v-7"/><path d="M2 20h20"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  pauseCircle: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/>',
  gift: '<rect x="3" y="8" width="18" height="13" rx="1"/><path d="M3 12h18"/><path d="M12 8v13"/><path d="M12 8c-1.5-4-6-4-6-1s3 1 6 1Z"/><path d="M12 8c1.5-4 6-4 6-1s-3 1-6 1Z"/>',
  fileText: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/>',
  inbox: '<path d="M4 12h4l2 3h4l2-3h4"/><path d="M4 12 6 4h12l2 8"/><path d="M4 12v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5Z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
  truck: '<rect x="1" y="7" width="13" height="10" rx="1"/><path d="M14 10h4l3 3v4h-3"/><circle cx="6" cy="19" r="1.6"/><circle cx="16.5" cy="19" r="1.6"/>',
  folder: '<path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/><circle cx="17" cy="8.5" r="2.6"/><path d="M15.5 14.6c2.6.4 4.7 2.2 5 5.4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1c.6.5 1.3.9 2 1.2L10 21h4l.5-2.6c.7-.3 1.4-.7 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M10 11v6M14 11v6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  columns: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="9.5" y="4" width="5" height="16" rx="1"/><rect x="16" y="4" width="5" height="16" rx="1"/>',
  printer: '<path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="8" rx="1.5"/><rect x="6" y="15" width="12" height="6" rx="1"/><circle cx="17.5" cy="12" r="0.8" fill="currentColor" stroke="none"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/>',
  gripVertical: '<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
  camera: '<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/>'
};
function icon(name, size = 18) {
  const path = ICON_PATHS[name] || ICON_PATHS.box;
  return `<svg class="icon" viewBox="0 0 24 24" style="width:${size}px;height:${size}px;">${path}</svg>`;
}

// ---------- Monogram avatars (used instead of emoji/stock photos) ----------
const AVATAR_PALETTE = [
  { bg: '#FFF3D6', fg: '#B9800A' },
  { bg: '#FFE3D6', fg: '#C2532A' },
  { bg: '#E4F2E0', fg: '#3D7A2E' },
  { bg: '#E1ECFB', fg: '#2A5FA8' },
  { bg: '#F3E3FB', fg: '#7A3AA8' },
  { bg: '#FDE3EC', fg: '#B8305C' }
];
function avatarFor(id) {
  return AVATAR_PALETTE[Math.abs(Number(id) || 0) % AVATAR_PALETTE.length];
}
function initialsFor(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

// ---------- Item List column customization (per-workstation preference) ----------
const INVENTORY_COLUMNS = [
  { key: 'item_number', label: 'Item Number', render: (p) => escapeHtml(p.item_number || '—'), sortValue: (p) => p.item_number || '' },
  { key: 'name', label: 'Item Name', render: (p) => escapeHtml(p.name), sortValue: (p) => p.name || '' },
  { key: 'sku', label: 'SKU', render: (p) => escapeHtml(p.sku || '—'), sortValue: (p) => p.sku || '' },
  { key: 'barcode', label: 'Barcode', render: (p) => escapeHtml(p.barcode || '—'), sortValue: (p) => p.barcode || '' },
  { key: 'category_name', label: 'Category', render: (p) => escapeHtml(p.category_name || '—'), sortValue: (p) => p.category_name || '' },
  { key: 'price', label: 'Price', render: (p) => money(p.price), sortValue: (p) => Number(p.price) || 0 },
  { key: 'cost', label: 'Cost', render: (p) => money(p.cost), sortValue: (p) => Number(p.cost) || 0 },
  { key: 'order_cost', label: 'Order Cost', render: (p) => money(p.order_cost), sortValue: (p) => Number(p.order_cost) || 0 },
  { key: 'qty_on_hand', label: 'Stock', render: (p) => String(p.qty_on_hand), sortValue: (p) => Number(p.qty_on_hand) || 0 },
  { key: 'reorder_level', label: 'Reorder Level', render: (p) => String(p.reorder_level), sortValue: (p) => Number(p.reorder_level) || 0 },
  {
    key: 'status', label: 'Status',
    render: (p) => (p.qty_on_hand <= p.reorder_level ? '<span class="badge badge-low">Low stock</span>' : '<span class="badge badge-ok">OK</span>'),
    sortValue: (p) => (Number(p.qty_on_hand) <= Number(p.reorder_level) ? 0 : 1)
  },
  { key: 'updated_at', label: 'Last Updated', render: (p) => (p.updated_at ? new Date(p.updated_at).toLocaleDateString() : '—'), sortValue: (p) => (p.updated_at ? new Date(p.updated_at).getTime() : 0) }
];
const DEFAULT_INVENTORY_COLUMNS = ['item_number', 'name', 'sku', 'category_name', 'price', 'qty_on_hand', 'status'];
const INVENTORY_COLUMNS_STORAGE_KEY = 'saffron_inventory_columns_v1';

function loadInventoryColumns() {
  try {
    const parsed = JSON.parse(localStorage.getItem(INVENTORY_COLUMNS_STORAGE_KEY));
    const valid = Array.isArray(parsed) ? parsed.filter((k) => INVENTORY_COLUMNS.some((c) => c.key === k)) : [];
    return valid.length ? valid : [...DEFAULT_INVENTORY_COLUMNS];
  } catch {
    return [...DEFAULT_INVENTORY_COLUMNS];
  }
}
function saveInventoryColumns(cols) {
  localStorage.setItem(INVENTORY_COLUMNS_STORAGE_KEY, JSON.stringify(cols));
}

// Generic per-workstation column preference store, same load/validate/save
// shape as loadInventoryColumns()/saveInventoryColumns() above -- used by
// every other customizable-columns table (Sale, Receive Items, Physical
// Inventory, Employees) so each only needs its own catalog + storage key.
function makeColumnStore(storageKey, catalog, defaultColumns) {
  return {
    load() {
      try {
        const parsed = JSON.parse(localStorage.getItem(storageKey));
        const valid = Array.isArray(parsed) ? parsed.filter((k) => catalog.some((c) => c.key === k)) : [];
        const withLocked = [...new Set([...valid, ...catalog.filter((c) => c.locked).map((c) => c.key)])];
        return valid.length ? withLocked : [...defaultColumns];
      } catch {
        return [...defaultColumns];
      }
    },
    save(cols) { localStorage.setItem(storageKey, JSON.stringify(cols)); }
  };
}

// ---------- Physical Inventory column customization ----------
const PHYSICAL_INVENTORY_COLUMNS = [
  { key: 'item_number', label: 'Item Number', render: (p) => escapeHtml(p.item_number || '—') },
  { key: 'sku', label: 'SKU', render: (p) => escapeHtml(p.sku || '—') },
  { key: 'name', label: 'Item Name', locked: true, render: (p) => escapeHtml(p.name) },
  { key: 'category_name', label: 'Category', render: (p) => escapeHtml(p.category_name || '—') },
  { key: 'expected', label: 'Expected', locked: true, render: (p) => String(fmtQty(p.qty_on_hand)) }
];
const DEFAULT_PHYSICAL_INVENTORY_COLUMNS = ['sku', 'name', 'expected'];
const physicalInventoryColumnStore = makeColumnStore('saffron_physical_inventory_columns_v1', PHYSICAL_INVENTORY_COLUMNS, DEFAULT_PHYSICAL_INVENTORY_COLUMNS);

// ---------- Make a Sale line-table column customization ----------
// render(line, product) -- product may be undefined if it's since been
// deleted, so every render function tolerates that.
const SALE_LINE_COLUMNS = [
  { key: 'item_number', label: 'Item Number', render: (line, p) => escapeHtml(p?.item_number || '—') },
  { key: 'sku', label: 'Item Name (SKU)', render: (line, p) => escapeHtml(p?.sku || '—') },
  { key: 'description', label: 'Item Description', render: (line, p) => escapeHtml(line.name) },
  { key: 'category_name', label: 'Category', render: (line, p) => escapeHtml(p?.category_name || '—') },
  { key: 'qty', label: 'Qty', render: (line, p) => String(line.qty) },
  { key: 'price', label: 'Price', render: (line, p) => money(line.price) },
  { key: 'ext_price', label: 'Ext Price', render: (line, p) => money(line.price * line.qty) },
  { key: 'avail_qty', label: 'Avail Qty', render: (line, p) => (p ? String(fmtQty((Number(p.qty_on_hand) || 0) - line.qty)) : '—') }
];
const DEFAULT_SALE_LINE_COLUMNS = ['sku', 'description', 'qty', 'price', 'ext_price', 'avail_qty'];
const saleLineColumnStore = makeColumnStore('saffron_sale_line_columns_v1', SALE_LINE_COLUMNS, DEFAULT_SALE_LINE_COLUMNS);

// ---------- Receive Items line-table column customization ----------
// The core editable cells (Item, Qty, Voucher Cost, Regular Price, Markup %)
// are locked -- they're the actual data-entry mechanism for a receiving
// line, with no other way to set them, unlike Sale's Qty +/-/Remove action
// bar. Everything else is optional reference info.
const RECEIVE_LINE_COLUMNS = [
  { key: 'item_number', label: 'Item Number' },
  { key: 'sku', label: 'SKU' },
  { key: 'category_name', label: 'Category' },
  { key: 'on_hand', label: 'Current On-Hand' },
  { key: 'name', label: 'Item', locked: true },
  { key: 'qty', label: 'Qty', locked: true },
  { key: 'cost', label: 'Voucher Cost', locked: true },
  { key: 'ext_cost', label: 'Ext. Cost' },
  { key: 'price', label: 'Regular Price', locked: true },
  { key: 'markup', label: 'Markup %', locked: true }
];
const DEFAULT_RECEIVE_LINE_COLUMNS = ['name', 'qty', 'cost', 'ext_cost', 'price', 'markup'];
const receiveLineColumnStore = makeColumnStore('saffron_receive_line_columns_v1', RECEIVE_LINE_COLUMNS, DEFAULT_RECEIVE_LINE_COLUMNS);

// ---------- Employees column customization ----------
const EMPLOYEE_COLUMNS = [
  { key: 'full_name', label: 'Name', render: (u) => escapeHtml(u.full_name) },
  { key: 'username', label: 'Username', render: (u) => escapeHtml(u.username) },
  { key: 'role', label: 'Role', render: (u) => escapeHtml(u.role) },
  { key: 'status', label: 'Status', render: (u) => (u.active ? '<span class="badge badge-ok">Active</span>' : '<span class="badge badge-low">Disabled</span>') },
  { key: 'updated_at', label: 'Last Updated', render: (u) => (u.updated_at ? new Date(u.updated_at).toLocaleDateString() : '—') }
];
const DEFAULT_EMPLOYEE_COLUMNS = ['full_name', 'username', 'role', 'status'];
const employeeColumnStore = makeColumnStore('saffron_employee_columns_v1', EMPLOYEE_COLUMNS, DEFAULT_EMPLOYEE_COLUMNS);

// ---------- Purchase Order line-table column customization ----------
// Item/Qty/Cost are locked for the same reason as Receive Items -- they're
// the actual data-entry cells for the line, not just a display of it.
const PO_LINE_COLUMNS = [
  { key: 'item_number', label: 'Item Number' },
  { key: 'sku', label: 'SKU' },
  { key: 'category_name', label: 'Category' },
  { key: 'on_hand', label: 'On-Hand Qty' },
  { key: 'item', label: 'Item', locked: true },
  { key: 'qty', label: 'Qty', locked: true },
  { key: 'cost', label: 'Cost', locked: true },
  { key: 'ext_cost', label: 'Ext Cost' }
];
const DEFAULT_PO_LINE_COLUMNS = ['item', 'qty', 'cost', 'ext_cost'];
const poLineColumnStore = makeColumnStore('saffron_po_line_columns_v1', PO_LINE_COLUMNS, DEFAULT_PO_LINE_COLUMNS);

// ---------- Sales report column customization ----------
// Column names below mirror QuickBooks POS's report column pickers (Dept
// Name, Ext Price, Ext Cost, Margin %, Total Margin $, Item #, ...) so
// anyone coming from QB POS finds familiar labels. A few QB columns aren't
// offered because Saffron's data model has no equivalent to snap them to:
// Vendor/Attribute/Size/UPC/Alternate Lookup don't exist on a product here,
// and "Associate" isn't offered on Item Summary specifically because that
// report aggregates one item across every sale (and associate) in the date
// range -- there's no single associate to show per row.
//
// cost/total_cost/gross_profit/margin_pct come from the item's CURRENT cost
// (see GET /api/reports/top-products) -- not a historical cost snapshot --
// so these are best read as "at today's cost", same caveat as Inventory
// Valuation.
const TOP_PRODUCTS_COLUMNS = [
  { key: 'item_number', label: 'Item #', render: (p) => escapeHtml(p.item_number || '—'), sortValue: (p) => p.item_number || '' },
  { key: 'sku', label: 'SKU', render: (p) => escapeHtml(p.sku || '—'), sortValue: (p) => p.sku || '' },
  { key: 'name', label: 'Item Name', locked: true, render: (p) => escapeHtml(p.name), sortValue: (p) => p.name || '' },
  { key: 'category_name', label: 'Dept Name', render: (p) => escapeHtml(p.category_name || '—'), sortValue: (p) => p.category_name || '' },
  { key: 'qty_sold', label: 'Qty Sold', render: (p) => String(fmtQty(p.qty_sold)), sortValue: (p) => Number(p.qty_sold) || 0 },
  { key: 'revenue', label: 'Ext Price', render: (p) => money(p.revenue), sortValue: (p) => Number(p.revenue) || 0 },
  { key: 'cost', label: 'Cost (each)', render: (p) => money(p.cost), sortValue: (p) => Number(p.cost) || 0 },
  { key: 'total_cost', label: 'Ext Cost', render: (p) => money(p.total_cost), sortValue: (p) => Number(p.total_cost) || 0 },
  { key: 'gross_profit', label: 'Total Margin $', render: (p) => money(p.gross_profit), sortValue: (p) => Number(p.gross_profit) || 0 },
  { key: 'margin_pct', label: 'Margin %', render: (p) => (Number(p.revenue) > 0 ? `${((Number(p.gross_profit) / Number(p.revenue)) * 100).toFixed(1)}%` : '—'), sortValue: (p) => (Number(p.revenue) > 0 ? Number(p.gross_profit) / Number(p.revenue) : -Infinity) }
];
const DEFAULT_TOP_PRODUCTS_COLUMNS = ['name', 'qty_sold', 'revenue'];
const topProductsColumnStore = makeColumnStore('saffron_top_products_columns_v1', TOP_PRODUCTS_COLUMNS, DEFAULT_TOP_PRODUCTS_COLUMNS);

// General Sales - Detail: one row per receipt. GET /api/sales already joins
// cashier_name/customer_name/associate_name, so no backend change was needed.
const SALES_DETAIL_COLUMNS = [
  { key: 'date', label: 'Date', locked: true, render: (s) => new Date(s.created_at).toLocaleDateString(), sortValue: (s) => new Date(s.created_at).getTime() },
  { key: 'sale_number', label: 'Receipt #', locked: true, render: (s) => escapeHtml(s.sale_number), sortValue: (s) => s.sale_number || '' },
  { key: 'status', label: 'Status', render: (s) => (s.status === 'voided' ? '<span class="badge badge-low">Voided</span>' : '<span class="badge badge-ok">Completed</span>'), sortValue: (s) => s.status || '' },
  { key: 'customer_name', label: 'Customer', render: (s) => escapeHtml(s.customer_name || 'Walk-in'), sortValue: (s) => s.customer_name || '' },
  { key: 'cashier_name', label: 'Cashier', render: (s) => escapeHtml(s.cashier_name || '—'), sortValue: (s) => s.cashier_name || '' },
  { key: 'associate_name', label: 'Associate', render: (s) => escapeHtml(s.associate_name || '—'), sortValue: (s) => s.associate_name || '' },
  { key: 'payment_method', label: 'Payment', render: (s) => `<span class="capitalize">${escapeHtml(s.payment_method || '—')}</span>`, sortValue: (s) => s.payment_method || '' },
  { key: 'subtotal', label: 'Subtotal', render: (s) => money(s.subtotal), sortValue: (s) => Number(s.subtotal) || 0 },
  { key: 'discount', label: 'Discount', render: (s) => money(s.discount), sortValue: (s) => Number(s.discount) || 0 },
  { key: 'tax', label: 'Tax', render: (s) => money(s.tax), sortValue: (s) => Number(s.tax) || 0 },
  { key: 'total', label: 'Total', locked: true, render: (s) => money(s.total), sortValue: (s) => Number(s.total) || 0 }
];
const DEFAULT_SALES_DETAIL_COLUMNS = ['date', 'sale_number', 'status', 'customer_name', 'payment_method', 'total'];
const salesDetailColumnStore = makeColumnStore('saffron_sales_detail_columns_v1', SALES_DETAIL_COLUMNS, DEFAULT_SALES_DETAIL_COLUMNS);

// Sales by Employee / Sales by Associate share the same shape (name, sale
// count, revenue) -- separate catalogs only so the "name" column can be
// labeled Employee vs. Associate, and so each remembers its own columns.
function makeSalesByPersonColumns(personLabel) {
  return [
    { key: 'full_name', label: personLabel, locked: true, render: (r) => escapeHtml(r.full_name), sortValue: (r) => r.full_name || '' },
    { key: 'sale_count', label: 'Sales', render: (r) => String(r.sale_count), sortValue: (r) => Number(r.sale_count) || 0 },
    { key: 'revenue', label: 'Revenue', render: (r) => money(r.revenue), sortValue: (r) => Number(r.revenue) || 0 },
    { key: 'avg_sale', label: 'Avg Sale', render: (r) => money(Number(r.sale_count) > 0 ? Number(r.revenue) / Number(r.sale_count) : 0), sortValue: (r) => (Number(r.sale_count) > 0 ? Number(r.revenue) / Number(r.sale_count) : 0) }
  ];
}
const BY_EMPLOYEE_COLUMNS = makeSalesByPersonColumns('Employee');
const DEFAULT_BY_EMPLOYEE_COLUMNS = ['full_name', 'sale_count', 'revenue'];
const byEmployeeColumnStore = makeColumnStore('saffron_by_employee_columns_v1', BY_EMPLOYEE_COLUMNS, DEFAULT_BY_EMPLOYEE_COLUMNS);
const BY_ASSOCIATE_COLUMNS = makeSalesByPersonColumns('Associate');
const DEFAULT_BY_ASSOCIATE_COLUMNS = ['full_name', 'sale_count', 'revenue'];
const byAssociateColumnStore = makeColumnStore('saffron_by_associate_columns_v1', BY_ASSOCIATE_COLUMNS, DEFAULT_BY_ASSOCIATE_COLUMNS);

// General Sales - Summary's payment-method breakdown (the API already
// returns byPayment; the report just wasn't displaying it before).
const SUMMARY_PAYMENT_COLUMNS = [
  { key: 'payment_method', label: 'Payment Method', locked: true, render: (r) => `<span class="capitalize">${escapeHtml(r.payment_method || '—')}</span>`, sortValue: (r) => r.payment_method || '' },
  { key: 'count', label: 'Sales', render: (r) => String(r.count), sortValue: (r) => Number(r.count) || 0 },
  { key: 'total', label: 'Total', locked: true, render: (r) => money(r.total), sortValue: (r) => Number(r.total) || 0 }
];
const DEFAULT_SUMMARY_PAYMENT_COLUMNS = ['payment_method', 'count', 'total'];
const summaryPaymentColumnStore = makeColumnStore('saffron_summary_payment_columns_v1', SUMMARY_PAYMENT_COLUMNS, DEFAULT_SUMMARY_PAYMENT_COLUMNS);

// Opens the "Customize Columns" dual-list picker (Available <-> Chosen,
// with Add/Remove/Move Up/Move Down/Default) and calls onSave(newColumns)
// when the user saves. `columnCatalog` is the full list of {key, label,
// locked?} columns available for this particular table (Item List, Sale,
// Receive Items, Physical Inventory, Employees, ...); `defaultColumns` is
// what "Default" resets back to. A `locked: true` column (e.g. Qty on a
// voucher line) can be reordered but never removed -- it's excluded from
// the Available pool entirely and always present in Chosen.
function openColumnCustomizerModal(columnCatalog, defaultColumns, currentColumns, onSave) {
  const lockedKeys = columnCatalog.filter((c) => c.locked).map((c) => c.key);
  let chosen = [...new Set([...currentColumns, ...lockedKeys])];
  let pickedAvailable = null;
  let pickedChosen = null;

  const overlay = openModal(`
    <h2>Customize Columns</h2>
    <div class="column-picker">
      <div class="column-picker-list-wrap">
        <div class="column-picker-label">Available Columns</div>
        <div class="column-picker-list" id="availableList"></div>
      </div>
      <div class="column-picker-buttons">
        <button type="button" class="btn btn-sm" id="addColBtn">Add &rarr;</button>
        <button type="button" class="btn btn-sm btn-danger" id="removeColBtn">&larr; Remove</button>
        <button type="button" class="btn btn-sm" id="moveUpBtn">Move Up</button>
        <button type="button" class="btn btn-sm" id="moveDownBtn">Move Down</button>
        <button type="button" class="btn btn-sm" id="defaultColBtn">Default</button>
      </div>
      <div class="column-picker-list-wrap">
        <div class="column-picker-label">Chosen Columns</div>
        <div class="column-picker-list" id="chosenList"></div>
      </div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn" id="cancelBtn">Cancel</button>
      <button type="button" class="btn btn-primary" id="saveColsBtn">Save</button>
    </div>
  `, 'modal-lg');

  const availableEl = overlay.querySelector('#availableList');
  const chosenEl = overlay.querySelector('#chosenList');

  function draw() {
    const available = columnCatalog.filter((c) => !chosen.includes(c.key) && !c.locked);
    availableEl.innerHTML = available.map((c) => `
      <div class="column-picker-item ${pickedAvailable === c.key ? 'selected' : ''}" data-key="${c.key}">${escapeHtml(c.label)}</div>
    `).join('') || '<div class="empty-state compact">Every column is already chosen.</div>';

    chosenEl.innerHTML = chosen.map((key) => {
      const c = columnCatalog.find((x) => x.key === key);
      const label = c ? c.label : key;
      return `<div class="column-picker-item ${pickedChosen === key ? 'selected' : ''}" data-key="${key}">${escapeHtml(label)}${c?.locked ? ' <small class="muted">(required)</small>' : ''}</div>`;
    }).join('') || '<div class="empty-state compact">Pick at least one column.</div>';

    availableEl.querySelectorAll('.column-picker-item').forEach((el) => el.addEventListener('click', () => {
      pickedAvailable = el.dataset.key;
      pickedChosen = null;
      draw();
    }));
    chosenEl.querySelectorAll('.column-picker-item').forEach((el) => el.addEventListener('click', () => {
      pickedChosen = el.dataset.key;
      pickedAvailable = null;
      draw();
    }));
  }
  draw();

  overlay.querySelector('#addColBtn').addEventListener('click', () => {
    if (!pickedAvailable) return;
    chosen.push(pickedAvailable);
    pickedAvailable = null;
    draw();
  });
  overlay.querySelector('#removeColBtn').addEventListener('click', () => {
    if (!pickedChosen || chosen.length <= 1) return;
    if (lockedKeys.includes(pickedChosen)) { toast('That column is required and can’t be removed.', 'error'); return; }
    chosen = chosen.filter((k) => k !== pickedChosen);
    pickedChosen = null;
    draw();
  });
  overlay.querySelector('#moveUpBtn').addEventListener('click', () => {
    const i = chosen.indexOf(pickedChosen);
    if (i <= 0) return;
    [chosen[i - 1], chosen[i]] = [chosen[i], chosen[i - 1]];
    draw();
  });
  overlay.querySelector('#moveDownBtn').addEventListener('click', () => {
    const i = chosen.indexOf(pickedChosen);
    if (i === -1 || i >= chosen.length - 1) return;
    [chosen[i + 1], chosen[i]] = [chosen[i], chosen[i + 1]];
    draw();
  });
  overlay.querySelector('#defaultColBtn').addEventListener('click', () => {
    chosen = [...new Set([...defaultColumns, ...lockedKeys])];
    pickedAvailable = null;
    pickedChosen = null;
    draw();
  });
  overlay.querySelector('#cancelBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#saveColsBtn').addEventListener('click', () => {
    onSave(chosen);
    overlay.remove();
  });
}

// Renders a "Customize Columns" button + data table into `container`, backed
// by a column catalog/store from makeColumnStore() -- the shared pattern
// behind every customizable report table (Reports > Sales, Item Summary, by
// Employee, by Associate, ...). `rows` is already-fetched data; re-picking
// columns just redraws locally, no refetch.
//
// Also wires click-to-sort on every column header that has a `sortValue` --
// same convention as QuickBooks POS's report windows (click a header to
// rank by it, click again to flip the order; a small triangle marks which
// column and which direction). `initialSort` ({key, dir}) picks what the
// table opens sorted by, matching whatever order the API already returned.
function sortRowsBy(rows, catalog, key, dir) {
  const col = catalog.find((c) => c.key === key);
  if (!col || !col.sortValue) return rows;
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const av = col.sortValue(a.row);
      const bv = col.sortValue(b.row);
      let cmp = (typeof av === 'string' || typeof bv === 'string')
        ? String(av ?? '').localeCompare(String(bv ?? ''))
        : (Number(av) || 0) - (Number(bv) || 0);
      if (cmp === 0) cmp = a.i - b.i; // stable sort
      return dir === 'asc' ? cmp : -cmp;
    })
    .map((x) => x.row);
}
function sortArrowHtml(active, dir) {
  return active ? ` <span class="sort-arrow">${dir === 'asc' ? '&#9650;' : '&#9660;'}</span>` : '';
}
function renderCustomizableTable(container, { rows, catalog, defaultColumns, store, emptyText, idSuffix = '', initialSort = null }) {
  let cols = store.load();
  let sortKey = initialSort?.key ?? null;
  let sortDir = initialSort?.dir ?? 'desc';
  const btnId = `customizeColsBtn${idSuffix}`;
  const draw = () => {
    const sorted = sortRowsBy(rows, catalog, sortKey, sortDir);
    container.innerHTML = `
      <div class="table-toolbar">
        <button type="button" class="btn btn-sm" id="${btnId}">${icon('columns', 14)} <span><span class="hide-phone">Customize&nbsp;</span>Columns</span></button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>${cols.map((key) => {
          const c = catalog.find((x) => x.key === key);
          const sortable = c?.sortValue;
          return `<th ${sortable ? `class="sortable-th" data-key="${key}" title="Click to sort"` : ''}>${escapeHtml(c?.label || key)}${sortArrowHtml(key === sortKey, sortDir)}</th>`;
        }).join('')}</tr></thead>
        <tbody>${sorted.map((row) => `<tr>${cols.map((key) => `<td>${catalog.find((c) => c.key === key)?.render(row) ?? '—'}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="empty-state">${emptyText}</td></tr>`}</tbody>
      </table></div>
    `;
    container.querySelector(`#${btnId}`).addEventListener('click', () => {
      openColumnCustomizerModal(catalog, defaultColumns, cols, (newColumns) => {
        cols = newColumns;
        store.save(newColumns);
        draw();
        toast('Columns updated.', 'success');
      });
    });
    container.querySelectorAll('.sortable-th').forEach((th) => th.addEventListener('click', () => {
      const key = th.dataset.key;
      sortDir = (sortKey === key) ? (sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
      sortKey = key;
      draw();
    }));
    makeColumnsResizable(container.querySelector('table'), `custom_${idSuffix}`);
    attachZoomContextMenu(container.querySelector('.table-wrap'), `custom_${idSuffix}`);
  };
  draw();
}

// Same click-to-sort header behavior as renderCustomizableTable, for report
// tables that don't (yet) offer a column picker -- every column is always
// shown, in a fixed order, but any column with a `sortValue` can still be
// clicked to rank the report by it. `columns` is [{key, label, render,
// sortValue?}]; a column without `sortValue` (rare here) just isn't
// clickable. `footerHtml(sortedRows)`, if given, renders a <tfoot> from the
// current sort order.
function renderSortableTable(container, { rows, columns, emptyText, initialSort = null, footerHtml = null, note = '', resizeKey = null }) {
  let sortKey = initialSort?.key ?? null;
  let sortDir = initialSort?.dir ?? 'desc';
  const draw = () => {
    const sorted = sortRowsBy(rows, columns, sortKey, sortDir);
    container.innerHTML = `
      ${note ? `<p class="note">${note}</p>` : ''}
      <div class="table-wrap"><table>
        <thead><tr>${columns.map((c) => `<th ${c.sortValue ? `class="sortable-th" data-key="${c.key}" title="Click to sort"` : `data-key="${c.key}"`}>${escapeHtml(c.label)}${sortArrowHtml(c.key === sortKey, sortDir)}</th>`).join('')}</tr></thead>
        <tbody>${sorted.map((row) => `<tr>${columns.map((c) => `<td>${c.render(row)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${columns.length}" class="empty-state">${emptyText}</td></tr>`}</tbody>
        ${footerHtml ? footerHtml(sorted) : ''}
      </table></div>
    `;
    container.querySelectorAll('.sortable-th').forEach((th) => th.addEventListener('click', () => {
      const key = th.dataset.key;
      sortDir = (sortKey === key) ? (sortDir === 'asc' ? 'desc' : 'asc') : 'desc';
      sortKey = key;
      draw();
    }));
    if (resizeKey) {
      makeColumnsResizable(container.querySelector('table'), `sortable_${resizeKey}`);
      attachZoomContextMenu(container.querySelector('.table-wrap'), `sortable_${resizeKey}`);
    }
  };
  draw();
}

// Drag-to-resize column headers -- matches QuickBooks POS's grid: hover the
// seam between two headers for a resize cursor, drag to widen/narrow.
// Widths persist per table (keyed by `storageKey`, and per column by its
// `data-key` or position) in localStorage, independent of column choice or
// sort order, so re-picking columns or re-sorting doesn't reset them.
//
// Call this fresh every time a table's <thead> is (re)rendered -- innerHTML
// replacement means the actual <th> elements (and any resizer handle on
// them) are gone, so there's nothing to "keep in sync"; this just re-adds
// the handles and re-applies the saved widths to whatever's there now.
// `table` may be null (e.g. an empty-state redraw with no table); no-op.
function makeColumnsResizable(table, storageKey) {
  if (!table) return;
  const headRow = table.querySelector('thead tr');
  if (!headRow) return;
  const lsKey = `saffron_colwidths_${storageKey}`;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(lsKey)) || {}; } catch { saved = {}; }

  const heads = () => [...headRow.children];
  const keyOf = (th) => th.dataset.key || `col${heads().indexOf(th)}`;

  // Switches the table to explicit column widths (table-layout:fixed). Until
  // then -- i.e. until someone actually drags a handle or a saved width
  // exists -- the browser sizes columns to their content, so a table that
  // starts out empty (Receive Items, Make a Sale) doesn't get locked to
  // header-sized columns that are too narrow for the rows added later.
  function lock() {
    if (table.classList.contains('resizable-table')) return;
    const cols = heads().filter((th) => !th.classList.contains('no-resize'));
    // Measure natural (auto-layout) widths BEFORE switching to fixed layout,
    // so the first resize starts from how the column already looked.
    const natural = cols.map((th) => th.getBoundingClientRect().width);
    if (!natural.some((w) => w > 0)) return; // header hidden (phone card layout) -- nothing to lock in
    cols.forEach((th, i) => { th.style.width = `${Math.round(saved[keyOf(th)] || natural[i])}px`; });
    table.classList.add('resizable-table');
  }

  heads().forEach((th) => {
    if (th.classList.contains('no-resize')) return;
    const key = keyOf(th);
    th.style.position = 'relative'; // the resizer handle below is positioned absolute against this
    const handle = document.createElement('span');
    handle.className = 'col-resizer';
    th.appendChild(handle);
    handle.addEventListener('click', (e) => e.stopPropagation()); // don't also trigger a sort click
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      lock();
      const startX = e.clientX;
      const startWidth = th.getBoundingClientRect().width;
      const onMove = (ev) => { th.style.width = `${Math.max(40, startWidth + (ev.clientX - startX))}px`; };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        saved[key] = th.getBoundingClientRect().width;
        try { localStorage.setItem(lsKey, JSON.stringify(saved)); } catch { /* storage unavailable -- resize still works this session */ }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });

  // Previously saved widths apply straight away (one frame later, so the
  // rows the caller renders right after this exist when we measure).
  if (heads().some((th) => saved[keyOf(th)])) {
    requestAnimationFrame(() => { if (table.isConnected) lock(); });
  }
}

// ---------- Right-click "Zoom" (bigger/smaller entries) ----------
// Matches QuickBooks POS's grid right-click menu: right-click anywhere in
// the entries area for a Zoom submenu (75%-200%, or a custom %) that scales
// the whole grid -- rows, text, everything -- up or down. Useful on a small
// register screen (compress it to fit more rows) or for someone who wants
// larger, easier-to-read text. Persisted per table (keyed by `storageKey`)
// in localStorage, so it's a per-workstation preference, same as column
// widths/choices, not something that resets every time the screen reopens.
const ZOOM_LEVELS = [75, 100, 125, 150, 200];
function attachZoomContextMenu(target, storageKey) {
  if (!target) return;
  const lsKey = `saffron_zoom_${storageKey}`;
  let zoom = Number(localStorage.getItem(lsKey)) || 100;

  function applyZoom() {
    // `zoom` (not `transform: scale`) so the box actually takes up more/less
    // real layout space -- rows fitting more/fewer on screen, not just
    // visually stretching over neighboring content.
    target.style.zoom = zoom / 100;
  }
  function setZoom(pct) {
    zoom = Math.min(300, Math.max(50, Math.round(pct)));
    applyZoom();
    try { localStorage.setItem(lsKey, String(zoom)); } catch { /* storage unavailable -- zoom still works this session */ }
  }
  applyZoom();

  function closeMenu() {
    document.querySelectorAll('.zoom-context-menu').forEach((m) => m.remove());
  }

  target.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'zoom-context-menu';
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    menu.innerHTML = `
      <div class="zoom-context-label">Zoom</div>
      ${ZOOM_LEVELS.map((pct) => `
        <div class="zoom-context-item ${pct === zoom ? 'active' : ''}" data-pct="${pct}"><span class="zoom-context-dot"></span>${pct}%</div>
      `).join('')}
      <div class="zoom-context-item ${!ZOOM_LEVELS.includes(zoom) ? 'active' : ''}" data-pct="custom"><span class="zoom-context-dot"></span>Custom&hellip; ${!ZOOM_LEVELS.includes(zoom) ? `(${zoom}%)` : ''}</div>
    `;
    document.body.appendChild(menu);

    // Keep it fully on-screen even when right-clicked near an edge.
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 8)}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 8)}px`;

    menu.querySelectorAll('.zoom-context-item').forEach((item) => item.addEventListener('click', () => {
      if (item.dataset.pct === 'custom') {
        const input = prompt('Zoom percentage (50-300):', String(zoom));
        const pct = input === null ? null : Number(input);
        if (pct !== null && Number.isFinite(pct) && pct > 0) setZoom(pct);
      } else {
        setZoom(Number(item.dataset.pct));
      }
      closeMenu();
    }));

    // Close on the next click anywhere else (deferred so this same
    // right-click's own subsequent events don't immediately close it).
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
  });
}

// =====================================================================
// SALE / CHECKOUT
// =====================================================================
let cart = [];
let selectedCustomerId = '';
let selectedAssociateId = '';

// =====================================================================
// HOME / NAVIGATOR DASHBOARD
// =====================================================================
function flowStep(iconName, label, view, opts = {}) {
  const disabled = opts.disabled ? ' disabled' : '';
  const badgeText = opts.badge || 'Soon';
  const soon = opts.disabled ? `<span class="soon-badge">${badgeText}</span>` : '';
  const reason = opts.reason || 'That feature isn\'t built into this version yet.';
  return `<button class="flow-step${disabled}" data-view="${opts.disabled ? '' : view}" ${opts.disabled ? `data-soon="${escapeHtml(reason)}"` : ''}>
    ${soon}<div class="flow-icon">${icon(iconName, 22)}</div><div class="flow-label">${label}</div>
  </button>`;
}
const FLOW_ARROW = '<span class="flow-arrow">&#8594;</span>';

async function renderHome() {
  const firstName = escapeHtml((CURRENT_USER.full_name || '').split(' ')[0] || '');
  let lowStock = [];
  try {
    lowStock = await Api.get('/api/reports/low-stock').catch(() => []);
  } catch (e) { /* ignore -- render with whatever we got */ }

  content.innerHTML = `
    <div class="view-header"><h1>Welcome back, ${firstName}</h1></div>

    ${lowStock.length ? `
      <div class="card notice-card">
        <div class="notice-icon">${icon('inbox', 20)}</div>
        <div class="notice-body">
          <strong>${lowStock.length} item${lowStock.length === 1 ? '' : 's'} running low on stock</strong>
          <p>${lowStock.slice(0, 4).map((p) => escapeHtml(p.name)).join(', ')}${lowStock.length > 4 ? ', and more&hellip;' : ''}</p>
        </div>
        <button type="button" class="btn btn-sm" data-view="inventory">View Item List</button>
      </div>
    ` : ''}

    <div class="swimlane-section">
      <div class="swimlane-label-chip">${icon('receipt', 15)} Point of Sale</div>
      <div class="flow-row">
        ${flowStep('clipboard', 'Customer Orders', 'customerOrders')}
        ${FLOW_ARROW}
        ${flowStep('receipt', 'Make a Sale', 'sale')}
        ${FLOW_ARROW}
        ${flowStep('barChart', 'Sales History', 'reports')}
        ${FLOW_ARROW}
        ${flowStep('user', 'Customer List', 'customers')}
        ${flowStep('pauseCircle', 'Held Receipts', 'heldReceipts')}
        ${FLOW_ARROW}
        ${flowStep('moon', 'End of Day', 'eod')}
        ${FLOW_ARROW}
        ${flowStep('gift', 'Reward Manager', 'rewards')}
      </div>
    </div>

    <div class="swimlane-section">
      <div class="swimlane-label-chip">${icon('box', 15)} Purchasing</div>
      <div class="flow-row">
        ${flowStep('fileText', 'Purchase Orders', 'purchaseOrders')}
        ${FLOW_ARROW}
        ${flowStep('inbox', 'Receive Items', 'receive')}
        ${FLOW_ARROW}
        ${flowStep('archive', 'Receiving History', 'receivingHistory')}
        ${FLOW_ARROW}
        ${flowStep('box', 'Item List', 'inventory')}
        ${flowStep('truck', 'Vendor List', 'vendors')}
        ${FLOW_ARROW}
        ${flowStep('folder', 'Department List', 'departments')}
      </div>
    </div>

    <div class="swimlane-section">
      <div class="swimlane-label-chip">${icon('users', 15)} Employees</div>
      <div class="flow-row">
        ${flowStep('clock', 'Clock In/Out', 'clockInOut')}
        ${FLOW_ARROW}
        ${flowStep('users', 'Employee List', 'employees', { disabled: CURRENT_USER.role !== 'admin', badge: 'Admin', reason: 'Only admins can manage employees.' })}
        ${FLOW_ARROW}
        ${flowStep('gear', 'Preferences', 'settings', { disabled: CURRENT_USER.role !== 'admin', badge: 'Admin', reason: 'Only admins can change settings.' })}
      </div>
    </div>
  `;

  content.querySelectorAll('.flow-step, .notice-card .btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.soon) { toast(btn.dataset.soon, ''); return; }
      if (btn.dataset.view) navigate(btn.dataset.view);
    });
  });
}

async function renderSale() {
  const [products, categories, customers, team] = await Promise.all([
    Api.get('/api/products'),
    Api.get('/api/products/categories'),
    Api.get('/api/customers'),
    Api.get('/api/users/team')
  ]);

  content.innerHTML = `
    <div class="view-header"><h1>Make a Sale</h1></div>
    <div class="card">
      <div class="sale-search-row">
        <div class="receive-search-wrap">
          <input type="search" class="search-input" id="saleSearch"
            placeholder="Type an item name, SKU, or barcode&hellip; (or scan a barcode)" autocomplete="off" />
          <div class="receive-suggestions" id="saleSuggestions" hidden></div>
        </div>
        <button type="button" class="btn" id="scanBarcodeBtn" title="Scan with camera">${icon('camera', 14)} Scan</button>
        <button type="button" class="btn" id="findItemsBtn">${icon('search', 14)} <span>Find<span class="hide-phone">&nbsp;Item(s)</span></span></button>
        <button type="button" class="btn" id="saleCustomizeColumnsBtn">${icon('columns', 14)} <span><span class="hide-phone">Customize&nbsp;</span>Columns</span></button>
      </div>
      <div class="table-wrap" id="saleLinesWrap">
        <table id="saleLinesTable">
          <thead><tr id="saleHeadRow"></tr></thead>
          <tbody id="saleLinesBody"></tbody>
        </table>
      </div>
      <div class="sale-row-actions">
        <button type="button" class="btn" id="saleEditItemBtn" disabled>Edit Item</button>
        <button type="button" class="btn" id="saleQtyIncBtn" disabled>Qty +</button>
        <button type="button" class="btn" id="saleQtyDecBtn" disabled>Qty -</button>
        <button type="button" class="btn btn-danger" id="saleRemoveItemBtn" disabled>Remove this Item</button>
      </div>
    </div>
    <div class="sale-bottom-grid">
      <div class="card">
        <h2>Customer Info</h2>
        <label class="field">Customer
          <span class="field-row">
            <select id="customerSelect">
              <option value="">Walk-in customer</option>
              ${customers.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
            </select>
            <button type="button" class="btn" id="newCustomerBtn" title="Add a new customer">+ New</button>
          </span>
        </label>
        <label class="field mt">Associate
          <select id="associateSelect">
            <option value="">No associate</option>
            ${team.map((u) => `<option value="${u.id}">${escapeHtml(u.full_name)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="card">
        <h2>Totals</h2>
        ${settingBool('enable_discounts', false) ? `
          <div class="discount-row">
            <label for="discountInput">Discount (&#8369;)</label>
            <input type="number" id="discountInput" min="0" step="0.01" value="0" />
          </div>
        ` : ''}
        <div class="cart-summary" id="saleTotals"></div>
        <div class="sale-pay-actions">
          <button class="btn" id="holdBtn">${icon('pauseCircle', 14)} Hold Receipt</button>
          <div>
            <button class="btn btn-danger" id="cancelSaleBtn">Cancel</button>
            <span class="sale-charge-btns">
              <button class="btn btn-success" data-pay="cash">Cash</button>
              <button class="btn btn-primary" data-pay="card">Card</button>
            </span>
          </div>
        </div>
      </div>
    </div>
    <div class="sale-paybar">
      <div class="sale-paybar-total"><small>Total</small><strong id="salePaybarTotal">${money(0)}</strong></div>
      <button class="btn btn-success" data-pay="cash">Cash</button>
      <button class="btn btn-primary" data-pay="card">Card</button>
    </div>
  `;

  document.getElementById('customerSelect').value = selectedCustomerId || '';
  document.getElementById('associateSelect').value = selectedAssociateId || '';

  const searchInput = document.getElementById('saleSearch');
  const suggestionsEl = document.getElementById('saleSuggestions');
  let selectedRow = null; // index into `cart` of the currently selected line, or null
  let activeColumns = saleLineColumnStore.load();

  function drawHead() {
    document.getElementById('saleHeadRow').innerHTML =
      // "Line" -- just this cart's row position (1, 2, 3...), not the
      // product's actual Item Number (which is its own optional column in
      // activeColumns/SALE_LINE_COLUMNS below). Labeled distinctly so the
      // two numbers next to each other don't read as the same thing.
      '<th style="width:60px;" data-key="line">Line</th>' +
      activeColumns.map((key) => {
        const c = SALE_LINE_COLUMNS.find((x) => x.key === key);
        return `<th data-key="${key}">${escapeHtml(c ? c.label : key)}</th>`;
      }).join('');
    makeColumnsResizable(document.getElementById('saleLinesTable'), 'sale');
  }

  function addSaleItem(product) {
    if (!product) return;
    const existing = cart.find((l) => l.product_id === product.id);
    if (existing) existing.qty += 1;
    else cart.push({ product_id: product.id, name: product.name, price: product.price, qty: 1 });
    drawLines();
  }

  // With no query, show everything (scrollable) -- lets someone click into
  // the search box and browse the full item list, same as clicking the
  // dropdown arrow on QuickBooks POS's "Enter Item(s)" field.
  function matchesFor(q) {
    q = q.trim().toLowerCase();
    if (!q) return products.slice(0, 50);
    return products
      .filter((p) => p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q) || (p.barcode || '').toLowerCase().includes(q) || (p.item_number || '').toLowerCase().includes(q))
      .slice(0, 50);
  }

  function drawSuggestions(list) {
    suggestionsEl.hidden = false;
    suggestionsEl.innerHTML = `
      <button type="button" class="receive-suggestion-item sale-add-new-item" id="saleAddNewItemBtn">+ Add New Item</button>
      ${list.map((p) => `
        <button type="button" class="receive-suggestion-item" data-id="${p.id}">
          <span><strong>${escapeHtml(p.sku || '—')}</strong>&nbsp; ${escapeHtml(p.name)}</span>
          <span class="receive-suggestion-meta">${money(p.price)} &middot; ${p.qty_on_hand} avail.</span>
        </button>
      `).join('') || `<div class="empty-state compact">No items match.</div>`}
    `;
    suggestionsEl.querySelector('#saleAddNewItemBtn').addEventListener('click', () => {
      hideSuggestions();
      openProductModal(categories, null, (saved) => {
        toast(`${saved.name} added to Item List.`, 'success');
        navigate('sale');
      });
    });
    suggestionsEl.querySelectorAll('.receive-suggestion-item[data-id]').forEach((btn) => btn.addEventListener('click', () => {
      addSaleItem(products.find((p) => p.id === Number(btn.dataset.id)));
      searchInput.value = '';
      hideSuggestions();
      searchInput.focus();
    }));
  }

  function hideSuggestions() { suggestionsEl.hidden = true; suggestionsEl.innerHTML = ''; }

  searchInput.addEventListener('input', () => drawSuggestions(matchesFor(searchInput.value)));
  searchInput.addEventListener('focus', () => drawSuggestions(matchesFor(searchInput.value)));
  searchInput.addEventListener('blur', () => setTimeout(hideSuggestions, 150));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = searchInput.value.trim().toLowerCase();
    if (!q) return;
    // Exact barcode/SKU/item number match takes priority -- lets a barcode
    // scanner (including a self-printed Item Number tag) add items with no
    // clicking at all.
    const exact = products.find((p) => (p.barcode || '').toLowerCase() === q || (p.sku || '').toLowerCase() === q || (p.item_number || '').toLowerCase() === q);
    const candidate = exact || matchesFor(q)[0];
    if (candidate) {
      addSaleItem(candidate);
      searchInput.value = '';
      hideSuggestions();
    }
  });

  function updateRowActionButtons() {
    const has = selectedRow !== null && cart[selectedRow];
    ['saleEditItemBtn', 'saleQtyIncBtn', 'saleQtyDecBtn', 'saleRemoveItemBtn'].forEach((id) => {
      document.getElementById(id).disabled = !has;
    });
  }

  document.getElementById('saleEditItemBtn').addEventListener('click', () => {
    if (selectedRow === null || !cart[selectedRow]) return;
    const product = products.find((p) => p.id === cart[selectedRow].product_id);
    if (!product) return;
    openProductModal(categories, product, (saved) => {
      // Refresh this item's cached price locally (without leaving the sale
      // in progress) so the line and totals reflect the edit right away.
      Object.assign(product, saved);
      const line = cart.find((l) => l.product_id === product.id);
      if (line) line.price = Number(product.price);
      toast('Item updated.', 'success');
      drawLines();
    });
  });
  document.getElementById('saleQtyIncBtn').addEventListener('click', () => {
    if (selectedRow === null || !cart[selectedRow]) return;
    cart[selectedRow].qty += 1;
    drawLines();
  });
  document.getElementById('saleQtyDecBtn').addEventListener('click', () => {
    if (selectedRow === null || !cart[selectedRow]) return;
    cart[selectedRow].qty -= 1;
    if (cart[selectedRow].qty <= 0) { cart.splice(selectedRow, 1); selectedRow = null; }
    drawLines();
  });
  document.getElementById('saleRemoveItemBtn').addEventListener('click', () => {
    if (selectedRow === null || !cart[selectedRow]) return;
    cart.splice(selectedRow, 1);
    selectedRow = null;
    drawLines();
  });

  document.getElementById('findItemsBtn').addEventListener('click', () => openFindItemsModal(products, addSaleItem));
  document.getElementById('scanBarcodeBtn').addEventListener('click', () => scanBarcodeInto(products, searchInput, matchesFor, drawSuggestions, addSaleItem));
  document.getElementById('customerSelect').addEventListener('change', (e) => { selectedCustomerId = e.target.value; });
  document.getElementById('associateSelect').addEventListener('change', (e) => { selectedAssociateId = e.target.value; });
  document.getElementById('newCustomerBtn').addEventListener('click', () => {
    openCustomerModal(null, (newCustomer) => {
      selectedCustomerId = String(newCustomer.id);
      toast(`${newCustomer.name} added.`, 'success');
      navigate('sale');
    });
  });
  document.getElementById('cancelSaleBtn').addEventListener('click', () => {
    if (cart.length === 0) { navigate('home'); return; }
    if (!confirmGuarded('delete', 'Cancel this sale? Anything added will be lost.')) return;
    cart = [];
    navigate('sale');
  });
  document.getElementById('holdBtn').addEventListener('click', holdSale);
  content.querySelectorAll('[data-pay]').forEach((btn) => btn.addEventListener('click', () => openPaymentConfirm(btn.dataset.pay)));

  function drawLines() {
    const body = document.getElementById('saleLinesBody');
    const colSpan = activeColumns.length + 1;
    // The phone card is headlined by the item's description (falling back to the first column).
    const nameKey = activeColumns.includes('description') ? 'description' : activeColumns[0];
    if (cart.length === 0) {
      body.innerHTML = `<tr><td colspan="${colSpan}" class="empty-state">Your sale will appear here -- search above (or scan a barcode) to add an item.</td></tr>`;
    } else {
      body.innerHTML = cart.map((line, i) => {
        const product = products.find((p) => p.id === line.product_id);
        return `
        <tr data-i="${i}" class="${i === selectedRow ? 'sale-row-selected' : ''}">
          <td data-label="Line">${i + 1}</td>
          ${activeColumns.map((key) => {
            const c = SALE_LINE_COLUMNS.find((x) => x.key === key);
            const value = c ? c.render(line, product) : '—';
            const warn = key === 'avail_qty' && product && (Number(product.qty_on_hand) || 0) - line.qty < 0;
            return `<td class="${key === nameKey ? 'sale-line-name-cell' : ''}${warn ? ' text-danger' : ''}" data-label="${escapeHtml(c ? c.label : key)}">${value}</td>`;
          }).join('')}
        </tr>`;
      }).join('');
      body.querySelectorAll('tr[data-i]').forEach((tr) => tr.addEventListener('click', () => {
        selectedRow = Number(tr.dataset.i);
        drawLines();
      }));
    }
    updateRowActionButtons();

    const subtotal = cart.reduce((s, l) => s + l.price * l.qty, 0);
    const discountInput = document.getElementById('discountInput');
    const discountAmt = discountInput ? (Number(discountInput.value) || 0) : 0;
    const taxRate = parseFloat(COMPANY_SETTINGS.tax_rate) || 0;
    const taxableAmount = Math.max(subtotal - discountAmt, 0);
    const tax = taxableAmount * taxRate;
    const total = taxableAmount + tax;

    document.getElementById('saleTotals').innerHTML = `
      <div class="cart-summary-row"><span>Subtotal</span><span>${money(subtotal)}</span></div>
      ${discountInput ? `<div class="cart-summary-row"><span>Discount</span><span>-${money(discountAmt)}</span></div>` : ''}
      <div class="cart-summary-row"><span>Tax</span><span>${money(tax)}</span></div>
      <div class="cart-summary-row total"><span>${icon('receipt', 16)}Total</span><span>${money(total)}</span></div>
    `;
    document.getElementById('salePaybarTotal').textContent = money(total);
  }

  if (document.getElementById('discountInput')) {
    document.getElementById('discountInput').addEventListener('input', drawLines);
  }

  document.getElementById('saleCustomizeColumnsBtn').addEventListener('click', () => {
    openColumnCustomizerModal(SALE_LINE_COLUMNS, DEFAULT_SALE_LINE_COLUMNS, activeColumns, (newColumns) => {
      activeColumns = newColumns;
      saleLineColumnStore.save(newColumns);
      drawHead();
      drawLines();
      toast('Columns updated.', 'success');
    });
  });

  drawHead();
  drawLines();
  autoFocus(searchInput);
  hideSuggestions(); // the focus handler above opens the item list -- keep it closed until the person asks for it
  attachZoomContextMenu(document.getElementById('saleLinesWrap'), 'sale');
}

// "Find Item(s)" lookup -- a full searchable table of every item, for when
// scrolling the inline dropdown isn't fast enough. Clicking a row adds it
// (via the same onPick callback the Sale screen uses) and closes the modal.
function openFindItemsModal(products, onPick) {
  const overlay = openModal(`
    <h2>Find Item(s)</h2>
    <input type="search" class="search-input mb" id="findItemsSearch"
      placeholder="Search by name, SKU, barcode, or category&hellip;" autocomplete="off" />
    <div class="table-wrap scroll-y">
      <table>
        <thead><tr><th>Item #</th><th>SKU</th><th>Item Name</th><th>Category</th><th>Price</th><th>Avail Qty</th></tr></thead>
        <tbody id="findItemsBody"></tbody>
      </table>
    </div>
  `, 'modal-lg');

  function draw(list) {
    const body = overlay.querySelector('#findItemsBody');
    body.innerHTML = list.map((p) => `
      <tr class="find-item-row" data-id="${p.id}">
        <td>${escapeHtml(p.item_number || '—')}</td>
        <td>${escapeHtml(p.sku || '—')}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.category_name || '—')}</td>
        <td>${money(p.price)}</td>
        <td class="${p.qty_on_hand <= 0 ? 'text-danger' : ''}">${p.qty_on_hand}</td>
      </tr>
    `).join('') || `<tr><td colspan="6" class="empty-state">No items match.</td></tr>`;
    body.querySelectorAll('.find-item-row').forEach((tr) => tr.addEventListener('click', () => {
      onPick(products.find((p) => p.id === Number(tr.dataset.id)));
      overlay.remove();
    }));
  }

  const searchInput = overlay.querySelector('#findItemsSearch');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    draw(!q ? products : products.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q) ||
      (p.barcode || '').toLowerCase().includes(q) ||
      (p.item_number || '').toLowerCase().includes(q) ||
      (p.category_name || '').toLowerCase().includes(q)
    ));
  });

  draw(products);
  autoFocus(searchInput);
}

// Receipt Payment step -- shown after Cash/Card is tapped, before the sale
// is actually posted, so "Back to Receipt" can truly cancel with nothing
// saved yet (mirrors QuickBooks POS's Receipt Payment dialog: Save / Save &
// Print Receipt / Back to Receipt).
function openPaymentConfirm(paymentMethod) {
  if (cart.length === 0) { toast('Add at least one item first.', 'error'); return; }
  const discountInput = document.getElementById('discountInput');
  const discountAmt = discountInput ? (Number(discountInput.value) || 0) : 0;
  const subtotal = cart.reduce((s, l) => s + l.price * l.qty, 0);
  const total = Math.max(0, subtotal - discountAmt);
  const methodLabel = paymentMethod === 'cash' ? 'Cash' : 'Card';

  const overlay = openModal(`
    <h2>Receipt Payment</h2>
    <div class="cart-summary mb">
      <div class="cart-summary-row"><span>Payment Method</span><span>${methodLabel}</span></div>
      <div class="cart-summary-row"><span>Subtotal</span><span>${money(subtotal)}</span></div>
      ${discountAmt ? `<div class="cart-summary-row"><span>Discount</span><span>-${money(discountAmt)}</span></div>` : ''}
      <div class="cart-summary-row total"><span>Total Due</span><span>${money(total)}</span></div>
    </div>
    <p class="note">Save this sale, save and print a receipt, or go back to make changes.</p>
    <div class="modal-actions">
      <button class="btn" id="backToReceiptBtn">Back to Receipt</button>
      <button class="btn" id="saveOnlyBtn">Save</button>
      <button class="btn btn-primary" id="savePrintReceiptBtn">Save &amp; Print Receipt</button>
    </div>
  `);

  overlay.querySelector('#backToReceiptBtn').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#saveOnlyBtn').addEventListener('click', async () => {
    const sale = await submitSale(paymentMethod, discountAmt);
    if (!sale) return;
    overlay.remove();
    toast(`Sale ${sale.sale_number} completed`, 'success');
    afterSaleCleanup();
  });

  overlay.querySelector('#savePrintReceiptBtn').addEventListener('click', async () => {
    const sale = await submitSale(paymentMethod, discountAmt);
    if (!sale) return;
    overlay.remove();
    toast(`Sale ${sale.sale_number} completed`, 'success');
    openPrintDoc(`Receipt ${sale.sale_number}`, renderReceiptDoc(getPrintTemplate('salesReceipt'), sale), { margin: printMarginFor('salesReceipt') });
    afterSaleCleanup();
  });
}

async function submitSale(paymentMethod, discountAmt) {
  try {
    return await Api.post('/api/sales', {
      items: cart.map((l) => ({ product_id: l.product_id, qty: l.qty })),
      customer_id: selectedCustomerId || null,
      associate_id: selectedAssociateId || null,
      discount: discountAmt,
      payment_method: paymentMethod
    });
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

function afterSaleCleanup() {
  cart = [];
  navigate('sale');
  // "Automatically log out user after each sale" (Company Preferences > General)
  if (settingBool('auto_logout_after_sale', false)) {
    Api.clear();
    window.location.href = 'login.html';
  }
}

// Template-driven -- section visibility/order and the title/footer text
// come from the Sales Receipt Print Designer template, same pattern as
// renderVoucherDoc/renderPoDoc. footer_text defaults to the Company
// Preferences receipt message the first time this template is used.
// Sales Receipt is rendered by the generalized Print Designer canvas
// (see renderCanvasDoc / PRINT_FIELD_OPTIONS.salesReceipt below) -- this is
// just the thin entry point everywhere else in the app calls to print one.
function renderReceiptDoc(template, sale) { return renderCanvasDoc('salesReceipt', template, sale); }

// Line/border options for an "Item Lines Table" block element -- matches
// QuickBooks POS's Properties > Border tab: line below the column heading,
// below every item, and/or below the last item. Defaults (heading on,
// per-item off, last-item on) match what the tables already looked like
// before this was configurable, so existing templates don't visually change.
function tableLineOpts(el) {
  return {
    heading: el?.lineHeading !== false,
    each: !!el?.lineEachItem,
    last: el?.lineLast !== false
  };
}
function tableRowBorder(opts, isLast) {
  if (isLast && opts.last) return '1px solid #ccc';
  if (opts.each) return '1px solid #eee';
  return 'none';
}

function receiptLinesBlockHtml(sale, el) {
  const opts = tableLineOpts(el);
  const headBorder = opts.heading ? '1px solid #ccc' : 'none';
  const rows = sale.items;
  return `
    <table style="border-collapse:collapse; width:100%;">
      <thead><tr>
        <th style="text-align:left; border-bottom:${headBorder}; padding:4px;">Item</th>
        <th style="text-align:right; border-bottom:${headBorder}; padding:4px;">Qty</th>
        <th style="text-align:right; border-bottom:${headBorder}; padding:4px;">Total</th>
      </tr></thead>
      <tbody>${rows.map((i, idx) => { const rb = tableRowBorder(opts, idx === rows.length - 1); return `
        <tr>
          <td style="padding:4px; border-bottom:${rb};">${escapeHtml(i.name)}</td>
          <td style="text-align:right; padding:4px; border-bottom:${rb};">${i.qty}</td>
          <td style="text-align:right; padding:4px; border-bottom:${rb};">${money(i.line_total)}</td>
        </tr>`; }).join('')}
      </tbody>
    </table>`;
}

function receiptTotalsBlockHtml(sale) {
  return `
    <div style="font-size:12px;">
      <div style="display:flex; justify-content:space-between;"><span>Subtotal</span><span>${money(sale.subtotal)}</span></div>
      <div style="display:flex; justify-content:space-between;"><span>Discount</span><span>-${money(sale.discount)}</span></div>
      <div style="display:flex; justify-content:space-between;"><span>Tax</span><span>${money(sale.tax)}</span></div>
      <div style="display:flex; justify-content:space-between; font-weight:700; border-top:1px solid #ccc; margin-top:4px; padding-top:4px;"><span>Total</span><span>${money(sale.total)}</span></div>
    </div>`;
}

// =====================================================================
// HOLD SALE (used by Held Receipts + Customer Orders)
// =====================================================================
function holdSale() {
  if (cart.length === 0) { toast('Add at least one item before holding.', 'error'); return; }
  const overlay = openModal(`
    <h2>Hold This Sale</h2>
    <p class="note">
      ${selectedCustomerId ? 'A customer is selected, so this will show up under Customer Orders.' : 'This will show up under Held Receipts until you resume it.'}
    </p>
    <form id="holdForm" class="form-grid">
      <label class="span-all">Label (optional)<input name="label" placeholder="e.g. Table 4, John's order" /></label>
      <div class="modal-actions span-all">
        <button type="button" class="btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="btn btn-primary">Hold Sale</button>
      </div>
    </form>
  `);
  overlay.querySelector('#cancelBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#holdForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      await Api.post('/api/held-sales', { customer_id: selectedCustomerId || null, associate_id: selectedAssociateId || null, label: body.label || null, cart });
      overlay.remove();
      const wasCustomerOrder = !!selectedCustomerId;
      cart = [];
      selectedCustomerId = '';
      selectedAssociateId = '';
      toast('Sale held.', 'success');
      navigate(wasCustomerOrder ? 'customerOrders' : 'heldReceipts');
    } catch (err) { toast(err.message, 'error'); }
  });
}

function heldRowHtml(h, showCustomer) {
  const total = h.cart.reduce((s, l) => s + l.price * l.qty, 0);
  return `
    <tr>
      <td>${escapeHtml(h.label || '(no label)')}</td>
      ${showCustomer ? `<td>${escapeHtml(h.customer_name || '—')}</td>` : ''}
      <td>${h.cart.length}</td>
      <td>${money(total)}</td>
      <td>${escapeHtml(h.held_by || '—')}</td>
      <td>${new Date(h.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
      <td>
        <button class="btn btn-sm resume-btn" data-id="${h.id}">Resume</button>
        <button class="btn btn-sm btn-danger del-btn" data-id="${h.id}">Delete</button>
      </td>
    </tr>
  `;
}

function wireHeldRows(rows, viewName) {
  content.querySelectorAll('.resume-btn').forEach((b) => b.addEventListener('click', async () => {
    const h = rows.find((r) => r.id === Number(b.dataset.id));
    if (!h) return;
    cart = h.cart;
    selectedCustomerId = h.customer_id || '';
    selectedAssociateId = h.associate_id || '';
    try {
      await Api.del(`/api/held-sales/${h.id}`);
      toast('Sale resumed.', 'success');
      navigate('sale');
    } catch (err) { toast(err.message, 'error'); }
  }));
  content.querySelectorAll('.del-btn').forEach((b) => b.addEventListener('click', async () => {
    if (!confirmGuarded('delete', 'Delete this held sale? This cannot be undone.')) return;
    try {
      await Api.del(`/api/held-sales/${b.dataset.id}`);
      navigate(viewName);
    } catch (err) { toast(err.message, 'error'); }
  }));
}

async function renderHeldReceipts() {
  const all = await Api.get('/api/held-sales');
  const rows = all.filter((h) => !h.customer_id);
  content.innerHTML = `
    <div class="view-header"><h1>Held Receipts</h1></div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Label</th><th>Items</th><th>Total</th><th>Held By</th><th>Held At</th><th></th></tr></thead>
        <tbody>${rows.map((h) => heldRowHtml(h, false)).join('') || '<tr><td colspan="6" class="empty-state">No held sales right now -- use "Hold" on the Sale screen to park a cart.</td></tr>'}</tbody>
      </table>
    </div>
  `;
  wireHeldRows(rows, 'heldReceipts');
  attachZoomContextMenu(content.querySelector('.table-wrap'), 'heldReceipts');
}

async function renderCustomerOrders() {
  const rows = await Api.get('/api/held-sales?withCustomer=1');
  content.innerHTML = `
    <div class="view-header">
      <h1>Customer Orders</h1>
      <button class="btn btn-primary" id="newOrderBtn">+ New Order</button>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Label</th><th>Customer</th><th>Items</th><th>Total</th><th>Taken By</th><th>Placed</th><th></th></tr></thead>
        <tbody>${rows.map((h) => heldRowHtml(h, true)).join('') || '<tr><td colspan="7" class="empty-state">No open customer orders -- pick a customer on the Sale screen, then Hold.</td></tr>'}</tbody>
      </table>
    </div>
  `;
  wireHeldRows(rows, 'customerOrders');
  document.getElementById('newOrderBtn').addEventListener('click', () => {
    toast('Pick a customer, add items, then tap Hold to save the order.', '');
    navigate('sale');
  });
  attachZoomContextMenu(content.querySelector('.table-wrap'), 'customerOrders');
}

// =====================================================================
// REWARD MANAGER
// =====================================================================
async function renderRewardManager() {
  const customers = await Api.get('/api/rewards');
  content.innerHTML = `
    <div class="view-header"><h1>Reward Manager</h1></div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Customer</th><th>Email</th><th>Points</th><th></th></tr></thead>
        <tbody>${customers.map((c) => `
          <tr>
            <td>${escapeHtml(c.name)}</td>
            <td>${escapeHtml(c.email || '—')}</td>
            <td><strong>${c.loyalty_points}</strong></td>
            <td>
              <button class="btn btn-sm add-pts-btn" data-id="${c.id}" data-name="${escapeHtml(c.name)}">+ Add</button>
              <button class="btn btn-sm btn-danger redeem-btn" data-id="${c.id}" data-name="${escapeHtml(c.name)}">Redeem</button>
            </td>
          </tr>
        `).join('') || '<tr><td colspan="4" class="empty-state">No customers yet.</td></tr>'}</tbody>
      </table>
    </div>
  `;
  function openAdjustModal(id, name, sign) {
    const overlay = openModal(`
      <h2>${sign > 0 ? 'Add' : 'Redeem'} Points &mdash; ${escapeHtml(name)}</h2>
      <form id="adjForm" class="form-grid">
        <label class="span-all">Points<input name="points" type="number" min="1" step="1" required /></label>
        <div class="modal-actions span-all">
          <button type="button" class="btn" id="cancelBtn">Cancel</button>
          <button type="submit" class="btn btn-primary">Confirm</button>
        </div>
      </form>
    `);
    overlay.querySelector('#cancelBtn').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#adjForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      try {
        await Api.post(`/api/rewards/${id}/adjust`, { delta: sign * Number(body.points) });
        overlay.remove();
        navigate('rewards');
        toast('Points updated.', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  content.querySelectorAll('.add-pts-btn').forEach((b) => b.addEventListener('click', () => openAdjustModal(b.dataset.id, b.dataset.name, 1)));
  content.querySelectorAll('.redeem-btn').forEach((b) => b.addEventListener('click', () => openAdjustModal(b.dataset.id, b.dataset.name, -1)));
  attachZoomContextMenu(content.querySelector('.table-wrap'), 'rewardManager');
}

// =====================================================================
// VENDOR LIST
// =====================================================================
async function renderVendors() {
  const vendors = await Api.get('/api/vendors');
  content.innerHTML = `
    <div class="view-header">
      <h1>Vendor List</h1>
      <button class="btn btn-primary" id="addVendorBtn">+ Add Vendor</button>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Vendor</th><th>Contact</th><th>Email</th><th>Phone</th><th></th></tr></thead>
        <tbody>${vendors.map((v) => `
          <tr>
            <td>${escapeHtml(v.name)}</td>
            <td>${escapeHtml(v.contact_name || '—')}</td>
            <td>${escapeHtml(v.email || '—')}</td>
            <td>${escapeHtml(v.phone || '—')}</td>
            <td><button class="btn btn-sm edit-btn" data-id="${v.id}">Edit</button> <button class="btn btn-sm btn-danger del-btn" data-id="${v.id}">Delete</button></td>
          </tr>
        `).join('') || '<tr><td colspan="5" class="empty-state">No vendors yet.</td></tr>'}</tbody>
      </table>
    </div>
  `;
  content.querySelectorAll('.edit-btn').forEach((b) => b.addEventListener('click', () => openVendorModal(vendors.find((v) => v.id === Number(b.dataset.id)))));
  content.querySelectorAll('.del-btn').forEach((b) => b.addEventListener('click', async () => {
    if (confirmGuarded('delete', 'Delete this vendor?')) { await Api.del(`/api/vendors/${b.dataset.id}`); navigate('vendors'); }
  }));
  document.getElementById('addVendorBtn').addEventListener('click', () => openVendorModal(null));
  attachZoomContextMenu(content.querySelector('.table-wrap'), 'vendors');
}

function openVendorModal(vendor) {
  const isEdit = !!vendor;
  const overlay = openModal(`
    <h2>${isEdit ? 'Edit Vendor' : 'Add Vendor'}</h2>
    <form id="vendorForm" class="form-grid">
      <label>Name<input name="name" required value="${escapeHtml(vendor?.name || '')}" /></label>
      <label>Contact Name<input name="contact_name" value="${escapeHtml(vendor?.contact_name || '')}" /></label>
      <label>Email<input name="email" type="email" value="${escapeHtml(vendor?.email || '')}" /></label>
      <label>Phone<input name="phone" value="${escapeHtml(vendor?.phone || '')}" /></label>
      <label class="span-all">Notes<input name="notes" value="${escapeHtml(vendor?.notes || '')}" /></label>
      <div class="modal-actions span-all">
        <button type="button" class="btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Add Vendor'}</button>
      </div>
    </form>
  `);
  overlay.querySelector('#cancelBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#vendorForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      if (isEdit) await Api.put(`/api/vendors/${vendor.id}`, body);
      else await Api.post('/api/vendors', body);
      overlay.remove();
      navigate('vendors');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// =====================================================================
// PURCHASE ORDERS
// =====================================================================
async function renderPurchaseOrders() {
  const [pos, vendors, products, categories, heldPos] = await Promise.all([
    Api.get('/api/purchase-orders'),
    Api.get('/api/vendors'),
    Api.get('/api/products'),
    Api.get('/api/products/categories'),
    Api.get('/api/held-documents?type=po')
  ]);
  content.innerHTML = `
    <div class="view-header">
      <h1>Purchase Orders</h1>
      <button class="btn btn-primary" id="addPoBtn">+ New Purchase Order</button>
    </div>
    ${heldPos.length > 0 ? `
    <div class="card">
      <h2>${icon('pauseCircle', 16)} Held Purchase Orders</h2>
      <p class="note">Picked up "New Item" mid-PO and held it here so nothing was lost -- Resume to keep going.</p>
      <div class="table-wrap" id="heldPoWrap">
        <table>
          <thead><tr><th>Label</th><th>Items</th><th>Held By</th><th>Held At</th><th></th></tr></thead>
          <tbody>${heldPos.map((h) => `
            <tr>
              <td>${escapeHtml(h.label || '(no label)')}</td>
              <td>${(h.payload.lines || []).length}</td>
              <td>${escapeHtml(h.held_by || '—')}</td>
              <td>${new Date(h.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
              <td><button class="btn btn-sm held-po-resume-btn" data-id="${h.id}">Resume</button> <button class="btn btn-sm btn-danger held-po-del-btn" data-id="${h.id}">Delete</button></td>
            </tr>
          `).join('')}</tbody>
        </table>
      </div>
    </div>` : ''}
    <div class="card table-wrap" id="poListWrap">
      <table>
        <thead><tr><th>PO #</th><th>Vendor</th><th>Items</th><th>Status</th><th>Created</th><th></th></tr></thead>
        <tbody>${pos.map((p) => `
          <tr>
            <td>${escapeHtml(p.po_number)}</td>
            <td>${escapeHtml(p.vendor_name || '—')}</td>
            <td>${p.item_count}</td>
            <td><span class="badge ${p.status === 'received' ? 'badge-ok' : p.status === 'cancelled' ? 'badge-low' : ''}">${escapeHtml(p.status)}</span></td>
            <td>${new Date(p.created_at).toLocaleDateString()}</td>
            <td>${p.status === 'ordered' ? `<button class="btn btn-sm receive-btn" data-id="${p.id}">Receive</button> <button class="btn btn-sm btn-danger cancel-btn" data-id="${p.id}">Cancel</button>` : ''}</td>
          </tr>
        `).join('') || '<tr><td colspan="6" class="empty-state">No purchase orders yet.</td></tr>'}</tbody>
      </table>
    </div>
  `;
  content.querySelectorAll('.receive-btn').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Mark this purchase order received? This adds the ordered quantities to your item stock.')) return;
    try {
      await Api.post(`/api/purchase-orders/${b.dataset.id}/receive`, {});
      navigate('purchaseOrders');
      toast('Purchase order received.', 'success');
    } catch (err) { toast(err.message, 'error'); }
  }));
  content.querySelectorAll('.cancel-btn').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Cancel this purchase order?')) return;
    await Api.post(`/api/purchase-orders/${b.dataset.id}/cancel`, {});
    navigate('purchaseOrders');
  }));
  document.getElementById('addPoBtn').addEventListener('click', () => openPoModal(vendors, products, categories));
  content.querySelectorAll('.held-po-resume-btn').forEach((b) => b.addEventListener('click', async () => {
    const h = heldPos.find((x) => x.id === Number(b.dataset.id));
    if (!h) return;
    try {
      await Api.del(`/api/held-documents/${h.id}`);
      toast('Purchase order resumed.', 'success');
      openPoModal(vendors, products, categories, h.payload);
    } catch (err) { toast(err.message, 'error'); }
  }));
  content.querySelectorAll('.held-po-del-btn').forEach((b) => b.addEventListener('click', async () => {
    if (!confirmGuarded('delete', 'Delete this held purchase order? This cannot be undone.')) return;
    await Api.del(`/api/held-documents/${b.dataset.id}`);
    navigate('purchaseOrders');
  }));
  attachZoomContextMenu(document.getElementById('heldPoWrap'), 'heldPo');
  attachZoomContextMenu(document.getElementById('poListWrap'), 'purchaseOrders');
}

// Purchase Order print document -- store header, vendor, line items with
// cost/ext cost, and notes. Used by the "Save & Print" button below.
// Template-driven -- `data` is { po, vendorName }. Section visibility/order
// and the title/footer text come from the Purchase Order Print Designer
// template, same pattern as renderVoucherDoc.
// Purchase Order is rendered by the generalized Print Designer canvas --
// see renderCanvasDoc / PRINT_FIELD_OPTIONS.purchaseOrder below. `data` is
// { po, vendorName }.
function renderPoDoc(template, data) { return renderCanvasDoc('purchaseOrder', template, data); }

function poLinesBlockHtml(po, el) {
  const opts = tableLineOpts(el);
  const headBorder = opts.heading ? '1px solid #ccc' : 'none';
  const rows = po.items;
  return `
    <table style="border-collapse:collapse; width:100%;">
      <thead><tr>
        <th style="text-align:left; border-bottom:${headBorder}; padding:4px;">Item</th>
        <th style="text-align:right; border-bottom:${headBorder}; padding:4px;">Qty Ordered</th>
        <th style="text-align:right; border-bottom:${headBorder}; padding:4px;">Cost</th>
        <th style="text-align:right; border-bottom:${headBorder}; padding:4px;">Ext. Cost</th>
      </tr></thead>
      <tbody>${rows.map((i, idx) => { const rb = tableRowBorder(opts, idx === rows.length - 1); return `
        <tr>
          <td style="padding:4px; border-bottom:${rb};">${escapeHtml(i.name)}</td>
          <td style="text-align:right; padding:4px; border-bottom:${rb};">${i.qty_ordered}</td>
          <td style="text-align:right; padding:4px; border-bottom:${rb};">${money(i.cost)}</td>
          <td style="text-align:right; padding:4px; border-bottom:${rb};">${money((Number(i.qty_ordered) || 0) * (Number(i.cost) || 0))}</td>
        </tr>`; }).join('')}
      </tbody>
    </table>`;
}

function poTotalsBlockHtml(po) {
  const total = po.items.reduce((s, i) => s + (Number(i.qty_ordered) || 0) * (Number(i.cost) || 0), 0);
  return `
    <div style="font-size:12px; font-weight:700; border-top:1px solid #ccc; padding-top:4px; display:flex; justify-content:space-between;">
      <span>Total</span><span>${money(total)}</span>
    </div>`;
}

function openPoModal(vendors, products, categories, initialDraft) {
  if (products.length === 0) { toast('Add an item to your Item List before creating a purchase order.', 'error'); return; }
  let lines = initialDraft?.lines?.length ? initialDraft.lines : [{ product_id: products[0].id, qty_ordered: 1, cost: products[0].cost || 0 }];
  let activeColumns = poLineColumnStore.load();

  const overlay = openModal(`
    <h2>New Purchase Order</h2>
    <form id="poForm" class="form-grid">
      <label class="span-all">Vendor
        <select name="vendor_id">
          <option value="">No vendor</option>
          ${vendors.map((v) => `<option value="${v.id}" ${String(initialDraft?.vendor_id || '') === String(v.id) ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('')}
        </select>
      </label>
      <div class="row-between span-all">
        <div class="pref-section-label">Items</div>
        <div class="btn-group">
          <button type="button" class="btn btn-sm" id="poCustomizeColumnsBtn">${icon('columns', 14)} <span><span class="hide-phone">Customize&nbsp;</span>Columns</span></button>
          <button type="button" class="btn btn-sm" id="addLineBtn">+ Add Line</button>
        </div>
      </div>
      <div class="sale-search-row span-all">
        <div class="receive-search-wrap">
          <input type="search" class="search-input" id="poSearch"
            placeholder="Type an item name, SKU, or barcode&hellip; (or scan a barcode)" autocomplete="off" />
          <div class="receive-suggestions" id="poSuggestions" hidden></div>
        </div>
        <button type="button" class="btn" id="poScanBtn" title="Scan with camera">${icon('camera', 14)} Scan</button>
        <button type="button" class="btn" id="poFindItemsBtn">${icon('search', 14)} Find Item(s)</button>
      </div>
      <div class="table-wrap span-all">
        <table>
          <thead><tr id="poHeadRow"></tr></thead>
          <tbody id="poLines"></tbody>
        </table>
      </div>
      <label class="span-all">Notes<input name="notes" value="${escapeHtml(initialDraft?.notes || '')}" /></label>
      <div class="modal-actions span-all between">
        <button type="button" class="btn btn-danger" id="cancelBtn">Cancel</button>
        <div>
          <button type="button" class="btn" id="holdPoBtn" title="Park this PO and come back to it later -- handy if you need to step out to Item List first">${icon('pauseCircle', 14)} Hold PO</button>
          <button type="button" class="btn" id="saveOnlyBtn">Save Only</button>
          <button type="button" class="btn btn-primary" id="savePrintBtn">Save &amp; Print</button>
        </div>
      </div>
    </form>
  `, 'modal-lg');

  const linesEl = overlay.querySelector('#poLines');
  const searchInput = overlay.querySelector('#poSearch');
  const suggestionsEl = overlay.querySelector('#poSuggestions');

  // Adding via search/Find Item(s) bumps qty on an existing line for that
  // product rather than creating a duplicate row -- same behavior as
  // Receive Items and Make a Sale.
  function addPoLine(product) {
    if (!product) return;
    const existing = lines.find((l) => String(l.product_id) === String(product.id));
    if (existing) existing.qty_ordered = (Number(existing.qty_ordered) || 0) + 1;
    else lines.push({ product_id: product.id, qty_ordered: 1, cost: product.cost || 0 });
    drawLines();
  }

  // With no query, show everything (scrollable) -- lets someone click into
  // the search box and browse the full item list, same as the dropdown
  // arrow on QuickBooks POS's "Enter Item(s)" field.
  function matchesFor(q) {
    q = q.trim().toLowerCase();
    if (!q) return products.slice(0, 50);
    return products
      .filter((p) => p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q) || (p.barcode || '').toLowerCase().includes(q) || (p.item_number || '').toLowerCase().includes(q))
      .slice(0, 50);
  }

  // Re-fetches the item list in place (used after "+ Add New Item") without
  // closing this PO -- same fix already in place on Receive Items, so
  // picking a new item mid-PO no longer means losing everything typed so far.
  async function refreshProducts() {
    products = await Api.get('/api/products');
  }

  function hideSuggestions() { suggestionsEl.hidden = true; suggestionsEl.innerHTML = ''; }

  function drawSuggestions(list) {
    suggestionsEl.hidden = false;
    suggestionsEl.innerHTML = `
      <button type="button" class="receive-suggestion-item sale-add-new-item" id="poAddNewItemBtn">+ Add New Item</button>
      ${list.map((p) => `
        <button type="button" class="receive-suggestion-item" data-id="${p.id}">
          <span><strong>${escapeHtml(p.sku || '—')}</strong>&nbsp; ${escapeHtml(p.name)}</span>
          <span class="receive-suggestion-meta">${money(p.cost)} cost &middot; ${p.qty_on_hand} on hand</span>
        </button>
      `).join('') || `<div class="empty-state compact">No items match.</div>`}
    `;
    suggestionsEl.querySelector('#poAddNewItemBtn').addEventListener('click', () => {
      hideSuggestions();
      openProductModal(categories, null, async (saved) => {
        await refreshProducts();
        toast(`${saved.name} added to Item List.`, 'success');
        searchInput.focus();
      });
    });
    suggestionsEl.querySelectorAll('.receive-suggestion-item[data-id]').forEach((btn) => btn.addEventListener('click', () => {
      addPoLine(products.find((p) => p.id === Number(btn.dataset.id)));
      searchInput.value = '';
      hideSuggestions();
      searchInput.focus();
    }));
  }

  searchInput.addEventListener('input', () => drawSuggestions(matchesFor(searchInput.value)));
  searchInput.addEventListener('focus', () => drawSuggestions(matchesFor(searchInput.value)));
  searchInput.addEventListener('blur', () => setTimeout(hideSuggestions, 150));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = searchInput.value.trim().toLowerCase();
    if (!q) return;
    // Exact barcode/SKU/item number match takes priority -- lets a barcode
    // scanner (including a self-printed Item Number tag) add lines with no
    // clicking at all.
    const exact = products.find((p) => (p.barcode || '').toLowerCase() === q || (p.sku || '').toLowerCase() === q || (p.item_number || '').toLowerCase() === q);
    const candidate = exact || matchesFor(q)[0];
    if (candidate) {
      addPoLine(candidate);
      searchInput.value = '';
      hideSuggestions();
    }
  });

  overlay.querySelector('#poFindItemsBtn').addEventListener('click', () => openFindItemsModal(products, addPoLine));
  overlay.querySelector('#poScanBtn').addEventListener('click', () => scanBarcodeInto(products, searchInput, matchesFor, drawSuggestions, addPoLine));

  function drawHead() {
    overlay.querySelector('#poHeadRow').innerHTML =
      activeColumns.map((key) => {
        const c = PO_LINE_COLUMNS.find((x) => x.key === key);
        return `<th>${escapeHtml(c ? c.label : key)}</th>`;
      }).join('') + '<th></th>';
  }

  function cellFor(key, l, i) {
    const product = products.find((p) => p.id === Number(l.product_id));
    switch (key) {
      case 'item_number': return `<td>${escapeHtml(product?.item_number || '—')}</td>`;
      case 'sku': return `<td>${escapeHtml(product?.sku || '—')}</td>`;
      case 'category_name': return `<td>${escapeHtml(product?.category_name || '—')}</td>`;
      case 'on_hand': return `<td>${product ? product.qty_on_hand : '—'}</td>`;
      case 'item': return `<td><select data-i="${i}" class="line-product">
          ${products.map((p) => `<option value="${p.id}" ${String(l.product_id) === String(p.id) ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}
        </select></td>`;
      case 'qty': return `<td><input data-i="${i}" class="line-qty" type="number" min="0" step="1" value="${l.qty_ordered}" /></td>`;
      case 'cost': return `<td><input data-i="${i}" class="line-cost" type="number" min="0" step="0.01" value="${l.cost}" /></td>`;
      case 'ext_cost': return `<td class="line-ext-cost" data-i="${i}">${money((Number(l.qty_ordered) || 0) * (Number(l.cost) || 0))}</td>`;
      default: return `<td>—</td>`;
    }
  }

  function updateExtCost(i) {
    const cell = linesEl.querySelector(`.line-ext-cost[data-i="${i}"]`);
    if (cell) cell.textContent = money((Number(lines[i].qty_ordered) || 0) * (Number(lines[i].cost) || 0));
  }

  function drawLines() {
    linesEl.innerHTML = lines.map((l, i) => `
      <tr>
        ${activeColumns.map((key) => cellFor(key, l, i)).join('')}
        <td><button type="button" class="btn btn-sm btn-danger line-remove" data-i="${i}" ${lines.length === 1 ? 'disabled' : ''}>✕<span class="line-remove-label"> Remove</span></button></td>
      </tr>
    `).join('');
    linesEl.querySelectorAll('.line-product').forEach((sel) => sel.addEventListener('change', (e) => {
      const i = Number(e.target.dataset.i);
      lines[i].product_id = e.target.value;
      const prod = products.find((p) => p.id === Number(e.target.value));
      if (prod) lines[i].cost = prod.cost || 0;
      drawLines();
    }));
    linesEl.querySelectorAll('.line-qty').forEach((inp) => inp.addEventListener('input', (e) => {
      lines[Number(e.target.dataset.i)].qty_ordered = e.target.value;
      updateExtCost(Number(e.target.dataset.i));
    }));
    linesEl.querySelectorAll('.line-cost').forEach((inp) => inp.addEventListener('input', (e) => {
      lines[Number(e.target.dataset.i)].cost = e.target.value;
      updateExtCost(Number(e.target.dataset.i));
    }));
    linesEl.querySelectorAll('.line-remove').forEach((b) => b.addEventListener('click', () => { lines.splice(Number(b.dataset.i), 1); drawLines(); }));
  }

  drawHead();
  drawLines();
  autoFocus(searchInput);
  hideSuggestions();

  overlay.querySelector('#addLineBtn').addEventListener('click', () => { lines.push({ product_id: products[0].id, qty_ordered: 1, cost: products[0].cost || 0 }); drawLines(); });
  overlay.querySelector('#poCustomizeColumnsBtn').addEventListener('click', () => {
    openColumnCustomizerModal(PO_LINE_COLUMNS, DEFAULT_PO_LINE_COLUMNS, activeColumns, (newColumns) => {
      activeColumns = newColumns;
      poLineColumnStore.save(newColumns);
      drawHead();
      drawLines();
      toast('Columns updated.', 'success');
    });
  });
  overlay.querySelector('#cancelBtn').addEventListener('click', () => overlay.remove());

  // Parks this PO server-side (survives navigating away, closing the tab,
  // even logging out) so stepping out to Item List for a new item never
  // means losing what's already been entered -- see Purchase Orders'
  // "Held Purchase Orders" section for Resume/Delete.
  overlay.querySelector('#holdPoBtn').addEventListener('click', async () => {
    const activeLines = lines.filter((l) => Number(l.qty_ordered) > 0);
    if (activeLines.length === 0) { toast('Add at least one item before holding.', 'error'); return; }
    const vendor_id = overlay.querySelector('[name="vendor_id"]').value || null;
    const notes = overlay.querySelector('[name="notes"]').value || null;
    const vendorName = vendors.find((v) => String(v.id) === String(vendor_id))?.name;
    try {
      await Api.post('/api/held-documents', {
        doc_type: 'po',
        label: vendorName || null,
        payload: { vendor_id, notes, lines: activeLines }
      });
      overlay.remove();
      toast('Purchase order held -- resume it anytime from Purchase Orders.', 'success');
      navigate('purchaseOrders');
    } catch (err) { toast(err.message, 'error'); }
  });

  async function submitPo() {
    const vendor_id = overlay.querySelector('[name="vendor_id"]').value || null;
    const notes = overlay.querySelector('[name="notes"]').value || null;
    const items = lines
      .filter((l) => Number(l.qty_ordered) > 0)
      .map((l) => {
        const prod = products.find((p) => p.id === Number(l.product_id));
        return { product_id: l.product_id || null, name: prod ? prod.name : 'Item', qty_ordered: Number(l.qty_ordered), cost: Number(l.cost) || 0 };
      });
    if (items.length === 0) { toast('Add at least one item with a quantity.', 'error'); return null; }
    try {
      return await Api.post('/api/purchase-orders', { vendor_id, notes, items });
    } catch (err) {
      toast(err.message, 'error');
      return null;
    }
  }

  overlay.querySelector('#saveOnlyBtn').addEventListener('click', async () => {
    const po = await submitPo();
    if (!po) return;
    overlay.remove();
    toast('Purchase order created.', 'success');
    navigate('purchaseOrders');
  });

  overlay.querySelector('#savePrintBtn').addEventListener('click', async () => {
    const po = await submitPo();
    if (!po) return;
    overlay.remove();
    toast('Purchase order created.', 'success');
    const vendorName = vendors.find((v) => String(v.id) === String(po.vendor_id))?.name;
    openPrintDoc(`Purchase Order ${po.po_number}`, renderPoDoc(getPrintTemplate('purchaseOrder'), { po, vendorName }), { margin: printMarginFor('purchaseOrder') });
    navigate('purchaseOrders');
  });
}

// =====================================================================
// RECEIVING HISTORY
// =====================================================================
async function renderReceivingHistory() {
  content.innerHTML = `
    <div class="view-header">
      <h1>Receiving History</h1>
      <div class="view-actions">
        ${dateRangeBarHtml({ presetId: 'rhRangePreset', fromId: 'rhFromDate', toId: 'rhToDate', applyId: 'rhApplyBtn', includeAll: true })}
      </div>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Item</th><th>Qty</th><th>Cost</th><th>PO #</th><th>Received By</th></tr></thead>
        <tbody id="rhBody"><tr><td colspan="6" class="empty-state">Loading&hellip;</td></tr></tbody>
      </table>
    </div>
  `;

  const presetSelect = document.getElementById('rhRangePreset');
  const fromInput = document.getElementById('rhFromDate');
  const toInput = document.getElementById('rhToDate');
  wireDateRangePreset(presetSelect, fromInput, toInput);

  async function run() {
    const qs = new URLSearchParams();
    if (fromInput.value) qs.set('from', fromInput.value);
    if (toInput.value) qs.set('to', toInput.value);
    const rows = await Api.get(`/api/receiving?${qs.toString()}`);
    document.getElementById('rhBody').innerHTML = rows.map((r) => `
      <tr>
        <td>${new Date(r.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
        <td>${escapeHtml(r.product_name || '—')}</td>
        <td>${r.qty}</td>
        <td>${r.cost != null ? money(r.cost) : '—'}</td>
        <td>${escapeHtml(r.po_number || '—')}</td>
        <td>${escapeHtml(r.received_by || '—')}</td>
      </tr>
    `).join('') || '<tr><td colspan="6" class="empty-state">No stock was received in this range.</td></tr>';
  }

  document.getElementById('rhApplyBtn').addEventListener('click', run);
  run();
  attachZoomContextMenu(content.querySelector('.table-wrap'), 'receivingHistory');
}

// =====================================================================
// CLOCK IN/OUT
// =====================================================================
async function renderClockInOut() {
  const [status, history] = await Promise.all([
    Api.get('/api/time-clock/status'),
    Api.get('/api/time-clock')
  ]);
  const isAdmin = CURRENT_USER.role === 'admin';
  content.innerHTML = `
    <div class="view-header"><h1>Time Clock</h1></div>
    <div class="card card-center">
      <p class="clock-status">
        You are currently <strong>${status.clockedIn ? 'clocked in' : 'clocked out'}</strong>.
        ${status.clockedIn ? `<br><small>Since ${new Date(status.entry.clock_in).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</small>` : ''}
      </p>
      <button class="btn ${status.clockedIn ? 'btn-danger' : 'btn-success'} btn-block btn-lg clock-btn" id="clockBtn">
        ${status.clockedIn ? 'Clock Out' : 'Clock In'}
      </button>
    </div>
    <div class="card table-wrap">
      <h2>${isAdmin ? 'Everyone&rsquo;s' : 'Your'} Recent Punches</h2>
      <table>
        <thead><tr>${isAdmin ? '<th>Employee</th>' : ''}<th>Clock In</th><th>Clock Out</th><th>Hours</th></tr></thead>
        <tbody>${history.map((h) => `
          <tr>
            ${isAdmin ? `<td>${escapeHtml(h.employee_name)}</td>` : ''}
            <td>${new Date(h.clock_in).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
            <td>${h.clock_out ? new Date(h.clock_out).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '<span class="badge">Open</span>'}</td>
            <td>${h.clock_out ? (((new Date(h.clock_out) - new Date(h.clock_in)) / 3600000).toFixed(2)) : '—'}</td>
          </tr>
        `).join('') || `<tr><td colspan="${isAdmin ? 4 : 3}" class="empty-state">No punches yet.</td></tr>`}</tbody>
      </table>
    </div>
  `;
  document.getElementById('clockBtn').addEventListener('click', async () => {
    try {
      await Api.post(status.clockedIn ? '/api/time-clock/clock-out' : '/api/time-clock/clock-in', {});
      toast(status.clockedIn ? 'Clocked out.' : 'Clocked in.', 'success');
      navigate('clockInOut');
    } catch (err) { toast(err.message, 'error'); }
  });
  attachZoomContextMenu(content.querySelector('.table-wrap'), 'clockInOut');
}

// =====================================================================
// RECEIVING VOUCHER PRINT TEMPLATE (edited from Tools > Print Designer,
// applied when a voucher is printed from Receive Items)
// =====================================================================

// Receiving Voucher is rendered by the generalized Print Designer canvas --
// see renderCanvasDoc / PRINT_FIELD_OPTIONS.receivingVoucher below.
function renderVoucherDoc(template, data) { return renderCanvasDoc('receivingVoucher', template, data); }

function voucherLinesBlockHtml(data, el) {
  const opts = tableLineOpts(el);
  const headBorder = opts.heading ? '1px solid #ccc' : 'none';
  const rows = data.lines;
  return `
    <table style="border-collapse:collapse; width:100%;">
      <thead><tr>
        <th style="text-align:left; border-bottom:${headBorder}; padding:4px;">Item</th>
        <th style="text-align:right; border-bottom:${headBorder}; padding:4px;">Qty</th>
        <th style="text-align:right; border-bottom:${headBorder}; padding:4px;">Cost</th>
        <th style="text-align:right; border-bottom:${headBorder}; padding:4px;">Ext.</th>
      </tr></thead>
      <tbody>${rows.map((l, idx) => { const rb = tableRowBorder(opts, idx === rows.length - 1); return `
        <tr>
          <td style="padding:4px; border-bottom:${rb};">${escapeHtml(l.name)}</td>
          <td style="text-align:right; padding:4px; border-bottom:${rb};">${l.qty}</td>
          <td style="text-align:right; padding:4px; border-bottom:${rb};">${money(l.cost)}</td>
          <td style="text-align:right; padding:4px; border-bottom:${rb};">${money(l.qty * l.cost)}</td>
        </tr>`; }).join('') || `<tr><td colspan="4" style="padding:4px; color:#888;">No items.</td></tr>`}
      </tbody>
    </table>`;
}

function voucherTotalsBlockHtml(data) {
  return `
    <div style="font-size:12px;">
      <div style="display:flex; justify-content:space-between;"><span>Subtotal</span><span>${money(data.subtotal)}</span></div>
      <div style="display:flex; justify-content:space-between;"><span>Discount (${data.discountPct || 0}%)</span><span>-${money(data.discountAmt)}</span></div>
      <div style="display:flex; justify-content:space-between;"><span>Freight</span><span>${money(data.freight)}</span></div>
      <div style="display:flex; justify-content:space-between;"><span>Fee</span><span>${money(data.fee)}</span></div>
      <div style="display:flex; justify-content:space-between; font-weight:700; border-top:1px solid #ccc; margin-top:4px; padding-top:4px;"><span>Total</span><span>${money(data.total)}</span></div>
    </div>`;
}

// Sample data used purely for the Print Designer's live preview -- never
// sent anywhere, just illustrates what a real voucher will look like.
const SAMPLE_VOUCHER_DATA = {
  storeName: 'Saffron POS',
  date: new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
  receivedBy: 'Jane Cashier',
  lines: [
    { name: 'Nourishing Shampoo 518ml', qty: 10, cost: 143 },
    { name: 'Anti Dandruff Shampoo', qty: 5, cost: 97 }
  ],
  subtotal: 1915, discountPct: 5, discountAmt: 95.75, freight: 50, fee: 0, total: 1869.25
};

// =====================================================================
// PRINT DESIGNER -- generalized free-form canvas registry
//
// Every document type shares one template shape: { elements: [...] }.
// Each element is { id, type: 'field'|'text'|'logo'|'line', x, y, w, h,
// fontSize, bold, align, fieldKey? (for 'field'), text? (for 'text'),
// thickness?/orientation? (for 'line') } -- freely positioned/resized on a
// fixed-size canvas, matching QuickBooks POS's drag-and-drop Print Designer.
// `fieldOptions` lists what a 'field' element can be bound to; fields
// flagged `isBlock` render a whole pre-built block (an item table, a totals
// summary, etc.) instead of a single line of text -- position/size still
// apply, but a block's *content* isn't individually draggable, since an
// item table's row count changes every time it prints.
// =====================================================================
const PRINT_FIELD_OPTIONS = {
  receivingVoucher: [
    { key: 'storeName', label: 'Store Name', value: (d) => d.storeName || 'Saffron POS' },
    { key: 'voucherTitle', label: 'Voucher Title', value: () => 'Receiving Voucher' },
    { key: 'dateReceivedBy', label: 'Date & Received By', value: (d) => `${d.date} · Received by ${d.receivedBy}` },
    { key: 'itemsTable', label: 'Item Lines Table', isBlock: true, value: (d, el) => voucherLinesBlockHtml(d, el) },
    { key: 'costSummary', label: 'Cost Summary', isBlock: true, value: (d) => voucherTotalsBlockHtml(d) }
  ],
  salesReceipt: [
    { key: 'storeName', label: 'Store Name', value: () => COMPANY_SETTINGS.store_name || 'Saffron POS' },
    { key: 'receiptTitle', label: 'Receipt #', value: (d) => `Sales Receipt #${d.sale_number}` },
    { key: 'date', label: 'Date', value: (d) => new Date(d.created_at || Date.now()).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) },
    { key: 'cashierName', label: 'Cashier Name', value: (d) => `Cashier: ${d.cashier_name || '—'}` },
    { key: 'associateName', label: 'Associate Name', value: (d) => `Associate: ${d.associate_name || '—'}` },
    { key: 'itemsTable', label: 'Item Lines Table', isBlock: true, value: (d, el) => receiptLinesBlockHtml(d, el) },
    { key: 'totals', label: 'Totals Summary', isBlock: true, value: (d) => receiptTotalsBlockHtml(d) }
  ],
  purchaseOrder: [
    { key: 'storeName', label: 'Store Name', value: () => COMPANY_SETTINGS.store_name || 'Saffron POS' },
    { key: 'poTitle', label: 'PO # & Date', value: (d) => `Purchase Order ${d.po.po_number} · ${new Date(d.po.created_at || Date.now()).toLocaleDateString()}` },
    { key: 'vendor', label: 'Vendor', value: (d) => `Vendor: ${d.vendorName || '—'}` },
    { key: 'itemsTable', label: 'Item Lines Table', isBlock: true, value: (d, el) => poLinesBlockHtml(d.po, el) },
    { key: 'totalCost', label: 'Total Cost', isBlock: true, value: (d) => poTotalsBlockHtml(d.po) },
    { key: 'notes', label: 'Order Notes', isBlock: true, value: (d) => d.po.notes ? `<p style="font-size:11px; color:#666;"><strong>Notes:</strong> ${escapeHtml(d.po.notes)}</p>` : '' }
  ],
  customerId: [
    { key: 'fullName', label: 'Full Name', value: (d) => d.name || '' },
    { key: 'memberId', label: 'Member ID#', value: (d) => `CUST-${String(d.id).padStart(6, '0')}` },
    { key: 'email', label: 'Email', value: (d) => d.email || '' },
    { key: 'phone', label: 'Phone', value: (d) => d.phone || '' },
    { key: 'loyaltyPoints', label: 'Loyalty Points', value: (d) => String(d.loyalty_points ?? '') },
    { key: 'barcode', label: 'Barcode (Member ID)', isBarcode: true, value: (d) => `CUST-${String(d.id).padStart(6, '0')}` }
  ],
  inventoryTag: [
    { key: 'itemName', label: 'Item Name', value: (d) => d.name || '' },
    { key: 'itemNumber', label: 'Item Number', value: (d) => d.item_number || '—' },
    { key: 'sku', label: 'SKU', value: (d) => d.sku || '—' },
    { key: 'price', label: 'Price', value: (d) => money(d.price) },
    { key: 'storeName', label: 'Store Name', value: () => COMPANY_SETTINGS.store_name || 'Saffron POS' },
    { key: 'barcode', label: 'Barcode (Item Number)', isBarcode: true, value: (d) => d.item_number || d.sku || String(d.id) }
  ]
};

// x/y/w/h are design-canvas pixels -- see PRINT_DOC_TYPES[key].canvasSize.
const PRINT_DEFAULT_ELEMENTS = {
  receivingVoucher: [
    { id: 'e1', type: 'field', fieldKey: 'storeName', x: 10, y: 10, w: 360, h: 22, fontSize: 15, bold: true, align: 'center' },
    { id: 'e2', type: 'field', fieldKey: 'voucherTitle', x: 10, y: 34, w: 360, h: 16, fontSize: 12, align: 'center' },
    { id: 'e3', type: 'field', fieldKey: 'dateReceivedBy', x: 10, y: 52, w: 360, h: 14, fontSize: 10, align: 'center' },
    { id: 'e4', type: 'field', fieldKey: 'itemsTable', x: 10, y: 74, w: 360, h: 220, fontSize: 11, align: 'left' },
    { id: 'e5', type: 'field', fieldKey: 'costSummary', x: 10, y: 300, w: 360, h: 90, fontSize: 11, align: 'left' },
    { id: 'e6', type: 'text', text: '', x: 10, y: 396, w: 360, h: 30, fontSize: 9, align: 'center' }
  ],
  salesReceipt: [
    { id: 'e1', type: 'field', fieldKey: 'storeName', x: 10, y: 10, w: 280, h: 20, fontSize: 14, bold: true, align: 'center' },
    { id: 'e2', type: 'field', fieldKey: 'receiptTitle', x: 10, y: 32, w: 280, h: 16, fontSize: 11, align: 'center' },
    { id: 'e3', type: 'field', fieldKey: 'date', x: 10, y: 50, w: 280, h: 14, fontSize: 9, align: 'center' },
    { id: 'e4', type: 'field', fieldKey: 'itemsTable', x: 10, y: 70, w: 280, h: 180, fontSize: 11, align: 'left' },
    { id: 'e5', type: 'field', fieldKey: 'totals', x: 10, y: 256, w: 280, h: 80, fontSize: 11, align: 'left' },
    { id: 'e6', type: 'text', text: '', x: 10, y: 344, w: 280, h: 40, fontSize: 9, align: 'center' }
  ],
  purchaseOrder: [
    { id: 'e1', type: 'field', fieldKey: 'storeName', x: 10, y: 10, w: 360, h: 22, fontSize: 15, bold: true, align: 'center' },
    { id: 'e2', type: 'field', fieldKey: 'poTitle', x: 10, y: 34, w: 360, h: 16, fontSize: 12, align: 'center' },
    { id: 'e3', type: 'field', fieldKey: 'vendor', x: 10, y: 52, w: 360, h: 14, fontSize: 10, align: 'center' },
    { id: 'e4', type: 'field', fieldKey: 'itemsTable', x: 10, y: 74, w: 360, h: 220, fontSize: 11, align: 'left' },
    { id: 'e5', type: 'field', fieldKey: 'totalCost', x: 10, y: 300, w: 360, h: 26, fontSize: 11, align: 'left' },
    { id: 'e6', type: 'field', fieldKey: 'notes', x: 10, y: 330, w: 360, h: 40, fontSize: 10, align: 'left' },
    { id: 'e7', type: 'text', text: '', x: 10, y: 376, w: 360, h: 30, fontSize: 9, align: 'center' }
  ],
  customerId: [
    { id: 'e1', type: 'text', text: 'Member ID Card', x: 10, y: 8, w: 280, h: 18, fontSize: 12, bold: true, align: 'center' },
    { id: 'e2', type: 'field', fieldKey: 'fullName', x: 10, y: 34, w: 280, h: 22, fontSize: 15, bold: true, align: 'center' },
    { id: 'e3', type: 'field', fieldKey: 'memberId', x: 10, y: 58, w: 280, h: 16, fontSize: 11, align: 'center' },
    { id: 'e4', type: 'field', fieldKey: 'barcode', isBarcode: true, x: 40, y: 88, w: 220, h: 56, align: 'center' }
  ],
  inventoryTag: [
    { id: 'e1', type: 'field', fieldKey: 'itemName', x: 6, y: 4, w: 208, h: 16, fontSize: 11, bold: true, align: 'center' },
    { id: 'e2', type: 'field', fieldKey: 'itemNumber', x: 6, y: 20, w: 208, h: 12, fontSize: 9, align: 'center' },
    { id: 'e3', type: 'field', fieldKey: 'price', x: 6, y: 34, w: 208, h: 18, fontSize: 13, bold: true, align: 'center' },
    { id: 'e4', type: 'field', fieldKey: 'barcode', x: 14, y: 54, w: 192, h: 46, align: 'center' }
  ]
};

const PRINT_DOC_TYPES = {
  receivingVoucher: {
    label: 'Receiving Voucher',
    settingsKey: 'print_template_receiving_voucher',
    canvasSize: { w: 380, h: 440 },
    fieldOptions: PRINT_FIELD_OPTIONS.receivingVoucher,
    render: (template, data) => renderCanvasDoc('receivingVoucher', template, data),
    sampleData: () => SAMPLE_VOUCHER_DATA
  },
  salesReceipt: {
    label: 'Sales Receipt',
    settingsKey: 'print_template_sales_receipt',
    canvasSize: { w: 300, h: 400 },
    fieldOptions: PRINT_FIELD_OPTIONS.salesReceipt,
    render: (template, data) => renderCanvasDoc('salesReceipt', template, data),
    sampleData: () => ({
      sale_number: '000123',
      created_at: new Date().toISOString(),
      cashier_name: 'Jane Cashier',
      associate_name: 'Mark Santos',
      items: [
        { name: 'Nourishing Shampoo 518ml', qty: 2, line_total: 286 },
        { name: 'Anti Dandruff Shampoo', qty: 1, line_total: 97 }
      ],
      subtotal: 383, discount: 0, tax: 31.6, total: 414.6
    })
  },
  purchaseOrder: {
    label: 'Purchase Order',
    settingsKey: 'print_template_purchase_order',
    canvasSize: { w: 380, h: 440 },
    fieldOptions: PRINT_FIELD_OPTIONS.purchaseOrder,
    render: (template, data) => renderCanvasDoc('purchaseOrder', template, data),
    sampleData: () => ({
      po: {
        po_number: 'PO-00042',
        created_at: new Date().toISOString(),
        notes: 'Deliver to the back entrance.',
        items: [
          { name: 'Nourishing Shampoo 518ml', qty_ordered: 20, cost: 143 },
          { name: 'Anti Dandruff Shampoo', qty_ordered: 10, cost: 97 }
        ]
      },
      vendorName: 'Unilever Distribution Co.'
    })
  },
  customerId: {
    label: 'Customer ID Card',
    settingsKey: 'print_template_customer_id',
    canvasSize: { w: 300, h: 150 },
    fieldOptions: PRINT_FIELD_OPTIONS.customerId,
    render: (template, data) => renderCanvasDoc('customerId', template, data),
    sampleData: () => ({ id: 12, name: 'David Worth', email: 'david@example.com', phone: '555-0142', loyalty_points: 240 })
  },
  inventoryTag: {
    label: 'Inventory Tag',
    settingsKey: 'print_template_inventory_tag',
    canvasSize: { w: 220, h: 110 },
    fieldOptions: PRINT_FIELD_OPTIONS.inventoryTag,
    render: (template, data) => renderCanvasDoc('inventoryTag', template, data),
    sampleData: () => ({ id: 7, name: 'Nourishing Shampoo 518ml', item_number: '000007', sku: 'SH-518', price: 143 })
  }
};

// `margin` is the blank page margin around the printed sheet (not the
// card's own width/height, which is `canvasSize`) -- defaults to 24px, the
// same padding every print window used to have hardcoded. Shrinking it
// reclaims page space a thrifty printer doesn't need; it can also be made
// bigger again just as easily.
const DEFAULT_PRINT_MARGIN = 24;

function defaultPrintTemplate(docKey) {
  return { elements: JSON.parse(JSON.stringify(PRINT_DEFAULT_ELEMENTS[docKey])), margin: DEFAULT_PRINT_MARGIN };
}

function getPrintTemplate(docKey) {
  const meta = PRINT_DOC_TYPES[docKey];
  const raw = COMPANY_SETTINGS[meta.settingsKey];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.elements)) return parsed;
    } catch (e) { /* fall through to default */ }
  }
  return defaultPrintTemplate(docKey);
}

function printMarginFor(docKey) {
  const m = getPrintTemplate(docKey).margin;
  return m === undefined || m === null ? DEFAULT_PRINT_MARGIN : m;
}

async function savePrintTemplate(docKey, draft) {
  const meta = PRINT_DOC_TYPES[docKey];
  await Api.put('/api/settings', { [meta.settingsKey]: JSON.stringify(draft) });
  COMPANY_SETTINGS[meta.settingsKey] = JSON.stringify(draft);
}

// Renders any document type from its canvas template: absolutely-positions
// every element at its saved x/y/w/h. 'line' elements draw a bar; 'text'
// elements show their static text; 'logo' shows a store-name placeholder
// (Saffron has no logo upload feature yet); 'field' elements resolve
// through that doc type's fieldOptions -- isBarcode fields render a
// barcode, isBlock fields render a whole block (item table, totals, etc.)
// unclipped since its height varies with content, everything else is
// clipped to one line.
function renderCanvasDoc(docKey, template, data) {
  const meta = PRINT_DOC_TYPES[docKey];
  const elements = template.elements || [];
  const html = elements.map((el) => {
    const y = `data-el-y="${el.y}"`;
    if (el.type === 'line') {
      const style = el.orientation === 'vertical'
        ? `position:absolute; left:${el.x}px; top:${el.y}px; width:${el.thickness || 1}px; height:${el.h}px; background:#000;`
        : `position:absolute; left:${el.x}px; top:${el.y}px; width:${el.w}px; height:${el.thickness || 1}px; background:#000;`;
      return `<div ${y} style="${style}"></div>`;
    }
    const justify = el.align === 'left' ? 'flex-start' : el.align === 'right' ? 'flex-end' : 'center';
    if (el.type === 'text') {
      return `<div ${y} style="position:absolute; left:${el.x}px; top:${el.y}px; width:${el.w}px; min-height:${el.h}px; display:flex; align-items:center; justify-content:${justify}; font-size:${el.fontSize || 11}px; font-weight:${el.bold ? 700 : 400}; text-align:${el.align || 'center'}; white-space:pre-wrap;">${escapeHtml(el.text || '')}</div>`;
    }
    if (el.type === 'logo') {
      return `<div ${y} style="position:absolute; left:${el.x}px; top:${el.y}px; width:${el.w}px; height:${el.h}px; display:flex; align-items:center; justify-content:center; border:1px dashed #999; font-size:9px; color:#888;">${escapeHtml(COMPANY_SETTINGS.store_name || 'STORE LOGO')}</div>`;
    }
    if (el.type === 'field') {
      const opt = meta.fieldOptions.find((f) => f.key === el.fieldKey);
      if (!opt) return '';
      if (opt.isBarcode) {
        return `<div ${y} style="position:absolute; left:${el.x}px; top:${el.y}px; width:${el.w}px; height:${el.h}px; display:flex; align-items:center; justify-content:${justify};">${renderBarcodeSvg(opt.value(data), el.w)}</div>`;
      }
      if (opt.isBlock) {
        // No fixed/min height -- hugs its real content exactly (a 2-line
        // voucher shouldn't reserve room for 20 lines). compactCanvasHtml()
        // below reads data-reserved-h to see how much shorter that turned
        // out than the designed height, and closes the gap it leaves behind.
        // `el` is passed through so table-shaped blocks (Item Lines Table)
        // can read this element's own line/border toggles -- see the
        // "Table Lines" properties shown for it in the designer.
        return `<div ${y} data-block="1" data-reserved-h="${el.h}" style="position:absolute; left:${el.x}px; top:${el.y}px; width:${el.w}px;">${opt.value(data, el)}</div>`;
      }
      return `<div ${y} style="position:absolute; left:${el.x}px; top:${el.y}px; width:${el.w}px; height:${el.h}px; display:flex; align-items:center; justify-content:${justify}; font-size:${el.fontSize || 11}px; font-weight:${el.bold ? 700 : 400}; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;">${escapeHtml(opt.value(data))}</div>`;
    }
    return '';
  }).join('');
  const size = template.canvasSize || meta.canvasSize;
  // Card-shaped documents (tags, ID cards) default to an outline -- it's
  // the cut/separation line when several print on one sheet. Full-page
  // documents (receipts, POs, vouchers) default to none, since it prints
  // as a stray box eating into the margin. Either way it's just a default:
  // "Show Card Border" in the designer overrides it per template.
  const cardLikeDocs = ['inventoryTag', 'customerId'];
  const showBorder = template.showBorder !== undefined ? template.showBorder : cardLikeDocs.includes(docKey);
  const border = showBorder ? 'border:1px solid #999;' : '';
  return `<div class="canvas-doc-root" style="position:relative; width:${size.w}px; min-height:${size.h}px; ${border} border-radius:6px; background:#fff; margin:0 auto;">${html}</div>`;
}

// Real documents render at fixed design coordinates, but content like an
// item table is variable-height -- a voucher with 2 lines reserves the same
// room as one with 20, leaving a gap before whatever comes next (Totals,
// footer text, etc). This measures actual rendered heights in a hidden
// offscreen copy of the markup and shifts everything below a
// shorter-than-reserved block up to close that gap, then returns the
// adjusted HTML. Safe to call on any HTML string, including ones with no
// canvas documents in them at all (reports, plain text) -- it's a no-op then.
function compactCanvasHtml(html) {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute; left:-99999px; top:0; visibility:hidden;';
  holder.innerHTML = html;
  document.body.appendChild(holder);

  holder.querySelectorAll('.canvas-doc-root').forEach((root) => {
    const nodes = Array.from(root.querySelectorAll(':scope > [data-el-y]'));
    nodes
      .filter((n) => n.dataset.block === '1')
      .forEach((blockNode) => {
        const reservedH = Number(blockNode.dataset.reservedH || 0);
        const y = Number(blockNode.dataset.elY || 0);
        const actualH = blockNode.getBoundingClientRect().height;
        const delta = reservedH - actualH;
        if (delta <= 1) return;
        const blockBottom = y + reservedH;
        nodes.forEach((n) => {
          if (n === blockNode) return;
          const ny = Number(n.dataset.elY || 0);
          if (ny >= blockBottom - 1) {
            const newY = ny - delta;
            n.style.top = newY + 'px';
            n.dataset.elY = String(newY);
          }
        });
        blockNode.dataset.reservedH = String(actualH);
      });
    // Let the card hug its now-compacted content instead of always
    // reserving its full designed height.
    let maxBottom = 0;
    nodes.forEach((n) => {
      const top = parseFloat(n.style.top) || 0;
      maxBottom = Math.max(maxBottom, top + n.getBoundingClientRect().height);
    });
    if (maxBottom > 0) root.style.minHeight = (maxBottom + 14) + 'px';
  });

  const result = holder.innerHTML;
  document.body.removeChild(holder);
  return result;
}

// A real, standard EAN-13 barcode -- start/middle/end guard bars, digits
// split 1 / 6 / 6 with the lone left digit sitting outside the bars, exactly
// like a manufacturer's printed barcode. Saffron's own codes (Item Number,
// SKU, etc.) are usually shorter than 12 digits, so any missing digits are
// deterministically expanded from the code itself (not just zeros), which
// keeps different items visibly different while still producing a fully
// valid, scannable EAN-13 with a correct check digit.
const EAN_L_CODE = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G_CODE = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R_CODE = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

function ean13CheckDigit(digits12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(digits12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}

function toEan12Digits(code) {
  const raw = String(code || '').replace(/\D/g, '');
  if (raw.length >= 12) return raw.slice(0, 12);
  let out = raw;
  let seed = 0;
  for (let i = 0; i < raw.length; i++) seed = (seed * 31 + raw.charCodeAt(i)) >>> 0;
  if (seed === 0) seed = 137;
  while (out.length < 12) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    out += String(seed % 10);
  }
  return out.slice(0, 12);
}

// `targetWidth`, when given, stretches the whole barcode (bars + margins)
// to fill that many px -- this is what the barcode element's own width in
// the designer controls, so dragging it wider makes the bars wider too.
function renderBarcodeSvg(code, targetWidth) {
  const digits12 = toEan12Digits(code);
  const check = ean13CheckDigit(digits12);
  const parity = EAN_PARITY[Number(digits12[0])];

  let bits = '101';
  for (let i = 1; i <= 6; i++) {
    const d = Number(digits12[i]);
    bits += parity[i - 1] === 'L' ? EAN_L_CODE[d] : EAN_G_CODE[d];
  }
  bits += '01010';
  for (let i = 7; i <= 11; i++) bits += EAN_R_CODE[Number(digits12[i])];
  bits += EAN_R_CODE[Number(check)];
  bits += '101';

  const isGuard = (i) => (i < 3) || (i >= 45 && i < 50) || (i >= 92);

  const leftMarginUnits = 11; // quiet zone that also holds the lone left-hand digit
  const rightMarginUnits = 5;
  const unitsWithMargins = leftMarginUnits + bits.length + rightMarginUnits;
  const unit = targetWidth ? Math.max(0.8, targetWidth / unitsWithMargins) : 2.2;

  const dataHeight = 46;
  const guardHeight = 54;
  const textY = guardHeight + 13;

  let barsSvg = '';
  let x = leftMarginUnits * unit;
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === '1') {
      barsSvg += `<rect x="${x.toFixed(2)}" y="0" width="${unit.toFixed(2)}" height="${isGuard(i) ? guardHeight : dataHeight}" fill="#000"/>`;
    }
    x += unit;
  }

  const width = unitsWithMargins * unit;
  const leftGroup = digits12.slice(1, 7);
  const rightGroup = digits12.slice(7, 12) + check;
  const leftGroupX = leftMarginUnits * unit + 24 * unit;
  const rightGroupX = leftMarginUnits * unit + 71 * unit;

  return `
    <svg width="${width.toFixed(2)}" height="${textY + 5}" viewBox="0 0 ${width.toFixed(2)} ${textY + 5}" xmlns="http://www.w3.org/2000/svg">
      ${barsSvg}
      <text x="0" y="${textY}" font-size="11" font-family="monospace" fill="#000">${digits12[0]}</text>
      <text x="${leftGroupX.toFixed(2)}" y="${textY}" text-anchor="middle" font-size="11" font-family="monospace" letter-spacing="1" fill="#000">${leftGroup}</text>
      <text x="${rightGroupX.toFixed(2)}" y="${textY}" text-anchor="middle" font-size="11" font-family="monospace" letter-spacing="1" fill="#000">${rightGroup}</text>
    </svg>
  `;
}

// Customer ID Card / Inventory Tag are rendered by the same generalized
// canvas as every other document -- see renderCanvasDoc /
// PRINT_FIELD_OPTIONS above. These are just the entry points the rest of
// the app calls (Customers "Print ID", Item List "Tag"/"Print Tags").
function renderCustomerIdDoc(template, customer) { return renderCanvasDoc('customerId', template, customer); }
function renderInventoryTagDoc(template, product) { return renderCanvasDoc('inventoryTag', template, product); }

// =====================================================================
// RECEIVE ITEMS (stock in)
// =====================================================================
async function renderReceive() {
  let [products, categories, heldVouchers] = await Promise.all([
    Api.get('/api/products'),
    Api.get('/api/products/categories'),
    Api.get('/api/held-documents?type=receiving')
  ]);
  let lines = []; // { product_id, name, qty, cost, price }
  let discountPct = 0;
  let freight = 0;
  let fee = 0;
  let spread = false;

  content.innerHTML = `
    <div class="view-header">
      <h1>Receive Items</h1>
      <div class="view-actions">
        <div class="pd-add-wrap">
          <button type="button" class="btn" id="receivePrintBtn">${icon('printer', 14)} Print &#9662;</button>
          <div id="receivePrintMenu" class="pd-add-menu" hidden>
            <button type="button" id="receivePrintVoucherBtn">Print Voucher</button>
            <button type="button" id="receivePrintTagsBtn">Print Tags</button>
          </div>
        </div>
        <button type="button" class="btn" id="receiveCustomizeColumnsBtn">${icon('columns', 14)} <span><span class="hide-phone">Customize&nbsp;</span>Columns</span></button>
      </div>
    </div>
    ${heldVouchers.length > 0 ? `
    <div class="card">
      <h2>${icon('pauseCircle', 16)} Held Receiving Vouchers</h2>
      <p class="note">Held so you could step out to Item List (or anywhere else) without losing what was entered -- Resume picks up right where you left off.</p>
      <div class="table-wrap" id="heldVoucherWrap">
        <table>
          <thead><tr><th>Label</th><th>Items</th><th>Held By</th><th>Held At</th><th></th></tr></thead>
          <tbody>${heldVouchers.map((h) => `
            <tr>
              <td>${escapeHtml(h.label || '(no label)')}</td>
              <td>${(h.payload.lines || []).length}</td>
              <td>${escapeHtml(h.held_by || '—')}</td>
              <td>${new Date(h.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
              <td><button class="btn btn-sm held-voucher-resume-btn" data-id="${h.id}">Resume</button> <button class="btn btn-sm btn-danger held-voucher-del-btn" data-id="${h.id}">Delete</button></td>
            </tr>
          `).join('')}</tbody>
        </table>
      </div>
    </div>` : ''}
    <div class="card">
      <p class="note">
        Search for an item to add it to this voucher, repeat for every item on the delivery, then receive them all at once.
      </p>
      <div class="sale-search-row">
        <div class="receive-search-wrap">
          <input type="search" class="search-input" id="receiveSearch"
            placeholder="Type an item name, SKU, or barcode&hellip; (or scan a barcode)" autocomplete="off" />
          <div class="receive-suggestions" id="receiveSuggestions" hidden></div>
        </div>
        <button type="button" class="btn" id="receiveScanBtn" title="Scan with camera">${icon('camera', 14)} Scan</button>
        <button type="button" class="btn" id="receiveFindItemsBtn">${icon('search', 14)} Find Item(s)</button>
      </div>
      <div class="table-wrap" id="receiveLinesWrap">
        <table id="receiveLinesTable">
          <thead><tr id="receiveHeadRow"></tr></thead>
          <tbody id="receiveLines"></tbody>
        </table>
      </div>
      <div class="receive-footer-grid">
        <label class="receive-spread-label">
          <input type="checkbox" id="spreadCheck" /> Spread discount, freight and fee
        </label>
        <div class="receive-charges-box">
          <div class="receive-charge-row"><span>SubTotal</span><span id="rvSubtotal">${money(0)}</span></div>
          <div class="receive-charge-row">
            <span>Discount</span>
            <span><input type="number" id="rvDiscountPct" min="0" max="100" step="0.01" value="0" />%</span>
            <span id="rvDiscountAmt">${money(0)}</span>
          </div>
          <div class="receive-charge-row"><span>Freight</span><input type="number" id="rvFreight" min="0" step="0.01" value="0" /></div>
          <div class="receive-charge-row"><span>Fee</span><input type="number" id="rvFee" min="0" step="0.01" value="0" /></div>
          <div class="receive-charge-row receive-total-row"><span>Total</span><strong id="rvTotal">${money(0)}</strong></div>
        </div>
      </div>
      <div class="receive-voucher-buttons">
        <button type="button" class="btn btn-danger" id="cancelVoucherBtn">Cancel</button>
        <button type="button" class="btn" id="holdVoucherBtn" title="Park this voucher and come back to it later -- handy if you need to step out to Item List first">${icon('pauseCircle', 14)} Hold Voucher</button>
        <button type="button" class="btn" id="saveOnlyBtn">Save Only</button>
        <button type="button" class="btn btn-primary" id="savePrintBtn">Save &amp; Print</button>
      </div>
    </div>
    <div class="card table-wrap" id="stockLevelsWrap">
      <h2>Current Stock Levels</h2>
      <table>
        <thead><tr><th>Item</th><th>On Hand</th><th>Reorder Level</th></tr></thead>
        <tbody>${products.map((p) => `<tr><td>${escapeHtml(p.name)}</td><td>${p.qty_on_hand}</td><td>${p.reorder_level}</td></tr>`).join('') || '<tr><td colspan="3" class="empty-state">No items yet -- add some from Item List first.</td></tr>'}</tbody>
      </table>
    </div>
  `;

  const searchInput = document.getElementById('receiveSearch');
  const suggestionsEl = document.getElementById('receiveSuggestions');
  const linesEl = document.getElementById('receiveLines');
  let activeColumns = receiveLineColumnStore.load();
  // Tracked by product_id (stable across re-renders) rather than array
  // index -- feeds "Print Tags" -> "Selected item(s) only".
  const selectedLineIds = new Set();

  function drawHead() {
    document.getElementById('receiveHeadRow').innerHTML =
      '<th class="no-resize" style="width:28px;"><input type="checkbox" id="receiveSelectAllLines" title="Select all" /></th>' +
      activeColumns.map((key) => {
        const c = RECEIVE_LINE_COLUMNS.find((x) => x.key === key);
        return `<th data-key="${key}">${escapeHtml(c ? c.label : key)}</th>`;
      }).join('') + '<th class="no-resize"></th>';
    document.getElementById('receiveSelectAllLines').addEventListener('change', (e) => {
      if (e.target.checked) lines.forEach((l) => selectedLineIds.add(l.product_id));
      else selectedLineIds.clear();
      drawLines();
    });
    makeColumnsResizable(document.getElementById('receiveLinesTable'), 'receive');
  }

  // With no query, show everything (scrollable) -- lets someone click into
  // the search box and browse the full item list, same as the dropdown
  // arrow on QuickBooks POS's "Enter Item(s)" field.
  function matchesFor(q) {
    q = q.trim().toLowerCase();
    if (!q) return products.slice(0, 50);
    return products
      .filter((p) => p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q) || (p.barcode || '').toLowerCase().includes(q) || (p.item_number || '').toLowerCase().includes(q))
      .slice(0, 50);
  }

  // What to suggest as the starting Voucher Cost: last time this item was
  // received (Order Cost), same as real QuickBooks POS -- falling back to
  // Average Cost for an item that's never been received before.
  function suggestedCostFor(product) {
    return Number(product.order_cost) > 0 ? Number(product.order_cost) : Number(product.cost) || 0;
  }

  function addLine(product) {
    if (!product) return;
    const existing = lines.find((l) => l.product_id === product.id);
    if (existing) existing.qty += 1;
    else lines.push({ product_id: product.id, name: product.name, qty: 1, cost: suggestedCostFor(product), price: product.price || 0 });
    drawLines();
  }

  // Re-fetches the item list in place (used after "+ Add New Item") without
  // re-navigating to the view -- a full navigate('receive') would wipe out
  // whatever's already been entered on this voucher.
  async function refreshProducts() {
    products = await Api.get('/api/products');
  }

  function extCostFor(l) { return Number(l.qty || 0) * Number(l.cost || 0); }
  function subtotal() { return lines.reduce((sum, l) => sum + extCostFor(l), 0); }
  function discountAmount() { return subtotal() * (Number(discountPct) || 0) / 100; }
  function pool() { return (Number(freight) || 0) + (Number(fee) || 0) - discountAmount(); }
  function effectiveCostFor(l) {
    const sub = subtotal();
    const share = sub > 0 ? extCostFor(l) / sub : (lines.length ? 1 / lines.length : 0);
    const adjustment = spread ? pool() * share : 0;
    const qty = Number(l.qty) || 0;
    return Math.max(0, Number(l.cost || 0) + (qty ? adjustment / qty : 0));
  }
  function markupPctFor(l) {
    const effCost = effectiveCostFor(l);
    return effCost > 0 ? (Number(l.price || 0) - effCost) / effCost * 100 : 0;
  }
  function voucherTotal() { return subtotal() - discountAmount() + (Number(freight) || 0) + (Number(fee) || 0); }
  // What the "Voucher Cost" cell shows: the raw cost as entered, unless
  // spread is on, in which case it dominoes into the landed (spread-adjusted)
  // cost -- same number effectiveCostFor()/markup % already use internally.
  function displayCostFor(l) { return spread ? effectiveCostFor(l) : Number(l.cost || 0); }

  // Recomputes every derived display (totals, ext cost, cost, markup %)
  // without touching whichever field the user is actively typing in, so live
  // recalculation never fights with someone mid-keystroke.
  function recalcAll() {
    document.getElementById('rvSubtotal').textContent = money(subtotal());
    document.getElementById('rvDiscountAmt').textContent = money(discountAmount());
    document.getElementById('rvTotal').textContent = money(voucherTotal());
    lines.forEach((l, i) => {
      const extCell = linesEl.querySelector(`.line-ext-cost[data-i="${i}"]`);
      if (extCell) extCell.textContent = money(extCostFor(l));
      const costInput = linesEl.querySelector(`.line-cost[data-i="${i}"]`);
      if (costInput && document.activeElement !== costInput) costInput.value = displayCostFor(l).toFixed(2);
      const priceInput = linesEl.querySelector(`.line-price[data-i="${i}"]`);
      if (priceInput && document.activeElement !== priceInput) priceInput.value = l.price;
      const markupInput = linesEl.querySelector(`.line-markup[data-i="${i}"]`);
      if (markupInput && document.activeElement !== markupInput) markupInput.value = markupPctFor(l).toFixed(2);
    });
  }

  // Builds one <td> for a given column key -- shared by every line row.
  // Info columns (item_number/sku/category_name/on_hand) just look the
  // product up; the locked functional columns keep their exact original
  // markup so the input class names/data-i attributes stay stable.
  function cellFor(key, l, i) {
    const product = products.find((p) => p.id === l.product_id);
    switch (key) {
      case 'item_number': return `<td data-label="Item Number">${escapeHtml(product?.item_number || '—')}</td>`;
      case 'sku': return `<td data-label="SKU">${escapeHtml(product?.sku || '—')}</td>`;
      case 'category_name': return `<td data-label="Category">${escapeHtml(product?.category_name || '—')}</td>`;
      case 'on_hand': return `<td data-label="Current On-Hand">${product ? product.qty_on_hand : '—'}</td>`;
      case 'name': return `<td class="line-name-cell" data-label="Item">${escapeHtml(l.name)}</td>`;
      case 'qty': return `<td data-label="Qty"><input type="number" min="0" step="1" class="line-qty" data-i="${i}" value="${l.qty}" /></td>`;
      case 'cost': return `<td data-label="Voucher Cost"><input type="number" min="0" step="0.01" class="line-cost" data-i="${i}" value="${displayCostFor(l).toFixed(2)}"
          ${spread ? 'readonly title="Includes spread discount/freight/fee -- uncheck Spread to edit the raw voucher cost"' : ''} /></td>`;
      case 'ext_cost': return `<td class="line-ext-cost" data-i="${i}" data-label="Ext. Cost">${money(extCostFor(l))}</td>`;
      case 'price': return `<td data-label="Regular Price"><input type="number" min="0" step="0.01" class="line-price" data-i="${i}" value="${l.price}" /></td>`;
      case 'markup': return `<td data-label="Markup %"><input type="number" step="0.01" class="line-markup" data-i="${i}" value="${markupPctFor(l).toFixed(2)}" /></td>`;
      default: return `<td>—</td>`;
    }
  }

  function drawLines() {
    linesEl.innerHTML = lines.map((l, i) => `
      <tr>
        <td><input type="checkbox" class="line-select" data-pid="${l.product_id}" ${selectedLineIds.has(l.product_id) ? 'checked' : ''} /></td>
        ${activeColumns.map((key) => cellFor(key, l, i)).join('')}
        <td class="line-remove-cell"><button type="button" class="btn btn-sm btn-danger line-remove" data-i="${i}">✕<span class="line-remove-label"> Remove</span></button></td>
      </tr>
    `).join('') || `<tr><td colspan="${activeColumns.length + 2}" class="empty-state">No items added yet -- search above to start this voucher.</td></tr>`;

    linesEl.querySelectorAll('.line-select').forEach((cb) => cb.addEventListener('change', (e) => {
      const pid = Number(e.target.dataset.pid);
      if (e.target.checked) selectedLineIds.add(pid); else selectedLineIds.delete(pid);
    }));
    linesEl.querySelectorAll('.line-qty').forEach((inp) => inp.addEventListener('input', (e) => {
      lines[Number(e.target.dataset.i)].qty = e.target.value;
      recalcAll();
    }));
    linesEl.querySelectorAll('.line-cost').forEach((inp) => inp.addEventListener('input', (e) => {
      if (spread) return; // read-only while spread is on -- it's showing the computed landed cost
      lines[Number(e.target.dataset.i)].cost = e.target.value;
      recalcAll();
    }));
    linesEl.querySelectorAll('.line-price').forEach((inp) => inp.addEventListener('input', (e) => {
      lines[Number(e.target.dataset.i)].price = e.target.value;
      recalcAll();
    }));
    linesEl.querySelectorAll('.line-markup').forEach((inp) => inp.addEventListener('input', (e) => {
      const i = Number(e.target.dataset.i);
      const effCost = effectiveCostFor(lines[i]);
      const markupVal = Number(e.target.value) || 0;
      lines[i].price = +(effCost * (1 + markupVal / 100)).toFixed(2);
      recalcAll();
    }));
    linesEl.querySelectorAll('.line-remove').forEach((b) => b.addEventListener('click', () => {
      lines.splice(Number(b.dataset.i), 1);
      drawLines();
    }));
    recalcAll();
  }

  function drawSuggestions(list) {
    suggestionsEl.hidden = false;
    suggestionsEl.innerHTML = `
      <button type="button" class="receive-suggestion-item sale-add-new-item" id="receiveAddNewItemBtn">+ Add New Item</button>
      ${list.map((p) => `
        <button type="button" class="receive-suggestion-item" data-id="${p.id}">
          <span>${escapeHtml(p.name)}</span>
          <span class="receive-suggestion-meta">${p.qty_on_hand} on hand &middot; ${money(suggestedCostFor(p))}</span>
        </button>
      `).join('') || `<div class="empty-state compact">No items match.</div>`}
    `;
    suggestionsEl.querySelector('#receiveAddNewItemBtn').addEventListener('click', () => {
      hideSuggestions();
      openProductModal(categories, null, async (saved) => {
        await refreshProducts();
        toast(`${saved.name} added to Item List.`, 'success');
        searchInput.focus();
      });
    });
    suggestionsEl.querySelectorAll('.receive-suggestion-item[data-id]').forEach((btn) => btn.addEventListener('click', () => {
      addLine(products.find((p) => p.id === Number(btn.dataset.id)));
      searchInput.value = '';
      hideSuggestions();
      searchInput.focus();
    }));
  }

  function hideSuggestions() { suggestionsEl.hidden = true; suggestionsEl.innerHTML = ''; }

  searchInput.addEventListener('input', () => drawSuggestions(matchesFor(searchInput.value)));
  searchInput.addEventListener('focus', () => drawSuggestions(matchesFor(searchInput.value)));
  searchInput.addEventListener('blur', () => setTimeout(hideSuggestions, 150));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = searchInput.value.trim().toLowerCase();
    if (!q) return;
    // Exact barcode/SKU/item number match takes priority -- lets a barcode
    // scanner (including a self-printed Item Number tag) add items with no
    // clicking at all.
    const exact = products.find((p) => (p.barcode || '').toLowerCase() === q || (p.sku || '').toLowerCase() === q || (p.item_number || '').toLowerCase() === q);
    const candidate = exact || matchesFor(q)[0];
    if (candidate) {
      addLine(candidate);
      searchInput.value = '';
      hideSuggestions();
    }
  });

  document.getElementById('receiveFindItemsBtn').addEventListener('click', () => openFindItemsModal(products, addLine));
  document.getElementById('receiveScanBtn').addEventListener('click', () => scanBarcodeInto(products, searchInput, matchesFor, drawSuggestions, addLine));

  // "Print" dropdown -- Print Voucher (preview the voucher as it stands
  // right now, no save required) / Print Tags (matching QuickBooks POS's
  // Receiving Voucher "Print" menu).
  const receivePrintMenu = document.getElementById('receivePrintMenu');
  document.getElementById('receivePrintBtn').addEventListener('click', () => { receivePrintMenu.hidden = !receivePrintMenu.hidden; });
  document.getElementById('receivePrintVoucherBtn').addEventListener('click', () => {
    receivePrintMenu.hidden = true;
    const activeLines = lines.filter((l) => Number(l.qty) > 0);
    if (activeLines.length === 0) { toast('Add at least one item with a quantity first.', 'error'); return; }
    const voucherData = {
      storeName: COMPANY_SETTINGS.store_name || 'Saffron POS',
      date: new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
      receivedBy: CURRENT_USER.full_name,
      lines: activeLines.map((l) => ({ name: l.name, qty: Number(l.qty), cost: displayCostFor(l) })),
      subtotal: subtotal(),
      discountPct: Number(discountPct) || 0,
      discountAmt: discountAmount(),
      freight: Number(freight) || 0,
      fee: Number(fee) || 0,
      total: voucherTotal()
    };
    openPrintDoc('Receiving Voucher', renderVoucherDoc(getPrintTemplate('receivingVoucher'), voucherData), { margin: printMarginFor('receivingVoucher') });
  });
  document.getElementById('receivePrintTagsBtn').addEventListener('click', () => {
    receivePrintMenu.hidden = true;
    const activeLines = lines.filter((l) => Number(l.qty) > 0);
    if (activeLines.length === 0) { toast('Add at least one item with a quantity first.', 'error'); return; }
    openReceiveTagsModal(activeLines, selectedLineIds, products);
  });
  document.addEventListener('click', (e) => {
    if (!receivePrintMenu.hidden && !e.target.closest('#receivePrintBtn') && !e.target.closest('#receivePrintMenu')) receivePrintMenu.hidden = true;
  });

  document.getElementById('rvDiscountPct').addEventListener('input', (e) => { discountPct = e.target.value; recalcAll(); });
  document.getElementById('rvFreight').addEventListener('input', (e) => { freight = e.target.value; recalcAll(); });
  document.getElementById('rvFee').addEventListener('input', (e) => { fee = e.target.value; recalcAll(); });
  document.getElementById('spreadCheck').addEventListener('change', (e) => {
    spread = e.target.checked;
    drawLines(); // full redraw: the Voucher Cost cell dominoes between raw and landed cost, and toggles readonly
  });

  document.getElementById('cancelVoucherBtn').addEventListener('click', () => {
    if (lines.length === 0) { navigate('home'); return; }
    if (!confirmGuarded('delete', 'Cancel this voucher? Anything entered will be lost.')) return;
    navigate('receive');
  });

  // Parks this voucher server-side (survives navigating away, closing the
  // tab, even logging out) so stepping out to Item List for a new item
  // never means losing what's already been entered.
  document.getElementById('holdVoucherBtn').addEventListener('click', async () => {
    const activeLines = lines.filter((l) => Number(l.qty) > 0);
    if (activeLines.length === 0) { toast('Add at least one item before holding.', 'error'); return; }
    try {
      await Api.post('/api/held-documents', {
        doc_type: 'receiving',
        label: null,
        payload: { lines: activeLines, discountPct: Number(discountPct) || 0, freight: Number(freight) || 0, fee: Number(fee) || 0, spread }
      });
      toast('Voucher held -- resume it anytime from Receive Items.', 'success');
      navigate('receive');
    } catch (err) { toast(err.message, 'error'); }
  });

  // Resume/Delete happen in place (no navigate()) so they never wipe out
  // whatever's currently being typed into the active voucher below.
  document.querySelectorAll('.held-voucher-resume-btn').forEach((b) => b.addEventListener('click', async () => {
    const h = heldVouchers.find((x) => x.id === Number(b.dataset.id));
    if (!h) return;
    try {
      await Api.del(`/api/held-documents/${h.id}`);
      lines = h.payload.lines || [];
      discountPct = h.payload.discountPct || 0;
      freight = h.payload.freight || 0;
      fee = h.payload.fee || 0;
      spread = !!h.payload.spread;
      document.getElementById('rvDiscountPct').value = discountPct;
      document.getElementById('rvFreight').value = freight;
      document.getElementById('rvFee').value = fee;
      document.getElementById('spreadCheck').checked = spread;
      drawLines();
      b.closest('tr').remove();
      toast('Voucher resumed.', 'success');
    } catch (err) { toast(err.message, 'error'); }
  }));
  document.querySelectorAll('.held-voucher-del-btn').forEach((b) => b.addEventListener('click', async () => {
    if (!confirmGuarded('delete', 'Delete this held voucher? This cannot be undone.')) return;
    try {
      await Api.del(`/api/held-documents/${b.dataset.id}`);
      b.closest('tr').remove();
    } catch (err) { toast(err.message, 'error'); }
  }));

  // Shared by Save Only and Save & Print -- posts the voucher, then either
  // hands back a printable snapshot (Save & Print) or nothing (Save Only).
  async function saveVoucher() {
    const items = lines
      .filter((l) => Number(l.qty) > 0)
      .map((l) => ({
        product_id: l.product_id,
        qty: Number(l.qty),
        cost: l.cost === '' ? null : Number(l.cost),
        price: l.price === '' ? null : Number(l.price)
      }));
    if (items.length === 0) { toast('Add at least one item with a quantity.', 'error'); return null; }
    // Snapshot what's on screen right now for the printed voucher -- taken
    // before the screen resets, using the same effective (spread-adjusted,
    // if enabled) cost the person was looking at when they hit Save.
    const voucherData = {
      storeName: COMPANY_SETTINGS.store_name || 'Saffron POS',
      date: new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }),
      receivedBy: CURRENT_USER.full_name,
      lines: lines.filter((l) => Number(l.qty) > 0).map((l) => ({ name: l.name, qty: Number(l.qty), cost: displayCostFor(l) })),
      subtotal: subtotal(),
      discountPct: Number(discountPct) || 0,
      discountAmt: discountAmount(),
      freight: Number(freight) || 0,
      fee: Number(fee) || 0,
      total: voucherTotal()
    };
    try {
      await Api.post('/api/receiving', {
        items,
        discount_pct: Number(discountPct) || 0,
        freight: Number(freight) || 0,
        fee: Number(fee) || 0,
        spread
      });
      toast(`Received ${items.length} item${items.length === 1 ? '' : 's'}.`, 'success');
      return voucherData;
    } catch (err) {
      toast(err.message, 'error');
      return null;
    }
  }

  document.getElementById('saveOnlyBtn').addEventListener('click', async () => {
    const voucherData = await saveVoucher();
    if (voucherData) navigate('receive');
  });

  document.getElementById('savePrintBtn').addEventListener('click', async () => {
    const voucherData = await saveVoucher();
    if (!voucherData) return;
    openPrintDoc('Receiving Voucher', renderVoucherDoc(getPrintTemplate('receivingVoucher'), voucherData), { margin: printMarginFor('receivingVoucher') });
    navigate('receive');
  });

  document.getElementById('receiveCustomizeColumnsBtn').addEventListener('click', () => {
    openColumnCustomizerModal(RECEIVE_LINE_COLUMNS, DEFAULT_RECEIVE_LINE_COLUMNS, activeColumns, (newColumns) => {
      activeColumns = newColumns;
      receiveLineColumnStore.save(newColumns);
      drawHead();
      drawLines();
      toast('Columns updated.', 'success');
    });
  });

  drawHead();
  drawLines();
  autoFocus(searchInput);
  hideSuggestions();
  attachZoomContextMenu(document.getElementById('heldVoucherWrap'), 'heldVoucher');
  attachZoomContextMenu(document.getElementById('receiveLinesWrap'), 'receive');
  attachZoomContextMenu(document.getElementById('stockLevelsWrap'), 'stockLevels');
}

// =====================================================================
// DEPARTMENT LIST (categories)
// =====================================================================
async function renderDepartments() {
  const categories = await Api.get('/api/products/categories');
  content.innerHTML = `
    <div class="view-header">
      <h1>Department List</h1>
      <button class="btn btn-primary" id="addDeptBtn">+ Add Department</button>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Department</th><th></th></tr></thead>
        <tbody>
          ${categories.map((c) => `
            <tr>
              <td>${escapeHtml(c.name)}</td>
              <td class="text-right">
                <button class="btn btn-sm edit-dept-btn" data-id="${c.id}" data-name="${escapeHtml(c.name)}">Edit</button>
                <button class="btn btn-sm btn-danger del-dept-btn" data-id="${c.id}">Delete</button>
              </td>
            </tr>
          `).join('') || '<tr><td colspan="2" class="empty-state">No departments yet.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
  document.getElementById('addDeptBtn').addEventListener('click', () => {
    const overlay = openModal(`
      <h2>Add Department</h2>
      <form id="deptForm" class="form-grid">
        <label class="span-all">Name<input name="name" required /></label>
        <div class="modal-actions span-all">
          <button type="button" class="btn" id="cancelBtn">Cancel</button>
          <button type="submit" class="btn btn-primary">Add</button>
        </div>
      </form>
    `);
    overlay.querySelector('#cancelBtn').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#deptForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      try {
        await Api.post('/api/products/categories', body);
        overlay.remove();
        navigate('departments');
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  content.querySelectorAll('.edit-dept-btn').forEach((btn) => btn.addEventListener('click', () => {
    const overlay = openModal(`
      <h2>Edit Department</h2>
      <form id="deptEditForm" class="form-grid">
        <label class="span-all">Name<input name="name" required value="${btn.dataset.name}" /></label>
        <div class="modal-actions span-all">
          <button type="button" class="btn" id="cancelEditBtn">Cancel</button>
          <button type="submit" class="btn btn-primary">Save</button>
        </div>
      </form>
    `);
    overlay.querySelector('#cancelEditBtn').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#deptEditForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      if (!confirmGuarded('edit', 'Save changes to this department?')) return;
      try {
        await Api.put(`/api/products/categories/${btn.dataset.id}`, body);
        overlay.remove();
        navigate('departments');
      } catch (err) { toast(err.message, 'error'); }
    });
  }));

  content.querySelectorAll('.del-dept-btn').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirmGuarded('delete', 'Delete this department?')) return;
    try {
      await Api.del(`/api/products/categories/${btn.dataset.id}`);
      navigate('departments');
    } catch (err) { toast(err.message, 'error'); }
  }));
  attachZoomContextMenu(content.querySelector('.table-wrap'), 'departments');
}

// ---------- Item List bulk import (CSV / Excel) ----------

// Parses CSV text into an array of row objects keyed by the (raw) header
// text from the first row. Handles quoted fields -- commas/quotes/newlines
// inside quotes, "" as an escaped quote -- well enough for real-world
// Excel/Google Sheets exports.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  function pushField() { row.push(field); field = ''; }
  function pushRow() { pushField(); rows.push(row); row = []; }
  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { pushField(); i++; continue; }
    if (ch === '\r') { i++; continue; } // normalize CRLF -> LF
    if (ch === '\n') { pushRow(); i++; continue; }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) pushRow(); // last row if file has no trailing newline

  const dataRows = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  if (dataRows.length === 0) return [];
  const headers = dataRows[0].map((h) => h.trim());
  return dataRows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ''; });
    return obj;
  });
}

// Recognized spreadsheet header text (case/punctuation-insensitive) for
// each of our product fields, so a real QuickBooks-style export ("Item
// Name", "Department Name", ...) or a Google Sheet with slightly
// different wording both work without renaming columns first.
const IMPORT_FIELD_ALIASES = {
  name: ['name', 'item name', 'item', 'product name'],
  sku: ['sku', 'item number', 'item no', 'code'],
  barcode: ['barcode', 'upc', 'alu', 'alternate lookup'],
  category: ['category', 'department', 'department name'],
  price: ['price', 'regular price', 'sales price', 'selling price', 'sale price'],
  cost: ['cost', 'average cost', 'unit cost'],
  order_cost: ['order cost', 'o cost', 'vendor cost'],
  qty_on_hand: ['qty', 'qty on hand', 'quantity', 'quantity on hand', 'stock', 'on hand', 'available quantity'],
  reorder_level: ['reorder level', 'reorder point', 'min qty', 'minimum quantity', 'low stock level']
};
function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[.#]/g, '').replace(/\s+/g, ' ').trim();
}
function mapImportRows(rawRows) {
  if (rawRows.length === 0) return { rows: [], unmatchedHeaders: [] };
  const rawHeaders = Object.keys(rawRows[0]);
  const headerToField = {};
  const matchedHeaders = new Set();
  for (const rawHeader of rawHeaders) {
    const normalized = normalizeHeader(rawHeader);
    for (const [field, aliases] of Object.entries(IMPORT_FIELD_ALIASES)) {
      if (aliases.includes(normalized)) { headerToField[rawHeader] = field; matchedHeaders.add(rawHeader); break; }
    }
  }
  const rows = rawRows.map((raw) => {
    const mapped = {};
    for (const [rawHeader, field] of Object.entries(headerToField)) mapped[field] = raw[rawHeader];
    return mapped;
  });
  const unmatchedHeaders = rawHeaders.filter((h) => !matchedHeaders.has(h));
  return { rows, unmatchedHeaders };
}

const IMPORT_TEMPLATE_HEADERS = ['Name', 'SKU', 'Barcode', 'Category', 'Price', 'Cost', 'Order Cost', 'Qty On Hand', 'Reorder Level'];
const IMPORT_TEMPLATE_SAMPLE = ['Bottled Water 500ml', 'BW-500', '012345678905', 'Beverages', '25', '15', '15', '100', '10'];
function downloadImportTemplate() {
  const csv = [IMPORT_TEMPLATE_HEADERS.join(','), IMPORT_TEMPLATE_SAMPLE.join(',')].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'saffron-item-import-template.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// Excel files need a real parser -- loaded from a public CDN on demand
// (only when someone actually picks a .xlsx/.xls file) rather than on
// every page load. CSV needs no extra library.
let sheetJsLoadPromise = null;
function ensureSheetJs() {
  if (window.XLSX) return Promise.resolve();
  if (sheetJsLoadPromise) return sheetJsLoadPromise;
  sheetJsLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    script.onload = () => resolve();
    script.onerror = () => { sheetJsLoadPromise = null; reject(new Error('Could not load the Excel file reader -- check your internet connection, or save the file as CSV instead.')); };
    document.head.appendChild(script);
  });
  return sheetJsLoadPromise;
}

async function parseImportFile(file) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv') || file.type === 'text/csv') {
    return parseCsv(await file.text());
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    await ensureSheetJs();
    const buf = await file.arrayBuffer();
    const workbook = window.XLSX.read(buf, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return window.XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  }
  throw new Error('Unsupported file type -- please choose a .csv, .xlsx, or .xls file.');
}

function openImportModal() {
  const overlay = openModal(`
    <h2>Import Items</h2>
    <p class="note">
      Import a CSV or Excel file of items. If a row's SKU matches an item you already have, that item gets updated; otherwise a new
      item is added. Departments mentioned in the file that don't exist yet are created automatically.
    </p>
    <button type="button" class="btn mb" id="downloadTemplateBtn">Download CSV Template</button>
    <div class="form-grid">
      <label class="span-all">File (.csv, .xlsx, .xls)<input type="file" id="importFileInput" accept=".csv,.xlsx,.xls" /></label>
    </div>
    <div id="importPreview"></div>
    <div class="modal-actions">
      <button type="button" class="btn" id="cancelImportBtn">Cancel</button>
      <button type="button" class="btn btn-primary" id="confirmImportBtn" disabled>Import</button>
    </div>
  `, 'modal-lg');

  let parsedRows = null;

  overlay.querySelector('#downloadTemplateBtn').addEventListener('click', downloadImportTemplate);
  overlay.querySelector('#cancelImportBtn').addEventListener('click', () => overlay.remove());

  const previewEl = overlay.querySelector('#importPreview');
  const confirmBtn = overlay.querySelector('#confirmImportBtn');

  overlay.querySelector('#importFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    confirmBtn.disabled = true;
    previewEl.innerHTML = `<p class="note">Reading file&hellip;</p>`;
    try {
      const rawRows = await parseImportFile(file);
      const { rows, unmatchedHeaders } = mapImportRows(rawRows);
      parsedRows = rows.filter((r) => Object.keys(r).length > 0);
      if (parsedRows.length === 0) {
        previewEl.innerHTML = `<p class="text-danger">Couldn't find any recognizable columns. Make sure the file has a header row with columns like Name, SKU, Price, etc. -- or start from the template above.</p>`;
        return;
      }
      const previewRows = parsedRows.slice(0, 5);
      previewEl.innerHTML = `
        <p class="note" style="margin:14px 0 6px;"><strong>${parsedRows.length}</strong> row${parsedRows.length === 1 ? '' : 's'} found. Showing the first ${previewRows.length}:</p>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>SKU</th><th>Category</th><th>Price</th><th>Cost</th><th>Qty</th></tr></thead>
            <tbody>${previewRows.map((r) => `<tr><td>${escapeHtml(r.name || '')}</td><td>${escapeHtml(r.sku || '')}</td><td>${escapeHtml(r.category || '')}</td><td>${escapeHtml(String(r.price ?? ''))}</td><td>${escapeHtml(String(r.cost ?? ''))}</td><td>${escapeHtml(String(r.qty_on_hand ?? ''))}</td></tr>`).join('')}</tbody>
          </table>
        </div>
        ${unmatchedHeaders.length ? `<p class="note small">Columns not recognized (ignored): ${unmatchedHeaders.map(escapeHtml).join(', ')}</p>` : ''}
      `;
      confirmBtn.disabled = false;
    } catch (err) {
      previewEl.innerHTML = `<p class="text-danger">${escapeHtml(err.message)}</p>`;
    }
  });

  confirmBtn.addEventListener('click', async () => {
    if (!parsedRows || parsedRows.length === 0) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Importing…';
    try {
      const result = await Api.post('/api/products/import', { items: parsedRows });
      overlay.remove();
      const parts = [];
      if (result.created) parts.push(`${result.created} added`);
      if (result.updated) parts.push(`${result.updated} updated`);
      if (result.skipped) parts.push(`${result.skipped} skipped`);
      toast(`Import complete: ${parts.join(', ') || 'no changes'}.`, result.skipped ? 'error' : 'success');
      navigate('inventory');
    } catch (err) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Import';
      toast(err.message, 'error');
    }
  });
}

// =====================================================================
// INVENTORY
// =====================================================================
async function renderInventory() {
  const [products, categories] = await Promise.all([
    Api.get('/api/products'),
    Api.get('/api/products/categories')
  ]);
  let activeColumns = loadInventoryColumns();
  const selectedIds = new Set(); // checked rows -- feeds "Print Tags"
  let sortKey = null;
  let sortDir = 'asc';

  content.innerHTML = `
    <div class="view-header">
      <h1>Item List</h1>
      <div class="view-actions">
        <input type="search" class="search-input" id="invSearch" placeholder="Search items&hellip;" />
        <button class="btn" id="customizeColumnsBtn">${icon('columns', 14)} <span><span class="hide-phone">Customize&nbsp;</span>Columns</span></button>
        <button class="btn" id="importItemsBtn">Import Items</button>
        <button class="btn" id="physicalInventoryBtn">Physical Inventory</button>
        <button class="btn" id="printTagsBtn">${icon('printer', 14)} Print Tags</button>
        <button class="btn btn-primary" id="addItemBtn">+ Add Item</button>
      </div>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr id="invHeadRow"></tr></thead>
        <tbody id="invBody"></tbody>
      </table>
    </div>
  `;

  let currentList = products;

  function drawHead() {
    const headRow = document.getElementById('invHeadRow');
    headRow.innerHTML = '<th class="no-resize" style="width:32px;"><input type="checkbox" id="invSelectAll" title="Select all" /></th>' +
      activeColumns.map((key) => {
        const c = INVENTORY_COLUMNS.find((x) => x.key === key);
        const sortable = c?.sortValue;
        return `<th ${sortable ? `class="sortable-th" data-key="${key}" title="Click to sort"` : `data-key="${key}"`}>${escapeHtml(c ? c.label : key)}${sortArrowHtml(key === sortKey, sortDir)}</th>`;
      }).join('') + '<th class="no-resize"></th>';
    document.getElementById('invSelectAll').addEventListener('change', (e) => {
      if (e.target.checked) currentList.forEach((p) => selectedIds.add(p.id));
      else currentList.forEach((p) => selectedIds.delete(p.id));
      draw(currentList);
    });
    headRow.querySelectorAll('.sortable-th').forEach((th) => th.addEventListener('click', () => {
      const key = th.dataset.key;
      sortDir = (sortKey === key) ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc';
      sortKey = key;
      drawHead();
      draw(currentList);
    }));
    makeColumnsResizable(headRow.closest('table'), 'itemList');
  }

  function draw(list) {
    currentList = list;
    const body = document.getElementById('invBody');
    const colSpan = activeColumns.length + 2;
    if (list.length === 0) { body.innerHTML = `<tr><td colspan="${colSpan}" class="empty-state">No items yet.</td></tr>`; return; }
    const sorted = sortKey ? sortRowsBy(list, INVENTORY_COLUMNS, sortKey, sortDir) : list;
    body.innerHTML = sorted.map((p) => `
      <tr>
        <td><input type="checkbox" class="inv-row-check" data-id="${p.id}" ${selectedIds.has(p.id) ? 'checked' : ''} /></td>
        ${activeColumns.map((key) => {
          const c = INVENTORY_COLUMNS.find((x) => x.key === key);
          return `<td>${c ? c.render(p) : '—'}</td>`;
        }).join('')}
        <td><button class="btn btn-sm tag-btn" data-id="${p.id}">Tag</button> <button class="btn btn-sm edit-btn" data-id="${p.id}">Edit</button> <button class="btn btn-sm btn-danger del-btn" data-id="${p.id}">Delete</button></td>
      </tr>
    `).join('');
    body.querySelectorAll('.inv-row-check').forEach((cb) => cb.addEventListener('change', (e) => {
      const id = Number(e.target.dataset.id);
      if (e.target.checked) selectedIds.add(id); else selectedIds.delete(id);
    }));
    body.querySelectorAll('.tag-btn').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.id);
      openItemTagsModal(currentList, new Set([id]), 'selected');
    }));
    body.querySelectorAll('.edit-btn').forEach((b) => b.addEventListener('click', () => openProductModal(categories, products.find((p) => p.id === Number(b.dataset.id)))));
    body.querySelectorAll('.del-btn').forEach((b) => b.addEventListener('click', async () => {
      if (confirmGuarded('delete', 'Delete this item?')) { await Api.del(`/api/products/${b.dataset.id}`); navigate('inventory'); }
    }));
  }

  drawHead();
  draw(products);

  document.getElementById('invSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    draw(products.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q) ||
      (p.barcode || '').toLowerCase().includes(q) ||
      (p.item_number || '').toLowerCase().includes(q) ||
      (p.category_name || '').toLowerCase().includes(q)
    ));
  });
  document.getElementById('addItemBtn').addEventListener('click', () => openProductModal(categories, null));
  document.getElementById('importItemsBtn').addEventListener('click', () => openImportModal());
  document.getElementById('physicalInventoryBtn').addEventListener('click', () => navigate('physicalInventory'));
  document.getElementById('printTagsBtn').addEventListener('click', () => {
    openItemTagsModal(currentList, selectedIds, selectedIds.size > 0 ? 'selected' : 'all');
  });
  document.getElementById('customizeColumnsBtn').addEventListener('click', () => {
    openColumnCustomizerModal(INVENTORY_COLUMNS, DEFAULT_INVENTORY_COLUMNS, activeColumns, (newColumns) => {
      activeColumns = newColumns;
      saveInventoryColumns(newColumns);
      drawHead();
      draw(currentList);
      toast('Columns updated.', 'success');
    });
  });
  attachZoomContextMenu(content.querySelector('.table-wrap'), 'inventory');
}

// Receive Items -> Print -> Print Tags. Matches QuickBooks POS's Receiving
// Voucher print dialog: choose all items on the voucher or just the checked
// ones, choose how many tags per item, then print. `activeLines` are the
// voucher lines with a qty > 0; `selectedIds` is the Set of checked
// product_ids from the lines table; `products` resolves each line to its
// full product record (Item Number, price, etc.) for the tag itself.
function openReceiveTagsModal(activeLines, selectedIds, products) {
  const savedScale = Number(localStorage.getItem(TAG_SCALE_KEY) || '1');
  const overlay = openModal(`
    <h2>${icon('printer', 18)} Print Tags</h2>
    <div class="check-group">
      <label class="check-row"><input type="radio" name="rtWhich" value="all" checked /> All -- print tags for all items on this voucher</label>
      <label class="check-row"><input type="radio" name="rtWhich" value="selected" ${selectedIds.size === 0 ? 'disabled' : ''} /> Selected -- print tags only for checked item(s) ${selectedIds.size === 0 ? '(check some rows first)' : `(${selectedIds.size} checked)`}</label>
    </div>
    <div class="check-group">
      <label class="check-row"><input type="radio" name="rtCopies" value="one" checked /> 1 tag per item</label>
      <label class="check-row"><input type="radio" name="rtCopies" value="custom" /> <span>Copies per item</span> <input type="number" id="rtCustomCopies" min="1" max="999" value="1" class="inline-number" /></label>
      <label class="check-row"><input type="radio" name="rtCopies" value="matchQty" /> Match quantity received (one tag per unit)</label>
    </div>
    <label class="field mt">Tag Size
      <select id="rtScaleSelect">
        ${TAG_SCALE_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === savedScale ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
    </label>
    <div id="rtSummary" class="empty-state summary-box"></div>
    <div class="modal-actions">
      <button type="button" class="btn" id="rtCancelBtn">Cancel</button>
      <button type="button" class="btn" id="rtPreviewBtn">${icon('search', 14)} Preview</button>
      <button type="button" class="btn btn-primary" id="rtPrintBtn">${icon('printer', 14)} Print</button>
    </div>
  `);

  // Shared by the live summary, Preview, and Print -- so what you're told
  // is exactly what prints.
  function buildTagList() {
    const which = overlay.querySelector('input[name="rtWhich"]:checked').value;
    const copiesMode = overlay.querySelector('input[name="rtCopies"]:checked').value;
    const customCopies = Math.max(1, Number(overlay.querySelector('#rtCustomCopies').value) || 1);
    const targetLines = which === 'selected' ? activeLines.filter((l) => selectedIds.has(l.product_id)) : activeLines;
    const items = [];
    const tagList = [];
    targetLines.forEach((l) => {
      const product = products.find((p) => p.id === l.product_id);
      if (!product) return;
      const copies = copiesMode === 'custom' ? customCopies : copiesMode === 'matchQty' ? Math.max(1, Number(l.qty) || 1) : 1;
      // Use this line's own Regular Price, not the stale Item List record --
      // it may have just been adjusted on this voucher (e.g. bumped up via
      // Markup % to cover freight) and hasn't been saved yet, so the tag
      // needs to reflect that new price, not the old one.
      const taggedProduct = { ...product, price: l.price !== '' && l.price != null ? Number(l.price) : product.price };
      items.push({ name: product.name, copies });
      for (let i = 0; i < copies; i++) tagList.push(taggedProduct);
    });
    return { tagList, items };
  }

  function drawSummary() {
    const { tagList, items } = buildTagList();
    const summaryEl = overlay.querySelector('#rtSummary');
    if (items.length === 0) {
      summaryEl.textContent = 'No items to tag -- check a row first, or choose "All".';
      return;
    }
    summaryEl.innerHTML = `
      <strong>${tagList.length} tag${tagList.length === 1 ? '' : 's'}</strong> for ${items.length} item${items.length === 1 ? '' : 's'}:
      <ul class="plain-list">
        ${items.map((it) => `<li>${escapeHtml(it.name)} &times; ${it.copies}</li>`).join('')}
      </ul>
    `;
  }

  overlay.querySelectorAll('input[name="rtWhich"], input[name="rtCopies"]').forEach((el) => el.addEventListener('change', drawSummary));
  overlay.querySelector('#rtCustomCopies').addEventListener('input', drawSummary);
  drawSummary();

  overlay.querySelector('#rtCancelBtn').addEventListener('click', () => overlay.remove());

  function commit(autoPrint) {
    const { tagList } = buildTagList();
    if (tagList.length === 0) { toast('No items to tag -- check a row first, or choose "All".', 'error'); return; }
    const scale = Number(overlay.querySelector('#rtScaleSelect').value);
    localStorage.setItem(TAG_SCALE_KEY, String(scale));
    overlay.remove();
    printInventoryTags(tagList, scale, autoPrint);
  }
  overlay.querySelector('#rtPreviewBtn').addEventListener('click', () => commit(false));
  overlay.querySelector('#rtPrintBtn').addEventListener('click', () => commit(true));
}

// QuickBooks POS-style "Tag Preview" dialog -- just asks how many copies of
// the current tag layout to lay out on a print-preview sheet.
function openTagPreviewCountModal(onConfirm) {
  const overlay = openModal(`
    <h2>Tag Preview</h2>
    <label>How many tags to preview?
      <input type="number" id="tagPreviewCount" min="1" max="200" value="10" />
    </label>
    <div class="modal-actions">
      <button type="button" class="btn" id="tagPreviewCancelBtn">Cancel</button>
      <button type="button" class="btn btn-primary" id="tagPreviewOkBtn">${icon('check', 14)} OK</button>
    </div>
  `);
  overlay.querySelector('#tagPreviewCancelBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#tagPreviewOkBtn').addEventListener('click', () => {
    const n = Math.max(1, Math.min(200, Number(overlay.querySelector('#tagPreviewCount').value) || 1));
    overlay.remove();
    onConfirm(n);
  });
}

const TAG_SCALE_KEY = 'saffron.inventoryTagScale';
const TAG_SCALE_OPTIONS = [
  { value: 0.5, label: 'Extra Small (50%)' },
  { value: 0.65, label: 'Small (65%)' },
  { value: 0.8, label: 'Compact (80%)' },
  { value: 1, label: 'Default (100%)' },
];

// Item List -> Print -> Print Tags. Matches QuickBooks POS's Item List
// print dialog: All (every item currently listed) vs Selected (checked
// rows only), how many copies per item -- including "On Hand Quantities"
// (one tag per physical unit in stock) -- plus tag size, Preview and Print.
// `list` is whatever's currently shown (post-search); `selectedIds` is the
// Set of checked product ids; `defaultWhich` lets the per-row "Tag" button
// open straight into "just this one" while still letting someone switch to
// "All" without closing and reopening.
function openItemTagsModal(list, selectedIds, defaultWhich = 'all') {
  const savedScale = Number(localStorage.getItem(TAG_SCALE_KEY) || '1');
  const overlay = openModal(`
    <h2>${icon('printer', 18)} Print Tags</h2>
    <div class="check-group">
      <label class="check-row"><input type="radio" name="itWhich" value="all" ${defaultWhich === 'all' ? 'checked' : ''} /> All -- print tags for all items in this list</label>
      <label class="check-row"><input type="radio" name="itWhich" value="selected" ${defaultWhich === 'selected' ? 'checked' : ''} ${selectedIds.size === 0 ? 'disabled' : ''} /> Selected -- print tags only for checked item(s) ${selectedIds.size === 0 ? '(check some rows first)' : `(${selectedIds.size} checked)`}</label>
    </div>
    <div class="check-group">
      <label class="check-row"><input type="radio" name="itCopies" value="one" checked /> 1 tag per item</label>
      <label class="check-row"><input type="radio" name="itCopies" value="custom" /> <span>Copies per item</span> <input type="number" id="itCustomCopies" min="1" max="999" value="1" class="inline-number" /></label>
      <label class="check-row"><input type="radio" name="itCopies" value="onHand" /> On Hand Quantities (one tag per unit in stock)</label>
    </div>
    <label class="field mt">Tag Size
      <select id="itScaleSelect">
        ${TAG_SCALE_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === savedScale ? 'selected' : ''}>${o.label}</option>`).join('')}
      </select>
    </label>
    <div id="itSummary" class="empty-state summary-box"></div>
    <div class="modal-actions">
      <button type="button" class="btn" id="itCancelBtn">Cancel</button>
      <button type="button" class="btn" id="itPreviewBtn">${icon('search', 14)} Preview</button>
      <button type="button" class="btn btn-primary" id="itPrintBtn">${icon('printer', 14)} Print</button>
    </div>
  `);

  // Shared by the live summary, Preview, and Print -- so what you're told
  // is exactly what prints. On Hand Quantities skips anything at zero/negative
  // on-hand (screenshot's item list shows items can go negative) -- there's
  // nothing sensible to tag there.
  function buildTagList() {
    const which = overlay.querySelector('input[name="itWhich"]:checked').value;
    const copiesMode = overlay.querySelector('input[name="itCopies"]:checked').value;
    const customCopies = Math.max(1, Number(overlay.querySelector('#itCustomCopies').value) || 1);
    const targetProducts = which === 'selected' ? list.filter((p) => selectedIds.has(p.id)) : list;
    const items = [];
    const tagList = [];
    targetProducts.forEach((p) => {
      const copies = copiesMode === 'custom' ? customCopies : copiesMode === 'onHand' ? Math.max(0, Math.floor(Number(p.qty_on_hand) || 0)) : 1;
      if (copies <= 0) return;
      items.push({ name: p.name, copies });
      for (let i = 0; i < copies; i++) tagList.push(p);
    });
    return { tagList, items };
  }

  function drawSummary() {
    const { tagList, items } = buildTagList();
    const summaryEl = overlay.querySelector('#itSummary');
    if (items.length === 0) {
      summaryEl.textContent = 'No items to tag -- check a row first, choose "All", or these items have nothing on hand.';
      return;
    }
    summaryEl.innerHTML = `
      <strong>${tagList.length} tag${tagList.length === 1 ? '' : 's'}</strong> for ${items.length} item${items.length === 1 ? '' : 's'}:
      <ul class="plain-list scroll">
        ${items.map((it) => `<li>${escapeHtml(it.name)} &times; ${it.copies}</li>`).join('')}
      </ul>
    `;
  }

  overlay.querySelectorAll('input[name="itWhich"], input[name="itCopies"]').forEach((el) => el.addEventListener('change', drawSummary));
  overlay.querySelector('#itCustomCopies').addEventListener('input', drawSummary);
  drawSummary();

  overlay.querySelector('#itCancelBtn').addEventListener('click', () => overlay.remove());

  function commit(autoPrint) {
    const { tagList } = buildTagList();
    if (tagList.length === 0) { toast('No items to tag -- check a row first, choose "All", or these items have nothing on hand.', 'error'); return; }
    const scale = Number(overlay.querySelector('#itScaleSelect').value);
    localStorage.setItem(TAG_SCALE_KEY, String(scale));
    overlay.remove();
    printInventoryTags(tagList, scale, autoPrint);
  }
  overlay.querySelector('#itPreviewBtn').addEventListener('click', () => commit(false));
  overlay.querySelector('#itPrintBtn').addEventListener('click', () => commit(true));
}

// Prints one Inventory Tag per product, laid out as a wrapping sheet of
// tags (like a sticker sheet) so a batch of restocked items can be tagged
// in one pass. Each tag honors the Print Designer's Inventory Tag template.
// `scale` shrinks (or grows) every tag via CSS transform so more of them
// fit on a page -- the outer wrapper is sized to the scaled footprint so
// flex-wrap still packs them tightly instead of leaving gaps.
function printInventoryTags(list, scale = 1, autoPrint = true) {
  const template = getPrintTemplate('inventoryTag');
  const { w, h } = template.canvasSize || PRINT_DOC_TYPES.inventoryTag.canvasSize;
  const tags = list.map((p) => `
    <div style="width:${(w * scale).toFixed(1)}px; height:${(h * scale).toFixed(1)}px; overflow:hidden;">
      <div style="width:${w}px; height:${h}px; transform:scale(${scale}); transform-origin: top left;">
        ${renderInventoryTagDoc(template, p)}
      </div>
    </div>
  `).join('');
  const body = `<div style="display:flex; flex-wrap:wrap; gap:8px;">${tags}</div>`;
  openPrintDoc('Inventory Tags', body, { autoPrint, margin: printMarginFor('inventoryTag') });
}

function openProductModal(categories, product, onSaved) {
  const isEdit = !!product;
  const overlay = openModal(`
    <h2>${isEdit ? 'Edit Item' : 'Add Item'}</h2>
    <form id="productForm" class="form-grid">
      <label>Item Number<input value="${isEdit ? escapeHtml(product?.item_number || '') : '(auto-generated after saving)'}" disabled title="System-assigned identifier -- used for self-printed barcode tags, never editable" /></label>
      <label>Name<input name="name" required value="${escapeHtml(product?.name || '')}" /></label>
      <label>SKU<input name="sku" value="${escapeHtml(product?.sku || '')}" /></label>
      <label>Barcode
        <div class="field-row">
          <input name="barcode" value="${escapeHtml(product?.barcode || '')}" />
          <button type="button" class="btn" id="scanBarcodeFieldBtn" title="Scan with camera" aria-label="Scan with camera">${icon('camera', 14)}</button>
        </div>
      </label>
      <label>Department
        <select name="category_id">
          <option value="">None</option>
          <option value="__add_department__">+ Add New Department&hellip;</option>
          ${categories.map((c) => `<option value="${c.id}" ${product?.category_id === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </label>
      <label>Price<input name="price" type="number" step="0.01" required value="${product?.price ?? ''}" /></label>
      <label>Cost (average)<input name="cost" type="number" step="0.01" value="${product?.cost ?? 0}" /></label>
      <label>Order Cost<input name="order_cost" type="number" step="0.01" value="${product?.order_cost ?? 0}" /></label>
      <label>Qty on Hand<input name="qty_on_hand" type="number" step="1" value="${product?.qty_on_hand ?? 0}" /></label>
      <label>Reorder Level<input name="reorder_level" type="number" step="1" value="${product?.reorder_level ?? 0}" /></label>
      <div class="modal-actions span-all">
        <button type="button" class="btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Add Item'}</button>
      </div>
    </form>
  `);
  overlay.querySelector('#cancelBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#scanBarcodeFieldBtn').addEventListener('click', () => {
    openBarcodeScanner((code) => {
      overlay.querySelector('[name="barcode"]').value = code;
      toast('Barcode captured.', 'success');
    });
  });
  // "+ Add New Department..." bows out of the item form and drops the
  // person on the Department List, matching QuickBooks POS's "<Add New>"
  // combo-box entries -- they add the department there, then come back and
  // reopen Add Item to pick it up in the dropdown.
  overlay.querySelector('[name="category_id"]').addEventListener('change', (e) => {
    if (e.target.value !== '__add_department__') return;
    overlay.remove();
    toast('Add the new department here, then reopen Add Item to assign it.', '');
    navigate('departments');
  });
  overlay.querySelector('#productForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.price = Number(body.price); body.cost = Number(body.cost); body.order_cost = Number(body.order_cost);
    body.qty_on_hand = Number(body.qty_on_hand); body.reorder_level = Number(body.reorder_level);
    body.category_id = body.category_id || null;
    if (isEdit && !confirmGuarded('edit', 'Save changes to this item?')) return;
    try {
      if (isEdit) await Api.put(`/api/products/${product.id}`, body);
      else await Api.post('/api/products', body);
      overlay.remove();
      if (onSaved) onSaved({ ...product, ...body, id: product?.id });
      else navigate('inventory');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// =====================================================================
// PHYSICAL INVENTORY
// =====================================================================
async function renderPhysicalInventory() {
  const products = await Api.get('/api/products');

  content.innerHTML = `
    <div class="view-header">
      <h1>Physical Inventory</h1>
      <div class="view-actions">
        <input type="search" class="search-input" id="piSearch" placeholder="Search items&hellip;" />
        <button class="btn" id="piCustomizeColumnsBtn">${icon('columns', 14)} <span><span class="hide-phone">Customize&nbsp;</span>Columns</span></button>
        <div class="pd-add-wrap">
          <button class="btn" id="piPrintBtn">${icon('printer', 14)} Print &#9662;</button>
          <div id="piPrintMenu" class="pd-add-menu" hidden>
            <button type="button" class="pi-print-option" data-kind="worksheet">PI Worksheet for current item view</button>
            <button type="button" class="pi-print-option" data-kind="differences">PI Differences Report</button>
          </div>
        </div>
        <button class="btn" id="piHistoryBtn">History</button>
        <button class="btn btn-primary" id="piApplyBtn">Apply Changes to Inventory</button>
      </div>
    </div>
    <p class="note">
      Enter the quantity you actually have on hand in the Counted column, then select "Apply Changes to Inventory" to adjust on-hand quantities by the difference.
    </p>
    <label class="check-row mb">
      <input type="checkbox" id="piZeroUncounted" /> Set all items not counted to zero
    </label>
    <div class="card table-wrap">
      <table>
        <thead><tr id="piHeadRow"></tr></thead>
        <tbody id="piBody"></tbody>
      </table>
    </div>
    <div class="card card-narrow">
      <h2>Totals</h2>
      <table>
        <thead><tr><th></th><th>Quantity</th><th>Price</th><th>Cost</th></tr></thead>
        <tbody>
          <tr><td>More than expected</td><td id="piMoreQty">0</td><td id="piMorePrice">${money(0)}</td><td id="piMoreCost">${money(0)}</td></tr>
          <tr><td>Less than expected</td><td id="piLessQty">0</td><td id="piLessPrice">${money(0)}</td><td id="piLessCost">${money(0)}</td></tr>
          <tr><td><strong>Net difference</strong></td><td id="piNetQty"><strong>0</strong></td><td id="piNetPrice"><strong>${money(0)}</strong></td><td id="piNetCost"><strong>${money(0)}</strong></td></tr>
        </tbody>
      </table>
    </div>
  `;
  attachZoomContextMenu(content.querySelector('.table-wrap'), 'physicalInventory');

  let activeColumns = physicalInventoryColumnStore.load();

  // Entered counts live here, keyed by product id, independent of which rows
  // are currently visible -- so filtering the search box never discards a
  // count someone already typed in, and totals/Apply always account for
  // every item counted so far, not just what's on screen right now.
  const enteredCounts = new Map();
  let currentList = products;

  function drawHead() {
    document.getElementById('piHeadRow').innerHTML =
      activeColumns.map((key) => {
        const c = PHYSICAL_INVENTORY_COLUMNS.find((x) => x.key === key);
        return `<th>${escapeHtml(c ? c.label : key)}</th>`;
      }).join('') + '<th>Difference Qty</th><th>Counted</th>';
  }

  function draw(list) {
    currentList = list;
    const body = document.getElementById('piBody');
    const colSpan = activeColumns.length + 2;
    if (list.length === 0) { body.innerHTML = `<tr><td colspan="${colSpan}" class="empty-state">No items found.</td></tr>`; return; }
    body.innerHTML = list.map((p) => {
      const entered = enteredCounts.has(p.id) ? enteredCounts.get(p.id) : '';
      return `
      <tr data-id="${p.id}" data-price="${p.price}" data-cost="${p.cost}">
        ${activeColumns.map((key) => {
          const c = PHYSICAL_INVENTORY_COLUMNS.find((x) => x.key === key);
          return `<td>${c ? c.render(p) : '—'}</td>`;
        }).join('')}
        <td class="pi-diff">${entered === '' ? '—' : fmtDiff(fmtQty(Number(entered) - (Number(p.qty_on_hand) || 0)))}</td>
        <td><input type="number" step="any" class="pi-counted" data-expected="${p.qty_on_hand}" value="${entered}" /></td>
      </tr>`;
    }).join('');
    body.querySelectorAll('.pi-counted').forEach((input) => {
      input.addEventListener('input', () => {
        const id = Number(input.closest('tr').dataset.id);
        if (input.value === '') enteredCounts.delete(id);
        else enteredCounts.set(id, input.value);
        updateDiffCell(input);
        recalcTotals();
      });
    });
  }

  function fmtDiff(diff) {
    return diff > 0 ? `+${diff}` : `${diff}`;
  }

  function updateDiffCell(input) {
    const diffCell = input.closest('tr').querySelector('.pi-diff');
    if (input.value === '') { diffCell.textContent = '—'; diffCell.style.color = ''; return; }
    const expected = Number(input.dataset.expected) || 0;
    const diff = fmtQty(Number(input.value) - expected);
    diffCell.textContent = fmtDiff(diff);
    diffCell.style.color = diff > 0 ? 'var(--green)' : (diff < 0 ? 'var(--red)' : '');
  }

  function recalcTotals() {
    const zeroUncounted = document.getElementById('piZeroUncounted').checked;
    let moreQty = 0, morePrice = 0, moreCost = 0, lessQty = 0, lessPrice = 0, lessCost = 0;
    products.forEach((p) => {
      const hasValue = enteredCounts.has(p.id);
      if (!hasValue && !zeroUncounted) return;
      const expected = Number(p.qty_on_hand) || 0;
      const counted = hasValue ? Number(enteredCounts.get(p.id)) : 0;
      const diff = counted - expected;
      if (diff === 0) return;
      const price = Number(p.price) || 0;
      const cost = Number(p.cost) || 0;
      if (diff > 0) { moreQty += diff; morePrice += diff * price; moreCost += diff * cost; }
      else { lessQty += diff; lessPrice += diff * price; lessCost += diff * cost; }
    });
    document.getElementById('piMoreQty').textContent = fmtQty(moreQty);
    document.getElementById('piMorePrice').textContent = money(morePrice);
    document.getElementById('piMoreCost').textContent = money(moreCost);
    document.getElementById('piLessQty').textContent = fmtQty(lessQty);
    document.getElementById('piLessPrice').textContent = money(lessPrice);
    document.getElementById('piLessCost').textContent = money(lessCost);
    document.getElementById('piNetQty').innerHTML = `<strong>${fmtQty(moreQty + lessQty)}</strong>`;
    document.getElementById('piNetPrice').innerHTML = `<strong>${money(morePrice + lessPrice)}</strong>`;
    document.getElementById('piNetCost').innerHTML = `<strong>${money(moreCost + lessCost)}</strong>`;
  }

  drawHead();
  draw(products);

  document.getElementById('piSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    draw(products.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q) ||
      (p.barcode || '').toLowerCase().includes(q) ||
      (p.item_number || '').toLowerCase().includes(q)
    ));
  });

  document.getElementById('piCustomizeColumnsBtn').addEventListener('click', () => {
    openColumnCustomizerModal(PHYSICAL_INVENTORY_COLUMNS, DEFAULT_PHYSICAL_INVENTORY_COLUMNS, activeColumns, (newColumns) => {
      activeColumns = newColumns;
      physicalInventoryColumnStore.save(newColumns);
      drawHead();
      draw(currentList);
      toast('Columns updated.', 'success');
    });
  });

  document.getElementById('piZeroUncounted').addEventListener('change', recalcTotals);
  document.getElementById('piHistoryBtn').addEventListener('click', () => navigate('physicalInventoryHistory'));

  document.getElementById('piApplyBtn').addEventListener('click', async () => {
    const zeroUncounted = document.getElementById('piZeroUncounted').checked;
    const counts = [];
    products.forEach((p) => {
      const hasValue = enteredCounts.has(p.id);
      if (!hasValue && !zeroUncounted) return;
      counts.push({ product_id: p.id, counted_qty: hasValue ? Number(enteredCounts.get(p.id)) : 0 });
    });
    if (counts.length === 0) { toast('Enter a counted quantity for at least one item.', 'error'); return; }
    if (!confirmGuarded('edit', `Apply changes to inventory for ${counts.length} item${counts.length === 1 ? '' : 's'}? This updates quantity on hand.`)) return;
    try {
      const result = await Api.post('/api/physical-inventory/apply', { counts });
      toast(`Physical inventory applied — ${result.updated} item${result.updated === 1 ? '' : 's'} counted.`, 'success');
      navigate('inventory');
    } catch (err) { toast(err.message, 'error'); }
  });

  // ---- Print ----
  const printMenu = document.getElementById('piPrintMenu');
  document.getElementById('piPrintBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    printMenu.hidden = !printMenu.hidden;
  });
  document.addEventListener('click', () => { printMenu.hidden = true; });
  printMenu.addEventListener('click', (e) => e.stopPropagation());

  function openPrintWindow(title, rowsHtml, headHtml) {
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { toast('Your browser blocked the print window. Please allow pop-ups for this site.', 'error'); return; }
    win.document.write(`
      <!DOCTYPE html><html><head><title>${escapeHtml(title)}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; color: #1a1a1a; }
        h1 { font-size: 18px; margin: 0 0 4px; }
        p.meta { margin: 0 0 20px; font-size: 12px; color: #666; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
        th { background: #f4f4f4; }
        @media print { body { padding: 0; } }
      </style>
      </head><body>
        <h1>${escapeHtml(title)}</h1>
        <p class="meta">Saffron POS &middot; ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>
        <table><thead><tr>${headHtml}</tr></thead><tbody>${rowsHtml}</tbody></table>
      </body></html>
    `);
    win.document.close();
    win.onload = () => { win.focus(); win.print(); };
  }

  document.querySelectorAll('.pi-print-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      printMenu.hidden = true;
      if (btn.dataset.kind === 'worksheet') {
        const rowsHtml = currentList.map((p) => `
          <tr>
            <td>${escapeHtml(p.sku || '—')}</td>
            <td>${escapeHtml(p.name)}</td>
            <td>${fmtQty(p.qty_on_hand)}</td>
            <td></td>
          </tr>
        `).join('') || '<tr><td colspan="4">No items in this view.</td></tr>';
        openPrintWindow(
          'Physical Inventory Worksheet',
          rowsHtml,
          '<th>SKU</th><th>Item Name</th><th>Expected</th><th>Counted</th>'
        );
      } else {
        const counted = products.filter((p) => enteredCounts.has(p.id));
        if (counted.length === 0) { toast('No items have been counted yet.', 'error'); return; }
        const rowsHtml = counted.map((p) => {
          const countedQty = Number(enteredCounts.get(p.id));
          const expected = Number(p.qty_on_hand) || 0;
          const diff = fmtQty(countedQty - expected);
          return `
          <tr>
            <td>${escapeHtml(p.sku || '—')}</td>
            <td>${escapeHtml(p.name)}</td>
            <td>${fmtQty(expected)}</td>
            <td>${fmtQty(countedQty)}</td>
            <td>${fmtDiff(diff)}</td>
          </tr>`;
        }).join('');
        openPrintWindow(
          'Physical Inventory Differences Report',
          rowsHtml,
          '<th>SKU</th><th>Item Name</th><th>Expected</th><th>Counted</th><th>Difference</th>'
        );
      }
    });
  });
}

async function renderPhysicalInventoryHistory() {
  content.innerHTML = `
    <div class="view-header">
      <h1>Physical Inventory History</h1>
      <div class="view-actions">
        ${dateRangeBarHtml({ presetId: 'pihRangePreset', fromId: 'pihFromDate', toId: 'pihToDate', applyId: 'pihApplyBtn', includeAll: true })}
      </div>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Item</th><th>Expected</th><th>Counted</th><th>Difference</th><th>Counted By</th></tr></thead>
        <tbody id="pihBody"><tr><td colspan="6" class="empty-state">Loading&hellip;</td></tr></tbody>
      </table>
    </div>
  `;
  attachZoomContextMenu(content.querySelector('.table-wrap'), 'physicalInventoryHistory');

  const presetSelect = document.getElementById('pihRangePreset');
  const fromInput = document.getElementById('pihFromDate');
  const toInput = document.getElementById('pihToDate');
  wireDateRangePreset(presetSelect, fromInput, toInput);

  async function run() {
    const qs = new URLSearchParams();
    if (fromInput.value) qs.set('from', fromInput.value);
    if (toInput.value) qs.set('to', toInput.value);
    const rows = await Api.get(`/api/physical-inventory/history?${qs.toString()}`);
    document.getElementById('pihBody').innerHTML = rows.map((r) => `
      <tr>
        <td>${new Date(r.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${r.expected_qty}</td>
        <td>${r.counted_qty}</td>
        <td style="color:${Number(r.difference_qty) > 0 ? 'var(--green)' : 'var(--red)'};">${Number(r.difference_qty) > 0 ? '+' : ''}${r.difference_qty}</td>
        <td>${escapeHtml(r.counted_by || '—')}</td>
      </tr>
    `).join('') || '<tr><td colspan="6" class="empty-state">No physical inventory counts recorded in this range.</td></tr>';
  }

  document.getElementById('pihApplyBtn').addEventListener('click', run);
  run();
}

// =====================================================================
// CUSTOMERS
// =====================================================================
const CUSTOMERS_COLUMNS = [
  { key: 'name', label: 'Name', sortValue: (c) => c.name || '' },
  { key: 'email', label: 'Email', sortValue: (c) => c.email || '' },
  { key: 'phone', label: 'Phone', sortValue: (c) => c.phone || '' },
  { key: 'loyalty_points', label: 'Loyalty Pts', sortValue: (c) => Number(c.loyalty_points) || 0 }
];

async function renderCustomers() {
  const customers = await Api.get('/api/customers');
  let sortKey = null;
  let sortDir = 'asc';
  let currentList = customers;
  content.innerHTML = `
    <div class="view-header">
      <h1>Customer List</h1>
      <div class="view-actions">
        <input type="search" class="search-input" id="custSearch" placeholder="Search customers&hellip;" />
        <button class="btn btn-primary" id="addCustBtn">+ Add Customer</button>
      </div>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr id="custHeadRow"></tr></thead>
        <tbody id="custBody"></tbody>
      </table>
    </div>
  `;
  attachZoomContextMenu(content.querySelector('.table-wrap'), 'customers');
  function drawHead() {
    const headRow = document.getElementById('custHeadRow');
    headRow.innerHTML = CUSTOMERS_COLUMNS.map((col) =>
      `<th class="sortable-th" data-key="${col.key}" title="Click to sort">${escapeHtml(col.label)}${sortArrowHtml(col.key === sortKey, sortDir)}</th>`
    ).join('') + '<th class="no-resize"></th>';
    headRow.querySelectorAll('.sortable-th').forEach((th) => th.addEventListener('click', () => {
      const key = th.dataset.key;
      sortDir = (sortKey === key) ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc';
      sortKey = key;
      drawHead();
      draw(currentList);
    }));
    makeColumnsResizable(headRow.closest('table'), 'customers');
  }
  function draw(list) {
    currentList = list;
    const body = document.getElementById('custBody');
    if (list.length === 0) { body.innerHTML = '<tr><td colspan="5" class="empty-state">No customers yet.</td></tr>'; return; }
    const sorted = sortKey ? sortRowsBy(list, CUSTOMERS_COLUMNS, sortKey, sortDir) : list;
    body.innerHTML = sorted.map((c) => `
      <tr>
        <td>${escapeHtml(c.name)}</td>
        <td>${escapeHtml(c.email || '—')}</td>
        <td>${escapeHtml(c.phone || '—')}</td>
        <td>${c.loyalty_points}</td>
        <td><button class="btn btn-sm id-card-btn" data-id="${c.id}">Print ID</button> <button class="btn btn-sm edit-btn" data-id="${c.id}">Edit</button></td>
      </tr>
    `).join('');
    body.querySelectorAll('.id-card-btn').forEach((b) => b.addEventListener('click', () => {
      const customer = sorted.find((c) => c.id === Number(b.dataset.id));
      openPrintDoc(`ID Card - ${customer.name}`, renderCustomerIdDoc(getPrintTemplate('customerId'), customer), { margin: printMarginFor('customerId') });
    }));
    body.querySelectorAll('.edit-btn').forEach((b) => b.addEventListener('click', () => openCustomerModal(sorted.find((c) => c.id === Number(b.dataset.id)))));
  }
  drawHead();
  draw(customers);
  document.getElementById('custSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    draw(customers.filter((c) =>
      c.name.toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.phone || '').toLowerCase().includes(q)
    ));
  });
  document.getElementById('addCustBtn').addEventListener('click', () => openCustomerModal(null));
}

// `onSaved(customer)` is optional -- when provided (e.g. the Sale screen's
// "+ New" quick-add), it's called with the saved customer instead of
// navigating to the Customers screen, so callers elsewhere in the app don't
// lose whatever they were in the middle of (like an in-progress cart).
function openCustomerModal(customer, onSaved) {
  const isEdit = !!customer;
  const overlay = openModal(`
    <h2>${isEdit ? 'Edit Customer' : 'Add Customer'}</h2>
    <form id="custForm" class="form-grid">
      <label>Name<input name="name" required value="${escapeHtml(customer?.name || '')}" /></label>
      <label>Email<input name="email" type="email" value="${escapeHtml(customer?.email || '')}" /></label>
      <label>Phone<input name="phone" value="${escapeHtml(customer?.phone || '')}" /></label>
      <label class="span-all">Notes<input name="notes" value="${escapeHtml(customer?.notes || '')}" /></label>
      <div class="modal-actions span-all">
        <button type="button" class="btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Add Customer'}</button>
      </div>
    </form>
  `);
  overlay.querySelector('#cancelBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#custForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    if (isEdit && !confirmGuarded('edit', 'Save changes to this customer?')) return;
    try {
      let saved;
      if (isEdit) { await Api.put(`/api/customers/${customer.id}`, body); saved = { id: customer.id, ...body }; }
      else { const info = await Api.post('/api/customers', body); saved = { id: info.id, ...body }; }
      overlay.remove();
      if (onSaved) onSaved(saved);
      else navigate('customers');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// =====================================================================
// REPORTS
// =====================================================================
// Date-range presets for the Reports screen, mirroring QuickBooks POS's
// "Custom / Today / This Week / ..." dropdown -- picking one fills in
// From/To, "Custom" leaves them alone for manual entry.
function reportPresetRange(preset) {
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const startOfToday = () => new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (preset) {
    case 'today': { const d = startOfToday(); return { from: fmt(d), to: fmt(d) }; }
    case 'yesterday': { const d = startOfToday(); d.setDate(d.getDate() - 1); return { from: fmt(d), to: fmt(d) }; }
    case 'this_week': {
      const d = startOfToday();
      const start = new Date(d); start.setDate(d.getDate() - d.getDay());
      return { from: fmt(start), to: fmt(d) };
    }
    case 'last_week': {
      const d = startOfToday();
      const thisWeekStart = new Date(d); thisWeekStart.setDate(d.getDate() - d.getDay());
      const start = new Date(thisWeekStart); start.setDate(thisWeekStart.getDate() - 7);
      const end = new Date(thisWeekStart); end.setDate(thisWeekStart.getDate() - 1);
      return { from: fmt(start), to: fmt(end) };
    }
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: fmt(start), to: fmt(startOfToday()) };
    }
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return { from: fmt(start), to: fmt(end) };
    }
    case 'this_quarter': {
      const start = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
      return { from: fmt(start), to: fmt(startOfToday()) };
    }
    case 'this_year': {
      const start = new Date(now.getFullYear(), 0, 1);
      return { from: fmt(start), to: fmt(startOfToday()) };
    }
    case 'last_year': {
      const start = new Date(now.getFullYear() - 1, 0, 1);
      const end = new Date(now.getFullYear() - 1, 11, 31);
      return { from: fmt(start), to: fmt(end) };
    }
    case 'all': return { from: '', to: '' }; // no bounds -- backend just returns everything
    default: return null; // 'custom' -- leave From/To as the user set them
  }
}

// The <option> list shared by every date-range dropdown. `includeAll` adds
// an "All Time" choice up front for history logs that should show
// everything by default (the combined Reports screen doesn't use this --
// it always defaults to a real day).
const DATE_RANGE_PRESETS = [
  ['custom', 'Custom'], ['today', 'Today'], ['yesterday', 'Yesterday'], ['this_week', 'This Week'], ['last_week', 'Last Week'],
  ['this_month', 'This Month'], ['last_month', 'Last Month'], ['this_quarter', 'This Quarter'], ['this_year', 'This Year'], ['last_year', 'Last Year']
];
function dateRangePresetOptions(includeAll, selected = '') {
  const opts = includeAll ? [['all', 'All Time'], ...DATE_RANGE_PRESETS] : DATE_RANGE_PRESETS;
  return opts.map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('');
}

// Wires up a preset <select> + From/To <input type="date"> trio: picking a
// preset fills the dates, editing a date by hand snaps the preset back to
// "Custom". Shared by every report/history screen with a date range.
function wireDateRangePreset(presetSelect, fromInput, toInput) {
  presetSelect.addEventListener('change', () => {
    const range = reportPresetRange(presetSelect.value);
    if (range) { fromInput.value = range.from; toInput.value = range.to; }
  });
  [fromInput, toInput].forEach((el) => el.addEventListener('input', () => { presetSelect.value = 'custom'; }));
}

// Report Center catalog -- mirrors QuickBooks POS's Reports menu grouping
// (category header, then a list of specific reports underneath). Every
// report here is one that already existed as a section on the old combined
// Reports page (or, for "detail", the already-existing GET /api/sales list)
// -- just reorganized into QuickBooks' pick-a-report style instead of one
// long scrolling page.
const REPORT_CATEGORIES = [
  {
    label: 'Sales',
    reports: [
      { key: 'summary', label: 'General Sales - Summary' },
      { key: 'detail', label: 'General Sales - Detail' },
      { key: 'topProducts', label: 'General Sales - Item Summary' },
      { key: 'byEmployee', label: 'Sales by Employee' },
      { key: 'byAssociate', label: 'Sales by Associate' }
    ]
  },
  {
    // Purchasing category is Purchase Orders + Receiving History + Vendors,
    // reorganized the same way as the Sales category -- QuickBooks' Multi-
    // Store and Transfers reports aren't included here since Saffron has no
    // multi-store or store-transfer feature to report on.
    label: 'Purchasing',
    reports: [
      { key: 'onOrderSummary', label: 'On Order - Summary' },
      { key: 'onOrderDetail', label: 'On Order - Detail' },
      { key: 'onOrderCash', label: 'On Order - Cash Requirements' },
      { key: 'receivingSummary', label: 'Receiving - Summary' },
      { key: 'receivingDetail', label: 'Receiving - Detail' },
      { key: 'vendorList', label: 'Vendors - Vendor List' }
    ]
  },
  {
    // Items category is the Item List + Physical Inventory adjustments +
    // Department List, reorganized the same way. "Multi-Store - Store
    // Inventory" and "Transfers" are skipped for the same reason as above.
    label: 'Items',
    reports: [
      { key: 'invSummary', label: 'Current Inventory - Summary' },
      { key: 'invSummaryActivity', label: 'Current Inventory - Summary With Activity' },
      { key: 'invItemList', label: 'Current Inventory - Item List' },
      { key: 'invValuation', label: 'Current Inventory - Inventory Valuation' },
      { key: 'invTurn', label: 'Current Inventory - Inventory Turn' },
      { key: 'invSummaryGraph', label: 'Current Inventory - Summary Graph' },
      { key: 'lowStock', label: 'Current Inventory - Low Stock' },
      { key: 'adjQtySummary', label: 'Adjustments - Quantity Summary' },
      { key: 'adjQtyDetail', label: 'Adjustments - Quantity Detail' },
      { key: 'adjCostSummary', label: 'Adjustments - Cost Summary' },
      { key: 'adjCostDetail', label: 'Adjustments - Cost Detail' },
      { key: 'departmentList', label: 'Departments - Department List' }
    ]
  }
];
const REPORT_META = {
  summary: { label: 'General Sales - Summary', dateBased: true },
  detail: { label: 'General Sales - Detail', dateBased: true },
  topProducts: { label: 'General Sales - Item Summary', dateBased: true },
  byEmployee: { label: 'Sales by Employee', dateBased: true },
  byAssociate: { label: 'Sales by Associate', dateBased: true },
  onOrderSummary: { label: 'On Order - Summary', dateBased: false },
  onOrderDetail: { label: 'On Order - Detail', dateBased: false },
  onOrderCash: { label: 'On Order - Cash Requirements', dateBased: false },
  receivingSummary: { label: 'Receiving - Summary', dateBased: true },
  receivingDetail: { label: 'Receiving - Detail', dateBased: true },
  vendorList: { label: 'Vendors - Vendor List', dateBased: false },
  invSummary: { label: 'Current Inventory - Summary', dateBased: false },
  invSummaryActivity: { label: 'Current Inventory - Summary With Activity', dateBased: true },
  invItemList: { label: 'Current Inventory - Item List', dateBased: false },
  invValuation: { label: 'Current Inventory - Inventory Valuation', dateBased: false },
  invTurn: { label: 'Current Inventory - Inventory Turn', dateBased: true },
  invSummaryGraph: { label: 'Current Inventory - Summary Graph', dateBased: false },
  lowStock: { label: 'Current Inventory - Low Stock', dateBased: false },
  adjQtySummary: { label: 'Adjustments - Quantity Summary', dateBased: true },
  adjQtyDetail: { label: 'Adjustments - Quantity Detail', dateBased: true },
  adjCostSummary: { label: 'Adjustments - Cost Summary', dateBased: true },
  adjCostDetail: { label: 'Adjustments - Cost Detail', dateBased: true },
  departmentList: { label: 'Departments - Department List', dateBased: false }
};

async function renderReports() {
  const today = new Date().toISOString().slice(0, 10);
  let activeReport = 'summary';
  let currentFrom = today;
  let currentTo = today;
  let currentPreset = 'today'; // survives switching between reports, like the dates do

  function panelHeaderHtml(key) {
    const meta = REPORT_META[key];
    const dateControls = meta.dateBased
      ? dateRangeBarHtml({ presetId: 'reportRangePreset', fromId: 'fromDate', toId: 'toDate', applyId: 'runReportBtn', includeAll: false, preset: currentPreset, from: currentFrom, to: currentTo })
      : '';
    return `<h2>${escapeHtml(meta.label)}</h2>${dateControls}`;
  }

  function draw() {
    content.innerHTML = `
      <div class="view-header"><h1>Reports</h1></div>
      <label class="field report-picker">Report
        <select id="reportPicker">
          ${REPORT_CATEGORIES.map((cat) => `<optgroup label="${escapeHtml(cat.label)}">${cat.reports.map((r) => `<option value="${r.key}" ${r.key === activeReport ? 'selected' : ''}>${escapeHtml(r.label)}</option>`).join('')}</optgroup>`).join('')}
        </select>
      </label>
      <div class="prefs-layout">
        <div class="prefs-nav report-nav">
          ${REPORT_CATEGORIES.map((cat) => `
            <div class="report-nav-category">${escapeHtml(cat.label)}</div>
            ${cat.reports.map((r) => `<button type="button" class="prefs-nav-item ${r.key === activeReport ? 'active' : ''}" data-report="${r.key}">${escapeHtml(r.label)}</button>`).join('')}
          `).join('')}
        </div>
        <div class="prefs-panel card" id="reportPanel">
          ${panelHeaderHtml(activeReport)}
          <div id="reportBody"><div class="empty-state">Loading&hellip;</div></div>
        </div>
      </div>
    `;
    content.querySelectorAll('.prefs-nav-item').forEach((btn) => btn.addEventListener('click', () => {
      activeReport = btn.dataset.report;
      draw();
    }));
    document.getElementById('reportPicker').addEventListener('change', (e) => {
      activeReport = e.target.value;
      draw();
    });
    wirePanel();
    loadActiveReport();
  }

  function wirePanel() {
    if (!REPORT_META[activeReport].dateBased) return;
    const presetSelect = document.getElementById('reportRangePreset');
    const fromInput = document.getElementById('fromDate');
    const toInput = document.getElementById('toDate');
    wireDateRangePreset(presetSelect, fromInput, toInput);
    document.getElementById('runReportBtn').addEventListener('click', () => {
      currentFrom = fromInput.value;
      currentTo = toInput.value;
      currentPreset = presetSelect.value;
      loadActiveReport();
    });
  }

  // Shared by the three "On Order" reports -- the PO list endpoint doesn't
  // include line items, so this fetches full detail (with items) for every
  // open PO in parallel.
  async function openPOsWithItems() {
    const pos = await Api.get('/api/purchase-orders?status=ordered');
    return Promise.all(pos.map((po) => Api.get(`/api/purchase-orders/${po.id}`)));
  }

  async function loadActiveReport() {
    const body = document.getElementById('reportBody');
    const from = currentFrom;
    const to = currentTo;
    switch (activeReport) {
      case 'summary': {
        const summary = await Api.get(`/api/reports/summary?from=${from}&to=${to}`);
        body.innerHTML = `
          <div class="cart-summary-row"><span>Date Range</span><span>${summary.from} to ${summary.to}</span></div>
          <div class="cart-summary-row"><span>Sales</span><span>${summary.sale_count}</span></div>
          <div class="cart-summary-row"><span>Revenue</span><span>${money(summary.revenue)}</span></div>
          <div class="cart-summary-row"><span>Tax collected</span><span>${money(summary.tax_collected)}</span></div>
          <div class="cart-summary-row total"><span>Discounts given</span><span>${money(summary.discounts)}</span></div>
          <h3 style="margin:20px 0 0;">By Payment Method</h3>
          <div id="summaryPaymentTable"></div>
        `;
        renderCustomizableTable(document.getElementById('summaryPaymentTable'), {
          rows: summary.byPayment || [],
          catalog: SUMMARY_PAYMENT_COLUMNS,
          defaultColumns: DEFAULT_SUMMARY_PAYMENT_COLUMNS,
          store: summaryPaymentColumnStore,
          emptyText: 'No sales in this range.',
          idSuffix: 'Summary',
          initialSort: { key: 'total', dir: 'desc' }
        });
        break;
      }
      case 'detail': {
        const rows = await Api.get(`/api/sales?from=${from}&to=${to}`);
        renderCustomizableTable(body, {
          rows,
          catalog: SALES_DETAIL_COLUMNS,
          defaultColumns: DEFAULT_SALES_DETAIL_COLUMNS,
          store: salesDetailColumnStore,
          emptyText: 'No sales in this range.',
          idSuffix: 'Detail',
          initialSort: { key: 'date', dir: 'desc' }
        });
        break;
      }
      case 'topProducts': {
        const rows = await Api.get(`/api/reports/top-products?from=${from}&to=${to}&limit=25`);
        renderCustomizableTable(body, {
          rows,
          catalog: TOP_PRODUCTS_COLUMNS,
          defaultColumns: DEFAULT_TOP_PRODUCTS_COLUMNS,
          store: topProductsColumnStore,
          emptyText: 'No sales in this range.',
          idSuffix: 'TopProducts',
          initialSort: { key: 'qty_sold', dir: 'desc' }
        });
        break;
      }
      case 'byEmployee': {
        const rows = await Api.get(`/api/reports/by-employee?from=${from}&to=${to}`);
        renderCustomizableTable(body, {
          rows,
          catalog: BY_EMPLOYEE_COLUMNS,
          defaultColumns: DEFAULT_BY_EMPLOYEE_COLUMNS,
          store: byEmployeeColumnStore,
          emptyText: 'No sales in this range.',
          idSuffix: 'ByEmployee',
          initialSort: { key: 'revenue', dir: 'desc' }
        });
        break;
      }
      case 'byAssociate': {
        const rows = await Api.get(`/api/reports/by-associate?from=${from}&to=${to}`);
        renderCustomizableTable(body, {
          rows,
          catalog: BY_ASSOCIATE_COLUMNS,
          defaultColumns: DEFAULT_BY_ASSOCIATE_COLUMNS,
          store: byAssociateColumnStore,
          emptyText: 'No associate sales in this range.',
          idSuffix: 'ByAssociate',
          initialSort: { key: 'revenue', dir: 'desc' }
        });
        break;
      }
      case 'lowStock': {
        const rows = await Api.get('/api/reports/low-stock');
        renderSortableTable(body, {
          rows,
          columns: [
            { key: 'name', label: 'Item', render: (p) => escapeHtml(p.name), sortValue: (p) => p.name || '' },
            { key: 'qty_on_hand', label: 'On Hand', render: (p) => fmtQty(p.qty_on_hand), sortValue: (p) => Number(p.qty_on_hand) || 0 },
            { key: 'reorder_level', label: 'Reorder Level', render: (p) => fmtQty(p.reorder_level), sortValue: (p) => Number(p.reorder_level) || 0 }
          ],
          emptyText: 'Nothing low on stock.',
          initialSort: { key: 'qty_on_hand', dir: 'asc' },
          resizeKey: 'lowStock'
        });
        break;
      }

      // ---------- Purchasing ----------
      case 'onOrderSummary': {
        const pos = await openPOsWithItems();
        const rows = pos.map((po) => ({
          po_number: po.po_number,
          vendor_name: po.vendor_name,
          created_at: po.created_at,
          item_count: po.items.length,
          qty: po.items.reduce((s, i) => s + (Number(i.qty_ordered) || 0), 0),
          cost: po.items.reduce((s, i) => s + (Number(i.qty_ordered) || 0) * (Number(i.cost) || 0), 0)
        }));
        renderSortableTable(body, {
          rows,
          columns: [
            { key: 'po_number', label: 'PO #', render: (r) => escapeHtml(r.po_number), sortValue: (r) => r.po_number || '' },
            { key: 'vendor_name', label: 'Vendor', render: (r) => escapeHtml(r.vendor_name || '—'), sortValue: (r) => r.vendor_name || '' },
            { key: 'created_at', label: 'Date', render: (r) => new Date(r.created_at).toLocaleDateString(), sortValue: (r) => new Date(r.created_at).getTime() },
            { key: 'item_count', label: 'Line Items', render: (r) => String(r.item_count), sortValue: (r) => r.item_count },
            { key: 'qty', label: 'Qty Ordered', render: (r) => fmtQty(r.qty), sortValue: (r) => r.qty },
            { key: 'cost', label: 'Total Cost', render: (r) => money(r.cost), sortValue: (r) => r.cost }
          ],
          emptyText: 'No open purchase orders.',
          initialSort: { key: 'created_at', dir: 'desc' },
          resizeKey: 'onOrderSummary'
        });
        break;
      }
      case 'onOrderDetail': {
        const pos = await openPOsWithItems();
        const rows = [];
        pos.forEach((po) => po.items.forEach((it) => rows.push({ po, it })));
        renderSortableTable(body, {
          rows,
          columns: [
            { key: 'po_number', label: 'PO #', render: ({ po }) => escapeHtml(po.po_number), sortValue: ({ po }) => po.po_number || '' },
            { key: 'vendor_name', label: 'Vendor', render: ({ po }) => escapeHtml(po.vendor_name || '—'), sortValue: ({ po }) => po.vendor_name || '' },
            { key: 'name', label: 'Item', render: ({ it }) => escapeHtml(it.name), sortValue: ({ it }) => it.name || '' },
            { key: 'qty_ordered', label: 'Qty Ordered', render: ({ it }) => fmtQty(it.qty_ordered), sortValue: ({ it }) => Number(it.qty_ordered) || 0 },
            { key: 'cost', label: 'Cost', render: ({ it }) => money(it.cost), sortValue: ({ it }) => Number(it.cost) || 0 },
            { key: 'ext_cost', label: 'Ext Cost', render: ({ it }) => money((Number(it.qty_ordered) || 0) * (Number(it.cost) || 0)), sortValue: ({ it }) => (Number(it.qty_ordered) || 0) * (Number(it.cost) || 0) }
          ],
          emptyText: 'No open purchase orders.',
          initialSort: null,
          resizeKey: 'onOrderDetail'
        });
        break;
      }
      case 'onOrderCash': {
        const pos = await openPOsWithItems();
        const byVendor = new Map();
        pos.forEach((po) => {
          const amt = po.items.reduce((s, i) => s + (Number(i.qty_ordered) || 0) * (Number(i.cost) || 0), 0);
          const key = po.vendor_name || 'No vendor';
          byVendor.set(key, (byVendor.get(key) || 0) + amt);
        });
        const rows = [...byVendor.entries()].map(([vendor_name, amount]) => ({ vendor_name, amount }));
        const total = rows.reduce((s, r) => s + r.amount, 0);
        renderSortableTable(body, {
          rows,
          columns: [
            { key: 'vendor_name', label: 'Vendor', render: (r) => escapeHtml(r.vendor_name), sortValue: (r) => r.vendor_name || '' },
            { key: 'amount', label: 'Amount Due', render: (r) => money(r.amount), sortValue: (r) => r.amount }
          ],
          emptyText: 'No open purchase orders.',
          initialSort: { key: 'amount', dir: 'desc' },
          note: 'Total cost of everything still on order, by vendor -- what would be owed if every open purchase order were received today.',
          footerHtml: (sorted) => (sorted.length ? `<tfoot><tr><td>Total</td><td>${money(total)}</td></tr></tfoot>` : ''),
          resizeKey: 'onOrderCash'
        });
        break;
      }
      case 'receivingSummary': {
        const receipts = await Api.get(`/api/receiving?from=${from}&to=${to}`);
        const byItem = new Map();
        receipts.forEach((r) => {
          const key = r.product_name || 'Unknown';
          const cur = byItem.get(key) || { name: key, qty: 0, cost: 0 };
          cur.qty += Number(r.qty) || 0;
          cur.cost += (Number(r.qty) || 0) * (Number(r.cost) || 0);
          byItem.set(key, cur);
        });
        renderSortableTable(body, {
          rows: [...byItem.values()],
          columns: [
            { key: 'name', label: 'Item', render: (r) => escapeHtml(r.name), sortValue: (r) => r.name || '' },
            { key: 'qty', label: 'Qty Received', render: (r) => fmtQty(r.qty), sortValue: (r) => r.qty },
            { key: 'cost', label: 'Total Cost', render: (r) => money(r.cost), sortValue: (r) => r.cost }
          ],
          emptyText: 'Nothing received in this range.',
          initialSort: { key: 'cost', dir: 'desc' },
          resizeKey: 'receivingSummary'
        });
        break;
      }
      case 'receivingDetail': {
        const rows = await Api.get(`/api/receiving?from=${from}&to=${to}`);
        renderSortableTable(body, {
          rows,
          columns: [
            { key: 'created_at', label: 'Date', render: (r) => new Date(r.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), sortValue: (r) => new Date(r.created_at).getTime() },
            { key: 'product_name', label: 'Item', render: (r) => escapeHtml(r.product_name || '—'), sortValue: (r) => r.product_name || '' },
            { key: 'qty', label: 'Qty', render: (r) => fmtQty(r.qty), sortValue: (r) => Number(r.qty) || 0 },
            { key: 'cost', label: 'Cost', render: (r) => (r.cost != null ? money(r.cost) : '—'), sortValue: (r) => Number(r.cost) || 0 },
            { key: 'po_number', label: 'PO #', render: (r) => escapeHtml(r.po_number || '—'), sortValue: (r) => r.po_number || '' },
            { key: 'received_by', label: 'Received By', render: (r) => escapeHtml(r.received_by || '—'), sortValue: (r) => r.received_by || '' }
          ],
          emptyText: 'No stock was received in this range.',
          initialSort: { key: 'created_at', dir: 'desc' },
          resizeKey: 'receivingDetail'
        });
        break;
      }
      case 'vendorList': {
        const rows = await Api.get('/api/vendors');
        renderSortableTable(body, {
          rows,
          columns: [
            { key: 'name', label: 'Vendor', render: (v) => escapeHtml(v.name), sortValue: (v) => v.name || '' },
            { key: 'contact_name', label: 'Contact', render: (v) => escapeHtml(v.contact_name || '—'), sortValue: (v) => v.contact_name || '' },
            { key: 'email', label: 'Email', render: (v) => escapeHtml(v.email || '—'), sortValue: (v) => v.email || '' },
            { key: 'phone', label: 'Phone', render: (v) => escapeHtml(v.phone || '—'), sortValue: (v) => v.phone || '' }
          ],
          emptyText: 'No vendors yet.',
          initialSort: { key: 'name', dir: 'asc' },
          resizeKey: 'vendorList'
        });
        break;
      }

      // ---------- Items ----------
      case 'invSummary': {
        const rows = await Api.get('/api/products');
        const totalQty = rows.reduce((s, p) => s + (Number(p.qty_on_hand) || 0), 0);
        renderSortableTable(body, {
          rows,
          columns: [
            { key: 'name', label: 'Item', render: (p) => escapeHtml(p.name), sortValue: (p) => p.name || '' },
            { key: 'category_name', label: 'Department', render: (p) => escapeHtml(p.category_name || '—'), sortValue: (p) => p.category_name || '' },
            { key: 'qty_on_hand', label: 'Qty On Hand', render: (p) => fmtQty(p.qty_on_hand), sortValue: (p) => Number(p.qty_on_hand) || 0 },
            { key: 'cost', label: 'Cost', render: (p) => money(p.cost), sortValue: (p) => Number(p.cost) || 0 },
            { key: 'price', label: 'Price', render: (p) => money(p.price), sortValue: (p) => Number(p.price) || 0 }
          ],
          emptyText: 'No items yet.',
          initialSort: { key: 'name', dir: 'asc' },
          footerHtml: (sorted) => (sorted.length ? `<tfoot><tr><td colspan="2" class="text-right">Total</td><td>${fmtQty(totalQty)}</td><td colspan="2"></td></tr></tfoot>` : ''),
          resizeKey: 'invSummary'
        });
        break;
      }
      case 'invSummaryActivity': {
        const [products, sold] = await Promise.all([
          Api.get('/api/products'),
          Api.get(`/api/reports/top-products?from=${from}&to=${to}&limit=1000`)
        ]);
        const soldMap = new Map(sold.map((s) => [s.name, s]));
        const rows = products.map((p) => {
          const s = soldMap.get(p.name);
          return { name: p.name, qty_on_hand: p.qty_on_hand, qty_sold: s ? s.qty_sold : 0, revenue: s ? s.revenue : 0 };
        });
        renderSortableTable(body, {
          rows,
          columns: [
            { key: 'name', label: 'Item', render: (r) => escapeHtml(r.name), sortValue: (r) => r.name || '' },
            { key: 'qty_on_hand', label: 'Qty On Hand', render: (r) => fmtQty(r.qty_on_hand), sortValue: (r) => Number(r.qty_on_hand) || 0 },
            { key: 'qty_sold', label: 'Qty Sold (range)', render: (r) => String(fmtQty(r.qty_sold)), sortValue: (r) => Number(r.qty_sold) || 0 },
            { key: 'revenue', label: 'Revenue (range)', render: (r) => money(r.revenue), sortValue: (r) => Number(r.revenue) || 0 }
          ],
          emptyText: 'No items yet.',
          initialSort: { key: 'name', dir: 'asc' },
          resizeKey: 'invSummaryActivity'
        });
        break;
      }
      case 'invItemList': {
        const rows = await Api.get('/api/products');
        renderSortableTable(body, {
          rows,
          columns: [
            { key: 'item_number', label: 'Item #', render: (p) => escapeHtml(p.item_number || '—'), sortValue: (p) => p.item_number || '' },
            { key: 'sku', label: 'SKU', render: (p) => escapeHtml(p.sku || '—'), sortValue: (p) => p.sku || '' },
            { key: 'name', label: 'Item Name', render: (p) => escapeHtml(p.name), sortValue: (p) => p.name || '' },
            { key: 'category_name', label: 'Department', render: (p) => escapeHtml(p.category_name || '—'), sortValue: (p) => p.category_name || '' },
            { key: 'price', label: 'Price', render: (p) => money(p.price), sortValue: (p) => Number(p.price) || 0 },
            { key: 'qty_on_hand', label: 'Qty On Hand', render: (p) => fmtQty(p.qty_on_hand), sortValue: (p) => Number(p.qty_on_hand) || 0 }
          ],
          emptyText: 'No items yet.',
          initialSort: { key: 'name', dir: 'asc' },
          resizeKey: 'invItemList'
        });
        break;
      }
      case 'invValuation': {
        const rows = await Api.get('/api/products');
        const total = rows.reduce((s, p) => s + (Number(p.qty_on_hand) || 0) * (Number(p.cost) || 0), 0);
        renderSortableTable(body, {
          rows,
          columns: [
            { key: 'name', label: 'Item', render: (p) => escapeHtml(p.name), sortValue: (p) => p.name || '' },
            { key: 'qty_on_hand', label: 'Qty On Hand', render: (p) => fmtQty(p.qty_on_hand), sortValue: (p) => Number(p.qty_on_hand) || 0 },
            { key: 'cost', label: 'Avg Cost', render: (p) => money(p.cost), sortValue: (p) => Number(p.cost) || 0 },
            { key: 'value', label: 'Total Value', render: (p) => money((Number(p.qty_on_hand) || 0) * (Number(p.cost) || 0)), sortValue: (p) => (Number(p.qty_on_hand) || 0) * (Number(p.cost) || 0) }
          ],
          emptyText: 'No items yet.',
          initialSort: { key: 'value', dir: 'desc' },
          footerHtml: (sorted) => (sorted.length ? `<tfoot><tr><td colspan="3" class="text-right">Total Inventory Value</td><td>${money(total)}</td></tr></tfoot>` : ''),
          resizeKey: 'invValuation'
        });
        break;
      }
      case 'invTurn': {
        const [products, sold] = await Promise.all([
          Api.get('/api/products'),
          Api.get(`/api/reports/top-products?from=${from}&to=${to}&limit=1000`)
        ]);
        const soldMap = new Map(sold.map((s) => [s.name, Number(s.qty_sold) || 0]));
        const rows = products.map((p) => {
          const soldQty = soldMap.get(p.name) || 0;
          const onHand = Number(p.qty_on_hand) || 0;
          const turn = onHand > 0 ? soldQty / onHand : (soldQty > 0 ? Infinity : 0);
          return { name: p.name, soldQty, onHand, turn };
        });
        renderSortableTable(body, {
          rows,
          columns: [
            { key: 'name', label: 'Item', render: (r) => escapeHtml(r.name), sortValue: (r) => r.name || '' },
            { key: 'soldQty', label: 'Qty Sold (range)', render: (r) => String(r.soldQty), sortValue: (r) => r.soldQty },
            { key: 'onHand', label: 'Qty On Hand', render: (r) => fmtQty(r.onHand), sortValue: (r) => r.onHand },
            { key: 'turn', label: 'Turn', render: (r) => (r.turn === Infinity ? '&infin;' : r.turn.toFixed(2)), sortValue: (r) => r.turn }
          ],
          emptyText: 'No items yet.',
          initialSort: { key: 'turn', dir: 'desc' },
          note: 'Approximate turn = quantity sold in the selected range &divide; current quantity on hand. Saffron doesn\'t track historical average inventory yet, so this uses today\'s on-hand as the denominator rather than a period average.',
          resizeKey: 'invTurn'
        });
        break;
      }
      case 'invSummaryGraph': {
        // A bar chart, not a table -- no column headers to attach a sort
        // control to. Kept sorted by quantity on hand (its only real axis).
        const rows = (await Api.get('/api/products')).slice().sort((a, b) => (Number(b.qty_on_hand) || 0) - (Number(a.qty_on_hand) || 0)).slice(0, 20);
        const max = Math.max(1, ...rows.map((p) => Number(p.qty_on_hand) || 0));
        body.innerHTML = `
          <p class="note">Top 20 items by quantity on hand.</p>
          <div class="report-bar-chart">
            ${rows.map((p) => `
              <div class="report-bar-row">
                <span class="report-bar-label" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>
                <div class="report-bar-track"><div class="report-bar-fill" style="width:${Math.max(2, (Number(p.qty_on_hand) || 0) / max * 100)}%;"></div></div>
                <span class="report-bar-value">${fmtQty(p.qty_on_hand)}</span>
              </div>
            `).join('') || '<div class="empty-state">No items yet.</div>'}
          </div>
        `;
        break;
      }
      case 'adjQtySummary': {
        const history = await Api.get(`/api/physical-inventory/history?from=${from}&to=${to}`);
        const byItem = new Map();
        history.forEach((r) => byItem.set(r.name, (byItem.get(r.name) || 0) + (Number(r.difference_qty) || 0)));
        const rows = [...byItem.entries()].map(([name, qty]) => ({ name, qty }));
        renderSortableTable(body, {
          rows,
          columns: [
            { key: 'name', label: 'Item', render: (r) => escapeHtml(r.name), sortValue: (r) => r.name || '' },
            { key: 'qty', label: 'Net Qty Adjustment', render: (r) => `<span style="color:${r.qty > 0 ? 'var(--green)' : r.qty < 0 ? 'var(--red)' : 'inherit'};">${r.qty > 0 ? '+' : ''}${fmtQty(r.qty)}</span>`, sortValue: (r) => r.qty }
          ],
          emptyText: 'No adjustments in this range.',
          initialSort: null,
          resizeKey: 'adjQtySummary'
        });
        break;
      }
      case 'adjQtyDetail': {
        const rows = await Api.get(`/api/physical-inventory/history?from=${from}&to=${to}`);
        renderSortableTable(body, {
          rows,
          columns: [
            { key: 'created_at', label: 'Date', render: (r) => new Date(r.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), sortValue: (r) => new Date(r.created_at).getTime() },
            { key: 'name', label: 'Item', render: (r) => escapeHtml(r.name), sortValue: (r) => r.name || '' },
            { key: 'expected_qty', label: 'Expected', render: (r) => String(r.expected_qty), sortValue: (r) => Number(r.expected_qty) || 0 },
            { key: 'counted_qty', label: 'Counted', render: (r) => String(r.counted_qty), sortValue: (r) => Number(r.counted_qty) || 0 },
            { key: 'difference_qty', label: 'Difference', render: (r) => `<span style="color:${Number(r.difference_qty) > 0 ? 'var(--green)' : 'var(--red)'};">${Number(r.difference_qty) > 0 ? '+' : ''}${r.difference_qty}</span>`, sortValue: (r) => Number(r.difference_qty) || 0 },
            { key: 'counted_by', label: 'Counted By', render: (r) => escapeHtml(r.counted_by || '—'), sortValue: (r) => r.counted_by || '' }
          ],
          emptyText: 'No adjustments in this range.',
          initialSort: { key: 'created_at', dir: 'desc' },
          resizeKey: 'adjQtyDetail'
        });
        break;
      }
      case 'adjCostSummary': {
        const history = await Api.get(`/api/physical-inventory/history?from=${from}&to=${to}`);
        const byItem = new Map();
        history.forEach((r) => {
          const impact = (Number(r.difference_qty) || 0) * (Number(r.cost) || 0);
          byItem.set(r.name, (byItem.get(r.name) || 0) + impact);
        });
        const rows = [...byItem.entries()].map(([name, amount]) => ({ name, amount }));
        const total = rows.reduce((s, r) => s + r.amount, 0);
        renderSortableTable(body, {
          rows,
          columns: [
            { key: 'name', label: 'Item', render: (r) => escapeHtml(r.name), sortValue: (r) => r.name || '' },
            { key: 'amount', label: 'Cost Impact', render: (r) => `<span style="color:${r.amount > 0 ? 'var(--green)' : r.amount < 0 ? 'var(--red)' : 'inherit'};">${money(r.amount)}</span>`, sortValue: (r) => r.amount }
          ],
          emptyText: 'No adjustments in this range.',
          initialSort: { key: 'amount', dir: 'desc' },
          footerHtml: (sorted) => (sorted.length ? `<tfoot><tr><td>Total</td><td>${money(total)}</td></tr></tfoot>` : ''),
          resizeKey: 'adjCostSummary'
        });
        break;
      }
      case 'adjCostDetail': {
        const history = await Api.get(`/api/physical-inventory/history?from=${from}&to=${to}`);
        const rows = history.map((r) => ({ ...r, impact: (Number(r.difference_qty) || 0) * (Number(r.cost) || 0) }));
        renderSortableTable(body, {
          rows,
          columns: [
            { key: 'created_at', label: 'Date', render: (r) => new Date(r.created_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), sortValue: (r) => new Date(r.created_at).getTime() },
            { key: 'name', label: 'Item', render: (r) => escapeHtml(r.name), sortValue: (r) => r.name || '' },
            { key: 'difference_qty', label: 'Difference Qty', render: (r) => `${Number(r.difference_qty) > 0 ? '+' : ''}${r.difference_qty}`, sortValue: (r) => Number(r.difference_qty) || 0 },
            { key: 'cost', label: 'Cost Each', render: (r) => money(r.cost), sortValue: (r) => Number(r.cost) || 0 },
            { key: 'impact', label: 'Cost Impact', render: (r) => `<span style="color:${r.impact > 0 ? 'var(--green)' : r.impact < 0 ? 'var(--red)' : 'inherit'};">${money(r.impact)}</span>`, sortValue: (r) => r.impact },
            { key: 'counted_by', label: 'Counted By', render: (r) => escapeHtml(r.counted_by || '—'), sortValue: (r) => r.counted_by || '' }
          ],
          emptyText: 'No adjustments in this range.',
          initialSort: { key: 'created_at', dir: 'desc' },
          resizeKey: 'adjCostDetail'
        });
        break;
      }
      case 'departmentList': {
        const rows = await Api.get('/api/products/categories');
        renderSortableTable(body, {
          rows,
          columns: [
            { key: 'name', label: 'Department', render: (c) => escapeHtml(c.name), sortValue: (c) => c.name || '' }
          ],
          emptyText: 'No departments yet.',
          initialSort: { key: 'name', dir: 'asc' },
          resizeKey: 'departmentList'
        });
        break;
      }
    }
  }

  draw();
}

// =====================================================================
// END OF DAY (cash drawer reconciliation)
// =====================================================================
function overShortBadge(overShort) {
  const n = Number(overShort) || 0;
  if (Math.abs(n) < 0.005) return `<span class="badge badge-ok">Balanced</span>`;
  if (n > 0) return `<span class="badge badge-ok">Over ${money(n)}</span>`;
  return `<span class="badge badge-low">Short ${money(Math.abs(n))}</span>`;
}

async function renderEndOfDay() {
  const today = new Date().toISOString().slice(0, 10);
  content.innerHTML = `
    <div class="view-header">
      <h1>End of Day</h1>
      <div class="view-actions">
        <input type="date" id="eodDate" value="${today}" max="${today}" />
      </div>
    </div>
    <div id="eodBody"></div>
    <div class="card table-wrap">
      <h2>Recent Close-Outs</h2>
      <table>
        <thead><tr><th>Date</th><th>Closed By</th><th>Expected Cash</th><th>Counted Cash</th><th>Over/Short</th></tr></thead>
        <tbody id="eodHistoryBody"><tr><td colspan="5" class="empty-state">Loading&hellip;</td></tr></tbody>
      </table>
    </div>
  `;
  attachZoomContextMenu(content.querySelector('.table-wrap'), 'endOfDay');

  async function loadHistory() {
    const rows = await Api.get('/api/eod/history?limit=30');
    document.getElementById('eodHistoryBody').innerHTML = rows.map((r) => `
      <tr>
        <td>${r.business_date}</td>
        <td>${escapeHtml(r.closed_by || '—')}</td>
        <td>${money(r.expected_cash)}</td>
        <td>${money(r.counted_cash)}</td>
        <td>${overShortBadge(r.over_short)}</td>
      </tr>
    `).join('') || '<tr><td colspan="5" class="empty-state">No close-outs recorded yet.</td></tr>';
  }

  async function loadDay(date) {
    const data = await Api.get(`/api/eod?date=${date}`);
    const { expected, closeout } = data;
    const eodBody = document.getElementById('eodBody');
    eodBody.innerHTML = `
      <div class="card">
        <h2>Expected From Register</h2>
        <div class="cart-summary-row"><span>Cash sales</span><span>${money(expected.cash)}</span></div>
        <div class="cart-summary-row"><span>Card sales</span><span>${money(expected.card)}</span></div>
        ${expected.other ? `<div class="cart-summary-row"><span>Other</span><span>${money(expected.other)}</span></div>` : ''}
        <div class="cart-summary-row"><span>Total sales</span><span>${money(expected.total)}</span></div>
        <div class="cart-summary-row"><span>Transactions</span><span>${expected.sale_count}</span></div>
      </div>
      <div class="card">
        <h2>Count the Drawer</h2>
        ${closeout ? `<p class="note">Already closed by <strong>${escapeHtml(closeout.closed_by || 'someone')}</strong> on ${new Date(closeout.updated_at || closeout.created_at).toLocaleString()}. Saving again will update this record.</p>` : ''}
        <form id="eodForm" class="form-grid">
          <label>Counted Cash<input type="number" name="counted_cash" min="0" step="0.01" required value="${closeout ? closeout.counted_cash : ''}" /></label>
          <label>Over / Short<input type="text" id="eodOverShortPreview" disabled value="${closeout ? money(closeout.over_short) : money(-expected.cash)}" /></label>
          <label class="span-all">Notes<textarea name="notes" rows="2">${escapeHtml(closeout?.notes || '')}</textarea></label>
          <div class="modal-actions span-all start">
            <button type="submit" class="btn btn-primary">${closeout ? 'Update Close-Out' : 'Close Day'}</button>
          </div>
        </form>
      </div>
    `;

    const countedInput = eodBody.querySelector('input[name="counted_cash"]');
    const previewInput = document.getElementById('eodOverShortPreview');
    countedInput.addEventListener('input', () => {
      const n = Number(countedInput.value) || 0;
      previewInput.value = money(n - expected.cash);
    });

    eodBody.querySelector('#eodForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(e.target).entries());
      try {
        await Api.post('/api/eod', { business_date: date, counted_cash: body.counted_cash, notes: body.notes });
        toast('End of day recorded.', 'success');
        loadDay(date);
        loadHistory();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  document.getElementById('eodDate').addEventListener('change', (e) => loadDay(e.target.value));
  loadDay(today);
  loadHistory();
}

// =====================================================================
// EMPLOYEES
// =====================================================================
async function renderEmployees() {
  const users = await Api.get('/api/users');
  let activeColumns = employeeColumnStore.load();

  content.innerHTML = `
    <div class="view-header">
      <h1>Employees</h1>
      <div class="view-actions">
        <button class="btn" id="empCustomizeColumnsBtn">${icon('columns', 14)} <span><span class="hide-phone">Customize&nbsp;</span>Columns</span></button>
        <button class="btn btn-primary" id="addUserBtn">+ Add Employee</button>
      </div>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr id="empHeadRow"></tr></thead>
        <tbody id="empBody"></tbody>
      </table>
    </div>
  `;
  attachZoomContextMenu(content.querySelector('.table-wrap'), 'employees');

  function drawHead() {
    document.getElementById('empHeadRow').innerHTML =
      activeColumns.map((key) => {
        const c = EMPLOYEE_COLUMNS.find((x) => x.key === key);
        return `<th>${escapeHtml(c ? c.label : key)}</th>`;
      }).join('') + '<th></th>';
  }

  function draw() {
    const colSpan = activeColumns.length + 1;
    document.getElementById('empBody').innerHTML = users.map((u) => `
      <tr>
        ${activeColumns.map((key) => {
          const c = EMPLOYEE_COLUMNS.find((x) => x.key === key);
          return `<td>${c ? c.render(u) : '—'}</td>`;
        }).join('')}
        <td>
          <button class="btn btn-sm edit-btn" data-id="${u.id}">Edit</button>
          ${u.id === CURRENT_USER?.id ? '' : `<button class="btn btn-sm btn-danger del-user-btn" data-id="${u.id}" data-name="${escapeHtml(u.full_name)}">Remove</button>`}
        </td>
      </tr>
    `).join('') || `<tr><td colspan="${colSpan}" class="empty-state">No employees yet.</td></tr>`;

    document.querySelectorAll('.edit-btn').forEach((b) => b.addEventListener('click', () => openUserModal(users.find((u) => u.id === Number(b.dataset.id)))));
    document.querySelectorAll('.del-user-btn').forEach((b) => b.addEventListener('click', async () => {
      if (!confirmGuarded('delete', `Remove ${b.dataset.name}? They'll no longer be able to log in, but their sales history is kept.`)) return;
      try {
        await Api.del(`/api/users/${b.dataset.id}`);
        navigate('employees');
      } catch (err) { toast(err.message, 'error'); }
    }));
  }

  document.getElementById('addUserBtn').addEventListener('click', () => openUserModal(null));
  document.getElementById('empCustomizeColumnsBtn').addEventListener('click', () => {
    openColumnCustomizerModal(EMPLOYEE_COLUMNS, DEFAULT_EMPLOYEE_COLUMNS, activeColumns, (newColumns) => {
      activeColumns = newColumns;
      employeeColumnStore.save(newColumns);
      drawHead();
      draw();
      toast('Columns updated.', 'success');
    });
  });

  drawHead();
  draw();
}

function openUserModal(user) {
  const isEdit = !!user;
  const overlay = openModal(`
    <h2>${isEdit ? 'Edit Employee' : 'Add Employee'}</h2>
    <form id="userForm" class="form-grid">
      <label>Full Name<input name="full_name" required value="${escapeHtml(user?.full_name || '')}" /></label>
      <label>Username<input name="username" required ${isEdit ? 'disabled' : ''} value="${escapeHtml(user?.username || '')}" /></label>
      <label>Password ${isEdit ? '(leave blank to keep)' : ''}<input name="password" type="password" ${isEdit ? '' : 'required'} /></label>
      <label>Role
        <select name="role">
          <option value="cashier" ${user?.role === 'cashier' ? 'selected' : ''}>Cashier</option>
          <option value="salesman" ${user?.role === 'salesman' ? 'selected' : ''}>Salesman</option>
          <option value="manager" ${user?.role === 'manager' ? 'selected' : ''}>Manager</option>
          <option value="admin" ${user?.role === 'admin' ? 'selected' : ''}>Admin</option>
        </select>
      </label>
      ${isEdit ? `<label>Status
        <select name="active">
          <option value="1" ${user?.active ? 'selected' : ''}>Active</option>
          <option value="0" ${!user?.active ? 'selected' : ''}>Disabled</option>
        </select>
      </label>` : ''}
      <div class="modal-actions span-all">
        <button type="button" class="btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Add Employee'}</button>
      </div>
    </form>
  `);
  overlay.querySelector('#cancelBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    if (!body.password) delete body.password;
    if (isEdit && !confirmGuarded('edit', 'Save changes to this employee?')) return;
    try {
      if (isEdit) await Api.put(`/api/users/${user.id}`, body);
      else await Api.post('/api/users', body);
      overlay.remove();
      navigate('employees');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// =====================================================================
// COMPANY PREFERENCES (QuickBooks-style category tree + panel)
// =====================================================================
const PREF_CATEGORIES = [
  { key: 'general', label: 'General' },
  { key: 'sales', label: 'Sales' },
  { key: 'purchasing', label: 'Purchasing & Receiving' },
  { key: 'customers', label: 'Customers & Rewards' },
  { key: 'multistore', label: 'Multi-Store' },
  { key: 'safeguard', label: 'Data Safeguard' }
];

async function renderSettings() {
  const settings = await Api.get('/api/settings');
  COMPANY_SETTINGS = settings; // refresh the app-wide cache every time this screen is viewed
  let activeCat = 'general';

  const boolVal = (key, def) => (settings[key] != null ? settings[key] === '1' : def);

  function panelHtml(cat) {
    if (cat === 'general') {
      return `
        <h2>General</h2>
        <form id="generalPrefsForm">
          <div class="pref-section">
            <div class="pref-section-label">Store Info</div>
            <label class="pref-field">Store Name<input name="store_name" value="${escapeHtml(settings.store_name || '')}" /></label>
          </div>
          <div class="pref-section">
            <div class="pref-section-label">Options</div>
            <label class="pref-check-row pref-disabled"><input type="checkbox" checked disabled /><span>Require users to log in <span class="pref-hint">(always on)</span></span></label>
            <label class="pref-check-row"><input type="checkbox" name="auto_logout_after_sale" ${boolVal('auto_logout_after_sale', false) ? 'checked' : ''} /><span>Automatically log out user after each sale</span></label>
            <label class="pref-check-row"><input type="checkbox" name="warn_on_edit" ${boolVal('warn_on_edit', true) ? 'checked' : ''} /><span>Warn when editing items, customers, or employees</span></label>
            <label class="pref-check-row"><input type="checkbox" name="warn_on_delete" ${boolVal('warn_on_delete', true) ? 'checked' : ''} /><span>Warn when deleting items, customers, or employees</span></label>
            <label class="pref-check-row pref-disabled"><input type="checkbox" disabled /><span>Bring back all one-time messages <span class="pref-hint">(no dismissible messages in this version)</span></span></label>
          </div>
          <div class="pref-section">
            <div class="pref-section-label">Company</div>
            <p class="pref-note">
              Your company code is <strong>${escapeHtml(CURRENT_USER.company?.code || '')}</strong> --
              every employee needs this exact code (along with their own username and password) to sign in.
              This one database can host many companies; each only ever sees its own data.
            </p>
          </div>
          <div class="modal-actions start">
            <button type="submit" class="btn btn-primary">Save</button>
          </div>
        </form>
      `;
    }
    if (cat === 'sales') {
      return `
        <h2>Sales</h2>
        <form id="salesPrefsForm">
          <div class="pref-section">
            <div class="pref-section-label">Sales Tax</div>
            <label class="pref-field">Tax Rate (e.g. 0.0825 for 8.25%)<input name="tax_rate" type="number" step="0.0001" value="${escapeHtml(settings.tax_rate || '0')}" /></label>
          </div>
          <div class="pref-section">
            <div class="pref-section-label">Discounts</div>
            <label class="pref-check-row"><input type="checkbox" name="enable_discounts" ${boolVal('enable_discounts', false) ? 'checked' : ''} /><span>Enable discounts at checkout</span></label>
          </div>
          <div class="pref-section">
            <div class="pref-section-label">Receipt Message</div>
            <label class="pref-field">Shown at the bottom of every printed receipt<input name="receipt_message" value="${escapeHtml(settings.receipt_message || '')}" placeholder="e.g. Thank you for shopping with us!" /></label>
          </div>
          <div class="modal-actions start">
            <button type="submit" class="btn btn-primary">Save</button>
          </div>
        </form>
      `;
    }
    if (cat === 'purchasing') {
      return `
        <h2>Purchasing & Receiving</h2>
        <label class="pref-check-row pref-disabled"><input type="checkbox" checked disabled /><span>I create Purchase Orders when buying or receiving merchandise <span class="pref-hint">(always available)</span></span></label>
        <p class="pref-note">Purchase Orders and Receiving Vouchers are built into Saffron POS -- there's nothing to turn on.</p>
      `;
    }
    if (cat === 'customers') {
      return `
        <h2>Customers & Rewards</h2>
        <label class="pref-check-row pref-disabled"><input type="checkbox" checked disabled /><span>I want to track customers <span class="pref-hint">(always on)</span></span></label>
        <form id="custPrefsForm">
          <div class="pref-section">
            <div class="pref-section-label">Reward Manager</div>
            <label class="pref-field">Loyalty points earned per &#8369;1 spent<input name="loyalty_points_rate" type="number" step="0.01" min="0" value="${escapeHtml(settings.loyalty_points_rate || '1')}" /></label>
          </div>
          <div class="modal-actions start">
            <button type="submit" class="btn btn-primary">Save</button>
          </div>
        </form>
      `;
    }
    if (cat === 'multistore') {
      return `
        <h2>Multi-Store</h2>
        <p class="pref-note">Saffron POS currently supports a single store per company. Multi-store support (store codes, store exchanges, store headings) isn't available in this version.</p>
      `;
    }
    // safeguard
    return `
      <h2>Data Safeguard</h2>
      <p class="pref-note">Backups are handled automatically by your database host (e.g. Supabase's built-in daily backups) rather than by Saffron POS directly, so there's nothing to configure here.</p>
    `;
  }

  function wirePanel(cat) {
    if (cat === 'general') {
      document.getElementById('generalPrefsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = {
          store_name: fd.get('store_name') || '',
          auto_logout_after_sale: fd.get('auto_logout_after_sale') ? '1' : '0',
          warn_on_edit: fd.get('warn_on_edit') ? '1' : '0',
          warn_on_delete: fd.get('warn_on_delete') ? '1' : '0'
        };
        await Api.put('/api/settings', body);
        toast('Preferences saved.', 'success');
        navigate('settings');
      });
    } else if (cat === 'sales') {
      document.getElementById('salesPrefsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = {
          tax_rate: fd.get('tax_rate') || '0',
          enable_discounts: fd.get('enable_discounts') ? '1' : '0',
          receipt_message: fd.get('receipt_message') || ''
        };
        await Api.put('/api/settings', body);
        toast('Preferences saved.', 'success');
        navigate('settings');
      });
    } else if (cat === 'customers') {
      document.getElementById('custPrefsForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = { loyalty_points_rate: fd.get('loyalty_points_rate') || '1' };
        await Api.put('/api/settings', body);
        toast('Preferences saved.', 'success');
        navigate('settings');
      });
    }
    // purchasing / multistore / safeguard are static -- nothing to wire
  }

  function draw() {
    content.innerHTML = `
      <div class="view-header"><h1>Company Preferences</h1></div>
      <div class="prefs-layout">
        <div class="prefs-nav">
          ${PREF_CATEGORIES.map((c) => `<button type="button" class="prefs-nav-item ${c.key === activeCat ? 'active' : ''}" data-cat="${c.key}">${escapeHtml(c.label)}</button>`).join('')}
        </div>
        <div class="prefs-panel card" id="prefsPanel">${panelHtml(activeCat)}</div>
      </div>
    `;
    content.querySelectorAll('.prefs-nav-item').forEach((btn) => btn.addEventListener('click', () => {
      activeCat = btn.dataset.cat;
      draw();
    }));
    wirePanel(activeCat);
  }

  draw();
}

// =====================================================================
// TOOLS
// =====================================================================
async function renderTools() {
  content.innerHTML = `
    <div class="view-header"><h1>Tools</h1></div>
    <div class="card card-narrow card-link" id="printDesignerCard">
      <h2>${icon('printer', 18)} Print Designer</h2>
      <p class="note" style="margin:0;">Pick a document type, drag sections to reorder, toggle them on/off, and edit their text.</p>
    </div>
  `;
  document.getElementById('printDesignerCard').addEventListener('click', () => navigate('printDesigner'));
}

// =====================================================================
// PRINT DESIGNER -- one editor shared by every document type in
// PRINT_DOC_TYPES. Sections drag-to-reorder (native HTML5 drag & drop),
// toggle on/off, and the title/footer text are editable; nothing is saved
// until "Save Template" is clicked.
// =====================================================================
// Free-form canvas editor -- every document type: click "Add" to drop a
// Data Field / Text Label / Store Logo / Graphic Line onto the card, then
// drag it anywhere or drag its bottom-right handle to resize. Nothing is
// saved until "Save Template" is clicked. Positions are plain mouse-event
// dragging (not native HTML5 drag & drop, which only supports reordering
// lists) so elements can land at any X/Y, matching QuickBooks POS.
async function renderPrintDesigner() {
  const docKeys = Object.keys(PRINT_DOC_TYPES);
  let activeDocKey = docKeys[0];
  let draft = JSON.parse(JSON.stringify(getPrintTemplate(activeDocKey)));
  let selectedElId = null;
  let dragState = null;

  function meta() { return PRINT_DOC_TYPES[activeDocKey]; }
  // The template can override the doc type's default physical size --
  // this is what lets someone shrink, say, the Inventory Tag down to their
  // actual sticker size instead of leaving blank space on the card.
  function canvasSize() { return draft.canvasSize || meta().canvasSize; }
  function hasBlockField() { return meta().fieldOptions.some((f) => f.isBlock); }
  function currentShowBorder() {
    if (draft.showBorder !== undefined) return draft.showBorder;
    return ['inventoryTag', 'customerId'].includes(activeDocKey);
  }

  function draw() {
    content.innerHTML = `
      <div class="view-header">
        <h1>Print Designer</h1>
        <div class="view-actions">
          <button class="btn" id="pdResetBtn">Reset to Default</button>
          ${activeDocKey === 'inventoryTag' ? `<button class="btn" id="pdTagPreviewBtn">${icon('fileText', 14)} Preview</button>` : ''}
          <button class="btn" id="pdPrintBtn">${icon('printer', 14)} Print</button>
          <button class="btn btn-primary" id="pdSaveBtn">Save Template</button>
        </div>
      </div>
      <div class="card card-narrow">
        <p class="note small pd-touch-note" style="margin:0 0 12px;">Placing and dragging elements works best with a mouse or on a larger screen.</p>
        <label class="field">Select a Document Type
          <select id="pdDocType">
            ${docKeys.map((k) => `<option value="${k}" ${k === activeDocKey ? 'selected' : ''}>${escapeHtml(PRINT_DOC_TYPES[k].label)}</option>`).join('')}
          </select>
        </label>
        <p class="note small">Click "Add" to place an element, drag it anywhere, drag its corner to resize.${hasBlockField() ? ' Tables/summaries grow with real content -- leave room below them.' : ''}</p>
        <div class="pd-size-row">
          <label>Card Size (W)
            <input type="number" id="pdSizeW" min="60" max="900" step="1" value="${canvasSize().w}" /> px
          </label>
          <label>(H)
            <input type="number" id="pdSizeH" min="30" max="900" step="1" value="${canvasSize().h}" /> px
          </label>
          <button type="button" class="btn btn-sm" id="pdSizeResetBtn" title="Back to this document type's default size">Reset Size</button>
        </div>
        <p class="note small">Shrink this to match your actual sticker/label size instead of leaving blank space on the card.</p>
        <div class="pd-size-row">
          <label>Page Margin
            <input type="number" id="pdMargin" min="0" max="150" step="1" value="${draft.margin ?? DEFAULT_PRINT_MARGIN}" /> px
          </label>
          <button type="button" class="btn btn-sm" id="pdMarginResetBtn" title="Back to the default page margin">Reset Margin</button>
        </div>
        <p class="note small">The blank border around the whole printed page -- shrink it toward 0 to reclaim unused space, or grow it back anytime.</p>
        <label class="pd-el-bold-label mt"><input type="checkbox" id="pdShowBorder" ${currentShowBorder() ? 'checked' : ''} /> Show card border (outline around the whole document)</label>
      </div>
      <div class="print-designer-layout">
        <div class="card" id="pdCanvasCard">
          <div class="pd-canvas-toolbar">
            <div class="pd-add-wrap">
              <button type="button" class="btn btn-sm" id="pdAddBtn">${icon('columns', 14)} Add &#9662;</button>
              <div id="pdAddMenu" class="pd-add-menu" hidden>
                <button type="button" data-add="field">Data Field</button>
                <button type="button" data-add="text">Text Label</button>
                <button type="button" data-add="logo">Store Logo</button>
                <button type="button" data-add="line">Graphic Line</button>
              </div>
            </div>
            <button type="button" class="btn btn-sm btn-danger" id="pdRemoveBtn">Remove</button>
          </div>
          <div id="pdCanvas" class="pd-canvas" style="width:${canvasSize().w}px; height:${canvasSize().h}px;"></div>
          <div id="pdPropsPanel" class="pd-props-panel"></div>
        </div>
        <div class="card" id="pdPreviewCard">
          <h2>Document Preview</h2>
          <div id="pdPreview" class="pd-preview-box"></div>
        </div>
      </div>
    `;

    document.getElementById('pdDocType').addEventListener('change', (e) => {
      activeDocKey = e.target.value;
      draft = JSON.parse(JSON.stringify(getPrintTemplate(activeDocKey)));
      selectedElId = null;
      draw();
    });
    document.getElementById('pdResetBtn').addEventListener('click', () => {
      if (!confirmGuarded('edit', `Reset the ${meta().label} template to its default layout?`)) return;
      draft = defaultPrintTemplate(activeDocKey);
      selectedElId = null;
      draw();
    });
    document.getElementById('pdSaveBtn').addEventListener('click', async () => {
      try {
        await savePrintTemplate(activeDocKey, draft);
        toast('Print template saved.', 'success');
      } catch (err) { toast(err.message, 'error'); }
    });
    function applyCanvasSize(w, h) {
      draft.canvasSize = { w: Math.max(60, Math.min(900, Math.round(w))), h: Math.max(30, Math.min(900, Math.round(h))) };
      const canvasEl = document.getElementById('pdCanvas');
      canvasEl.style.width = draft.canvasSize.w + 'px';
      canvasEl.style.height = draft.canvasSize.h + 'px';
      drawCanvas();
    }
    document.getElementById('pdSizeW').addEventListener('change', (e) => applyCanvasSize(Number(e.target.value) || canvasSize().w, canvasSize().h));
    document.getElementById('pdSizeH').addEventListener('change', (e) => applyCanvasSize(canvasSize().w, Number(e.target.value) || canvasSize().h));
    document.getElementById('pdSizeResetBtn').addEventListener('click', () => {
      delete draft.canvasSize;
      selectedElId = null;
      draw();
    });
    document.getElementById('pdMargin').addEventListener('change', (e) => {
      draft.margin = Math.max(0, Math.min(150, Math.round(Number(e.target.value)) || 0));
      drawPreview();
    });
    document.getElementById('pdMarginResetBtn').addEventListener('click', () => {
      delete draft.margin;
      draw();
    });
    document.getElementById('pdShowBorder').addEventListener('change', (e) => {
      draft.showBorder = e.target.checked;
      drawPreview();
    });
    // Prints (browser Print Preview -> Print) using whatever's on the
    // canvas right now, sample data included -- so you can see and print an
    // actual test page before committing to "Save Template".
    document.getElementById('pdPrintBtn').addEventListener('click', () => {
      openPrintDoc(meta().label, meta().render(draft, meta().sampleData()), { margin: draft.margin ?? DEFAULT_PRINT_MARGIN });
    });
    // Inventory Tags-only: "how many tags to preview?" then a print-preview
    // sheet packed with that many copies of the current (unsaved) layout,
    // using sample data -- matches QuickBooks POS's Tag Preview dialog.
    const tagPreviewBtn = document.getElementById('pdTagPreviewBtn');
    if (tagPreviewBtn) {
      tagPreviewBtn.addEventListener('click', () => {
        openTagPreviewCountModal((count) => {
          const sample = meta().sampleData();
          const { w, h } = canvasSize();
          const tags = Array.from({ length: count }, () =>
            `<div style="width:${w}px; height:${h}px;">${renderInventoryTagDoc(draft, sample)}</div>`
          ).join('');
          openPrintDoc('Tag Preview', `<div style="display:flex; flex-wrap:wrap; gap:8px;">${tags}</div>`, { margin: draft.margin ?? DEFAULT_PRINT_MARGIN });
        });
      });
    }

    document.getElementById('pdAddBtn').addEventListener('click', () => {
      document.getElementById('pdAddMenu').hidden = !document.getElementById('pdAddMenu').hidden;
    });
    document.querySelectorAll('#pdAddMenu button').forEach((btn) => btn.addEventListener('click', () => {
      addElement(btn.dataset.add);
      document.getElementById('pdAddMenu').hidden = true;
    }));
    document.getElementById('pdRemoveBtn').addEventListener('click', () => {
      if (!selectedElId) { toast('Select an element on the canvas first.', 'error'); return; }
      draft.elements = draft.elements.filter((x) => x.id !== selectedElId);
      selectedElId = null;
      drawCanvas();
    });
    document.getElementById('pdCanvas').addEventListener('mousedown', (e) => {
      if (e.target.id === 'pdCanvas') { selectedElId = null; drawCanvas(); }
    });

    drawCanvas();
  }

  function addElement(type) {
    const id = 'el' + Math.random().toString(36).slice(2, 9);
    const el = { id, type, x: 20, y: 20, w: type === 'line' ? 100 : 120, h: type === 'line' ? 4 : 24, fontSize: 11, align: 'center', bold: false };
    if (type === 'field') el.fieldKey = meta().fieldOptions[0].key;
    if (type === 'text') el.text = 'Text Label';
    if (type === 'line') { el.thickness = 1; el.orientation = 'horizontal'; el.h = 1; }
    draft.elements = draft.elements || [];
    draft.elements.push(el);
    selectedElId = id;
    drawCanvas();
  }

  function elementPreviewContent(el) {
    if (el.type === 'text') return escapeHtml(el.text || 'Text Label');
    if (el.type === 'logo') return `<span style="font-size:9px; color:#888;">${escapeHtml(COMPANY_SETTINGS.store_name || 'STORE LOGO')}</span>`;
    if (el.type === 'line') return '';
    if (el.type === 'field') {
      const opt = meta().fieldOptions.find((f) => f.key === el.fieldKey) || meta().fieldOptions[0];
      if (!opt) return '';
      if (opt.isBarcode) return renderBarcodeSvg(opt.value(meta().sampleData()), el.w);
      if (opt.isBlock) return `<div style="transform:scale(0.7); transform-origin: top left; width:143%;">${opt.value(meta().sampleData(), el)}</div>`;
      return escapeHtml(opt.value(meta().sampleData()));
    }
    return '';
  }

  function drawCanvas() {
    const canvasEl = document.getElementById('pdCanvas');
    canvasEl.innerHTML = (draft.elements || []).map((el) => {
      const selected = el.id === selectedElId;
      if (el.type === 'line') {
        const style = el.orientation === 'vertical'
          ? `left:${el.x}px; top:${el.y}px; width:${el.thickness || 1}px; height:${el.h}px; background:#000;`
          : `left:${el.x}px; top:${el.y}px; width:${el.w}px; height:${el.thickness || 1}px; background:#000;`;
        return `<div class="pd-canvas-el ${selected ? 'pd-el-selected' : ''}" data-id="${el.id}" style="${style} min-width:8px; min-height:8px;">${selected ? '<div class="pd-resize-handle"></div>' : ''}</div>`;
      }
      const justify = el.align === 'left' ? 'flex-start' : el.align === 'right' ? 'flex-end' : 'center';
      return `
        <div class="pd-canvas-el ${selected ? 'pd-el-selected' : ''}" data-id="${el.id}" style="left:${el.x}px; top:${el.y}px; width:${el.w}px; height:${el.h}px;">
          <div class="pd-canvas-el-content" style="font-size:${el.fontSize || 11}px; font-weight:${el.bold ? 700 : 400}; justify-content:${justify}; overflow:${el.type === 'field' && meta().fieldOptions.find((f) => f.key === el.fieldKey)?.isBlock ? 'hidden' : 'hidden'};">${elementPreviewContent(el)}</div>
          ${selected ? '<div class="pd-resize-handle"></div>' : ''}
        </div>
      `;
    }).join('');

    canvasEl.querySelectorAll('.pd-canvas-el').forEach((node) => {
      node.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = node.dataset.id;
        selectedElId = id;
        const el = draft.elements.find((x) => x.id === id);
        const isResize = e.target.classList.contains('pd-resize-handle');
        dragState = { id, isResize, startX: e.clientX, startY: e.clientY, origX: el.x, origY: el.y, origW: el.w, origH: el.h };
        drawCanvas();
      });
    });

    drawProps();
    drawPreview();
  }

  document.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const el = (draft.elements || []).find((x) => x.id === dragState.id);
    if (!el) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    const size = canvasSize();
    if (dragState.isResize) {
      el.w = Math.max(16, dragState.origW + dx);
      el.h = Math.max(el.type === 'line' && el.orientation !== 'vertical' ? 1 : 12, dragState.origH + dy);
    } else {
      el.x = Math.max(0, Math.min(size.w - Math.min(el.w, size.w), dragState.origX + dx));
      el.y = Math.max(0, dragState.origY + dy);
    }
    const node = document.querySelector(`#pdCanvas .pd-canvas-el[data-id="${el.id}"]`);
    if (node) {
      node.style.left = el.x + 'px';
      node.style.top = el.y + 'px';
      node.style.width = el.w + 'px';
      if (el.type !== 'line' || el.orientation === 'vertical') node.style.height = el.h + 'px';
    }
  });
  document.addEventListener('mouseup', () => {
    if (!dragState) return;
    dragState = null;
    drawPreview();
  });

  function drawProps() {
    const panel = document.getElementById('pdPropsPanel');
    if (!panel) return;
    const el = (draft.elements || []).find((x) => x.id === selectedElId);
    if (!el) { panel.innerHTML = `<p style="font-size:12px; color:var(--text-muted); margin:10px 0 0;">Select an element to edit it, or use "Add" to place a new one.</p>`; return; }
    const fieldOpt = el.type === 'field' ? meta().fieldOptions.find((f) => f.key === el.fieldKey) : null;
    panel.innerHTML = `
      <div class="pd-props-grid">
        ${el.type === 'text' ? `<label>Text<input type="text" id="pdElText" value="${escapeHtml(el.text || '')}" /></label>` : ''}
        ${el.type === 'field' ? `<label>Field
          <select id="pdElField">
            ${meta().fieldOptions.map((f) => `<option value="${f.key}" ${f.key === el.fieldKey ? 'selected' : ''}>${escapeHtml(f.label)}</option>`).join('')}
          </select>
        </label>` : ''}
        ${el.type !== 'line' ? `
          <label>Font Size<input type="number" id="pdElFontSize" min="7" max="40" value="${el.fontSize || 11}" /></label>
          <label>Align
            <select id="pdElAlign">
              <option value="center" ${el.align === 'center' ? 'selected' : ''}>Center</option>
              <option value="left" ${el.align === 'left' ? 'selected' : ''}>Left</option>
              <option value="right" ${el.align === 'right' ? 'selected' : ''}>Right</option>
            </select>
          </label>
          <label class="pd-el-bold-label"><input type="checkbox" id="pdElBold" ${el.bold ? 'checked' : ''} /> Bold</label>
        ` : `
          <label>Thickness<input type="number" id="pdElThickness" min="1" max="10" value="${el.thickness || 1}" /></label>
          <label>Orientation
            <select id="pdElOrientation">
              <option value="horizontal" ${el.orientation !== 'vertical' ? 'selected' : ''}>Horizontal</option>
              <option value="vertical" ${el.orientation === 'vertical' ? 'selected' : ''}>Vertical</option>
            </select>
          </label>
        `}
        ${fieldOpt?.isBlock ? '<p style="grid-column:1/-1; font-size:11px; color:var(--text-muted); margin:0;">This is a whole block (table/summary) -- font size/align apply to its default text, not each row.</p>' : ''}
      </div>
      ${el.fieldKey === 'itemsTable' ? `
        <div class="pd-props-grid" style="margin-top:12px;">
          <div style="grid-column:1/-1; font-size:12px; font-weight:600; color:var(--text-muted);">Table Lines</div>
          <label class="pd-el-bold-label"><input type="checkbox" id="pdLineHeading" ${el.lineHeading !== false ? 'checked' : ''} /> Line below column heading</label>
          <label class="pd-el-bold-label"><input type="checkbox" id="pdLineEach" ${el.lineEachItem ? 'checked' : ''} /> Line below each item</label>
          <label class="pd-el-bold-label"><input type="checkbox" id="pdLineLast" ${el.lineLast !== false ? 'checked' : ''} /> Line below last item</label>
        </div>
      ` : ''}
    `;
    const bind = (id, prop, parse) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener('input', () => {
        el[prop] = parse ? parse(input.value) : input.value;
        drawCanvas();
      });
    };
    bind('pdElText', 'text');
    bind('pdElField', 'fieldKey');
    bind('pdElFontSize', 'fontSize', Number);
    bind('pdElAlign', 'align');
    bind('pdElThickness', 'thickness', Number);
    bind('pdElOrientation', 'orientation');
    const boldCb = document.getElementById('pdElBold');
    if (boldCb) boldCb.addEventListener('change', () => { el.bold = boldCb.checked; drawCanvas(); });
    const bindLineCb = (id, prop) => {
      const cb = document.getElementById(id);
      if (!cb) return;
      cb.addEventListener('change', () => { el[prop] = cb.checked; drawCanvas(); });
    };
    bindLineCb('pdLineHeading', 'lineHeading');
    bindLineCb('pdLineEach', 'lineEachItem');
    bindLineCb('pdLineLast', 'lineLast');
  }

  function drawPreview() {
    const previewEl = document.getElementById('pdPreview');
    if (!previewEl) return;
    previewEl.style.padding = (draft.margin ?? DEFAULT_PRINT_MARGIN) + 'px';
    previewEl.innerHTML = compactCanvasHtml(meta().render(draft, meta().sampleData()));
  }

  draw();
}

// ---------- Start ----------
(async () => {
  try { COMPANY_SETTINGS = await Api.get('/api/settings'); } catch (e) { /* fall back to defaults */ }
  navigate('home');
})();
