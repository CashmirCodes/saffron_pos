// Platform admin console: every company using this Saffron install, with
// add / pause / remove and the people (admins) inside each one.
// Talks to /api/platform/* (see server/routes/platform.js).
const PLATFORM_USER = Api.getUser();
if (!Api.getToken() || !PLATFORM_USER) {
  window.location.href = 'login.html';
} else if (PLATFORM_USER.role !== 'platform') {
  window.location.href = 'index.html';
}

const content = document.getElementById('content');
document.getElementById('logoutBtn').addEventListener('click', () => {
  Api.clear();
  window.location.href = 'login.html';
});

const PEOPLE_ROLES = [['admin', 'Admin'], ['manager', 'Manager'], ['cashier', 'Cashier'], ['salesman', 'Salesman']];

let companies = [];
let searchText = '';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString([], { dateStyle: 'medium' }) : '—');
const num = (n) => Number(n || 0).toLocaleString();

// Easy-to-read-aloud password (no 0/O, 1/l/I lookalikes).
function generatePassword(length = 12) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

async function copyText(text, okMessage = 'Copied.') {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage, 'success');
  } catch (e) {
    toast('Couldn’t copy automatically -- select the text and copy it.', 'error');
  }
}

async function loadCompanies() {
  companies = await Api.get('/api/platform/companies');
}

// ---------- Company list ----------
function statusBadge(c) {
  return c.active ? '<span class="badge badge-ok">Active</span>' : '<span class="badge badge-low">Paused</span>';
}

function draw() {
  const q = searchText.trim().toLowerCase();
  const visible = companies.filter((c) => !q || c.name.toLowerCase().includes(q) || c.code.includes(q));
  const active = companies.filter((c) => c.active).length;
  const people = companies.reduce((sum, c) => sum + c.user_count, 0);

  content.innerHTML = `
    <div class="view-header">
      <div>
        <h1>Companies</h1>
        <p class="note" style="margin:4px 0 0;">Everyone using Saffron on this install.</p>
      </div>
      <div class="view-actions">
        <input type="search" class="search-input" id="companySearch" placeholder="Search companies&hellip;" value="${escapeHtml(searchText)}" autocomplete="off" />
        <button type="button" class="btn btn-primary" id="newCompanyBtn">+ New Company</button>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card"><small>Companies</small><strong>${num(companies.length)}</strong></div>
      <div class="stat-card"><small>Active</small><strong>${num(active)}</strong></div>
      <div class="stat-card"><small>Paused</small><strong>${num(companies.length - active)}</strong></div>
      <div class="stat-card"><small>Employees</small><strong>${num(people)}</strong></div>
    </div>

    <div class="card table-wrap">
      <table>
        <thead><tr><th>Company</th><th>Status</th><th>Admins</th><th>Employees</th><th>Sales</th><th>Last Sale</th><th>Created</th><th></th></tr></thead>
        <tbody>${visible.map((c) => `
          <tr class="${c.active ? '' : 'row-paused'}">
            <td class="company-cell"><strong>${escapeHtml(c.name)}</strong><small>${escapeHtml(c.code)}</small></td>
            <td>${statusBadge(c)}</td>
            <td>${num(c.admin_count)}</td>
            <td>${num(c.user_count)}</td>
            <td>${num(c.sale_count)}</td>
            <td>${fmtDate(c.last_sale_at)}</td>
            <td>${fmtDate(c.created_at)}</td>
            <td>
              <button type="button" class="btn btn-sm" data-act="manage" data-id="${c.id}">Manage</button>
              <button type="button" class="btn btn-sm" data-act="toggle" data-id="${c.id}">${c.active ? 'Pause' : 'Resume'}</button>
              <button type="button" class="btn btn-sm btn-danger" data-act="remove" data-id="${c.id}">Remove</button>
            </td>
          </tr>`).join('') || `<tr><td colspan="8" class="empty-state">${companies.length ? 'No company matches that search.' : 'No companies yet -- add the first one.'}</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  const search = document.getElementById('companySearch');
  search.addEventListener('input', () => {
    searchText = search.value;
    const pos = search.selectionStart;
    draw();
    const again = document.getElementById('companySearch');
    again.focus();
    again.setSelectionRange(pos, pos);
  });
  document.getElementById('newCompanyBtn').addEventListener('click', openCreateModal);
  content.querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => {
    const company = companies.find((c) => c.id === Number(btn.dataset.id));
    if (!company) return;
    if (btn.dataset.act === 'manage') openManageModal(company);
    else if (btn.dataset.act === 'toggle') togglePause(company);
    else openRemoveModal(company);
  }));
}

async function refresh() {
  await loadCompanies();
  draw();
}

// ---------- Pause / resume ----------
async function togglePause(company) {
  const pausing = company.active;
  const message = pausing
    ? `Pause ${company.name}?\n\nNobody there will be able to sign in, and anyone signed in right now is cut off. Their data is kept and you can resume any time.`
    : `Resume ${company.name}? Their people will be able to sign in again.`;
  if (!confirm(message)) return;
  try {
    await Api.put(`/api/platform/companies/${company.id}`, { active: !pausing });
    toast(`${company.name} ${pausing ? 'paused' : 'resumed'}.`, 'success');
    await refresh();
  } catch (err) { toast(err.message, 'error'); }
}

// ---------- New company ----------
function openCreateModal() {
  const overlay = openModal(`
    <h2>New Company</h2>
    <form id="createForm" class="form-grid">
      <label class="span-all">Company name<input name="company_name" required placeholder="e.g. Acme Hardware" /></label>
      <label class="span-all">Company code <span class="pref-hint">(what they type to sign in -- leave blank to make one from the name)</span>
        <input name="company_code" placeholder="e.g. acme-hardware" autocapitalize="none" autocomplete="off" />
      </label>
      <label class="span-all">Admin's full name<input name="admin_full_name" placeholder="e.g. Ada Boss" /></label>
      <label>Admin username<input name="admin_username" required autocapitalize="none" autocomplete="off" /></label>
      <label>Admin password
        <span class="field-row">
          <input name="admin_password" id="newCompanyPassword" type="password" required minlength="6" autocomplete="new-password" />
          <button type="button" class="btn" id="generatePwBtn">Generate</button>
        </span>
      </label>
      <div class="modal-actions span-all">
        <button type="button" class="btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="btn btn-primary">Create Company</button>
      </div>
    </form>
  `);
  const form = overlay.querySelector('#createForm');
  const pw = overlay.querySelector('#newCompanyPassword');
  overlay.querySelector('#cancelBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#generatePwBtn').addEventListener('click', () => {
    pw.value = generatePassword();
    pw.type = 'text'; // show it so it can be copied
  });
  autoFocus(form.querySelector('[name="company_name"]'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      const result = await Api.post('/api/platform/companies', body);
      overlay.remove();
      await refresh();
      showLoginDetails(result.company, body.admin_username, body.admin_password);
    } catch (err) { toast(err.message, 'error'); }
  });
}

// Shown once after creating a company: the details to hand to the new admin.
function showLoginDetails(company, username, password) {
  const details = `Saffron POS sign-in\nCompany code: ${company.code}\nUsername: ${username}\nPassword: ${password}`;
  const overlay = openModal(`
    <h2>${escapeHtml(company.name)} is ready</h2>
    <p class="note">Send these sign-in details to the new admin. The password isn’t shown again after you close this.</p>
    <pre class="login-details">${escapeHtml(details)}</pre>
    <div class="modal-actions">
      <button type="button" class="btn" id="copyDetailsBtn">Copy details</button>
      <button type="button" class="btn btn-primary" id="doneBtn">Done</button>
    </div>
  `);
  overlay.querySelector('#copyDetailsBtn').addEventListener('click', () => copyText(details, 'Sign-in details copied.'));
  overlay.querySelector('#doneBtn').addEventListener('click', () => overlay.remove());
}

// ---------- Remove ----------
function openRemoveModal(company) {
  const overlay = openModal(`
    <h2>Remove ${escapeHtml(company.name)}?</h2>
    <p class="note">This permanently deletes the company and <strong>everything</strong> in it -- ${num(company.user_count)} employee${company.user_count === 1 ? '' : 's'}, ${num(company.sale_count)} sale${company.sale_count === 1 ? '' : 's'}, items, customers, and settings. It can’t be undone.</p>
    ${company.active ? '<p class="note">If you only want to stop them using Saffron for now, <strong>Pause</strong> is safer.</p>' : ''}
    <label class="field">Type <strong>${escapeHtml(company.code)}</strong> to confirm
      <input id="confirmCode" autocomplete="off" autocapitalize="none" />
    </label>
    <div class="modal-actions">
      <button type="button" class="btn" id="cancelBtn">Cancel</button>
      <button type="button" class="btn btn-danger" id="confirmRemoveBtn" disabled>Remove permanently</button>
    </div>
  `);
  const input = overlay.querySelector('#confirmCode');
  const confirmBtn = overlay.querySelector('#confirmRemoveBtn');
  input.addEventListener('input', () => { confirmBtn.disabled = input.value.trim().toLowerCase() !== company.code; });
  overlay.querySelector('#cancelBtn').addEventListener('click', () => overlay.remove());
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try {
      await Api.post(`/api/platform/companies/${company.id}/delete`, { confirm_code: input.value });
      overlay.remove();
      toast(`${company.name} removed.`, 'success');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
      confirmBtn.disabled = false;
    }
  });
  autoFocus(input);
}

// ---------- Manage a company: rename + its people ----------
async function openManageModal(company) {
  const overlay = openModal(`
    <h2>${escapeHtml(company.name)} ${statusBadge(company)}</h2>
    <p class="note">Company code <strong>${escapeHtml(company.code)}</strong> &middot; created ${fmtDate(company.created_at)}</p>
    <form id="renameForm">
      <label class="field">Company name
        <span class="field-row">
          <input name="name" required value="${escapeHtml(company.name)}" />
          <button type="submit" class="btn">Rename</button>
        </span>
      </label>
    </form>
    <div class="row-between mt">
      <h3 style="margin:0;">People</h3>
      <button type="button" class="btn btn-sm btn-primary" id="addPersonBtn">+ Add admin</button>
    </div>
    <div class="table-wrap" id="peopleWrap" style="margin-top:8px;"><div class="empty-state compact">Loading&hellip;</div></div>
    <div class="modal-actions"><button type="button" class="btn" id="closeBtn">Close</button></div>
  `, 'modal-lg');

  overlay.querySelector('#closeBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#renameForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = new FormData(e.target).get('name');
    try {
      await Api.put(`/api/platform/companies/${company.id}`, { name });
      toast('Company renamed.', 'success');
      overlay.querySelector('h2').firstChild.textContent = `${name} `;
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  const wrap = overlay.querySelector('#peopleWrap');
  async function loadPeople() {
    let people;
    try { people = await Api.get(`/api/platform/companies/${company.id}/users`); }
    catch (err) { wrap.innerHTML = `<div class="empty-state compact">${escapeHtml(err.message)}</div>`; return; }
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody>${people.map((u) => `
          <tr>
            <td>${escapeHtml(u.full_name || u.username)}</td>
            <td>${escapeHtml(u.username)}</td>
            <td>${escapeHtml(u.role)}</td>
            <td>${u.active ? '<span class="badge badge-ok">Active</span>' : '<span class="badge badge-low">Disabled</span>'}</td>
            <td>
              <button type="button" class="btn btn-sm" data-pact="reset" data-id="${u.id}">Reset password</button>
              <button type="button" class="btn btn-sm ${u.active ? 'btn-danger' : ''}" data-pact="toggle" data-id="${u.id}">${u.active ? 'Disable' : 'Enable'}</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="5" class="empty-state">No people yet.</td></tr>'}
        </tbody>
      </table>`;
    wrap.querySelectorAll('[data-pact]').forEach((btn) => btn.addEventListener('click', async () => {
      const person = people.find((u) => u.id === Number(btn.dataset.id));
      if (!person) return;
      if (btn.dataset.pact === 'reset') {
        openResetPasswordModal(company, person);
      } else {
        try {
          await Api.put(`/api/platform/companies/${company.id}/users/${person.id}`, { active: !person.active });
          toast(`${person.username} ${person.active ? 'disabled' : 'enabled'}.`, 'success');
          await loadPeople();
          await refresh();
        } catch (err) { toast(err.message, 'error'); }
      }
    }));
  }
  overlay.querySelector('#addPersonBtn').addEventListener('click', () => openAddPersonModal(company, async () => { await loadPeople(); await refresh(); }));
  loadPeople();
}

function openAddPersonModal(company, onDone) {
  const overlay = openModal(`
    <h2>Add to ${escapeHtml(company.name)}</h2>
    <form id="personForm" class="form-grid">
      <label>Full name<input name="full_name" placeholder="e.g. Ada Boss" /></label>
      <label>Role
        <select name="role">${PEOPLE_ROLES.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select>
      </label>
      <label>Username<input name="username" required autocapitalize="none" autocomplete="off" /></label>
      <label>Password
        <span class="field-row">
          <input name="password" id="personPassword" type="password" required minlength="6" autocomplete="new-password" />
          <button type="button" class="btn" id="generatePwBtn">Generate</button>
        </span>
      </label>
      <div class="modal-actions span-all">
        <button type="button" class="btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="btn btn-primary">Add</button>
      </div>
    </form>
  `);
  const pw = overlay.querySelector('#personPassword');
  overlay.querySelector('#cancelBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#generatePwBtn').addEventListener('click', () => { pw.value = generatePassword(); pw.type = 'text'; });
  overlay.querySelector('#personForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      await Api.post(`/api/platform/companies/${company.id}/users`, body);
      overlay.remove();
      toast(`${body.username} added to ${company.name}.`, 'success');
      if (confirm(`Copy ${body.username}'s sign-in details to share?`)) {
        copyText(`Saffron POS sign-in\nCompany code: ${company.code}\nUsername: ${body.username}\nPassword: ${body.password}`, 'Sign-in details copied.');
      }
      await onDone();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function openResetPasswordModal(company, person) {
  const overlay = openModal(`
    <h2>Reset password</h2>
    <p class="note">New password for <strong>${escapeHtml(person.username)}</strong> at ${escapeHtml(company.name)}.</p>
    <form id="resetForm">
      <label class="field">New password
        <span class="field-row">
          <input name="password" id="resetPassword" type="password" required minlength="6" autocomplete="new-password" />
          <button type="button" class="btn" id="generatePwBtn">Generate</button>
        </span>
      </label>
      <div class="modal-actions">
        <button type="button" class="btn" id="cancelBtn">Cancel</button>
        <button type="submit" class="btn btn-primary">Save password</button>
      </div>
    </form>
  `);
  const pw = overlay.querySelector('#resetPassword');
  overlay.querySelector('#cancelBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#generatePwBtn').addEventListener('click', () => { pw.value = generatePassword(); pw.type = 'text'; });
  overlay.querySelector('#resetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await Api.put(`/api/platform/companies/${company.id}/users/${person.id}`, { password: pw.value });
      overlay.remove();
      toast('Password updated.', 'success');
      if (pw.type === 'text' && confirm('Copy the new password to share it?')) copyText(pw.value, 'Password copied.');
    } catch (err) { toast(err.message, 'error'); }
  });
}

refresh().catch((err) => {
  content.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
});
