// Small UI helpers shared by every page (the POS app and the platform admin
// console): toasts, modals, HTML escaping, and the phone card layout for
// tables. Loaded before app.js / platform.js; everything here is global.

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Toasts ----------
const toastHost = document.getElementById('toastHost');
const MAX_VISIBLE_TOASTS = 3;
function toast(message, type = '') {
  if (!toastHost) { if (type === 'error') alert(message); return; }
  // Cap how many can pile up at once -- rapid repeated actions (e.g.
  // spam-clicking something) shouldn't be able to stack toasts endlessly.
  while (toastHost.children.length >= MAX_VISIBLE_TOASTS) {
    toastHost.firstElementChild.remove();
  }
  const el = document.createElement('div');
  el.className = `toast${type ? ` toast-${type}` : ''}`;
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 260);
  }, 2600);
}


function openModal(html, extraClass = '') {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal ${extraClass}">${html}</div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  return overlay;
}


// Focus a field only on devices with a real keyboard -- on a phone, grabbing
// focus on page load pops the on-screen keyboard over the screen the person
// just navigated to.
const IS_TOUCH = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
function autoFocus(el) {
  if (el && !IS_TOUCH) el.focus();
}


// ---------- Responsive tables ----------
// On phones every table inside a .table-wrap is shown as a stack of cards
// (see "Tables become stacked cards" in style.css). CSS can't read a column's
// header text, so this copies each header onto its cells as data-label and
// tags the special cells: the first named column becomes the card title,
// cells holding only buttons become the action row, and a lone checkbox
// becomes the card's select box. It's harmless on wide screens, and a
// MutationObserver keeps it applied as tables are redrawn (sort, search,
// customize columns, modals, ...).
function enhanceTable(table) {
  if (!table.closest('.table-wrap') || table.closest('.no-cards')) return;
  const labels = [];
  const headRow = table.tHead && table.tHead.rows[table.tHead.rows.length - 1];
  if (headRow) {
    [...headRow.cells].forEach((th) => {
      const clone = th.cloneNode(true);
      clone.querySelectorAll('.sort-arrow, .col-resizer, input').forEach((n) => n.remove());
      const text = clone.textContent.trim();
      for (let i = 0; i < (th.colSpan || 1); i++) labels.push(text);
    });
  }
  const onlyChildren = (td, selector) => {
    const nodes = [...td.childNodes].filter((n) => !(n.nodeType === 3 && !n.textContent.trim()));
    return nodes.length > 0 && nodes.every((n) => n.nodeType === 1 && n.matches(selector));
  };
  table.classList.add('m-cards');
  const titleRank = (label) => {
    if (/name/i.test(label) || /^receipt/i.test(label)) return 1;
    if (/^(item|description|vendor|label|department|employee|associate|customer|company|payment)/i.test(label)) return 2;
    return 3;
  };
  table.querySelectorAll(':scope > tbody > tr, :scope > tfoot > tr').forEach((tr) => {
    let col = 0;
    let best = null; // the cell that should headline this card
    const hasTitle = !!tr.querySelector('.line-name-cell, .sale-line-name-cell');
    [...tr.cells].forEach((td) => {
      const span = td.colSpan || 1;
      if (span > 1 || td.classList.contains('empty-state')) { td.classList.add('m-span'); col += span; return; }
      if (!td.hasAttribute('data-label') || td._autoLabel) {
        td.setAttribute('data-label', labels[col] || '');
        td._autoLabel = true;
      }
      td.classList.remove('m-title');
      if (onlyChildren(td, 'button, .btn')) td.classList.add('td-actions');
      else if (onlyChildren(td, 'input[type="checkbox"]')) td.classList.add('td-check');
      else if (!hasTitle && td.getAttribute('data-label') && tr.parentElement.tagName === 'TBODY') {
        const rank = titleRank(td.getAttribute('data-label'));
        if (!best || rank < best.rank) best = { td, rank };
      }
      col += span;
    });
    if (best) best.td.classList.add('m-title');
  });
}
new MutationObserver((mutations) => {
  const tables = new Set();
  mutations.forEach((m) => m.addedNodes.forEach((n) => {
    if (n.nodeType !== 1) return;
    const owner = n.closest('table');
    if (owner) tables.add(owner);
    n.querySelectorAll('table').forEach((t) => tables.add(t));
  }));
  tables.forEach(enhanceTable);
}).observe(document.body, { childList: true, subtree: true });

