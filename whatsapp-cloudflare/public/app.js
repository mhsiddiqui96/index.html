'use strict';
/* WA Business SaaS — single-page admin panel (vanilla JS, no build step). */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ROLE_BN = { owner: 'মালিক (Owner)', admin: 'অ্যাডমিন', agent: 'এজেন্ট' };

const state = {
  me: null, workspace: null,
  convs: [], filter: 'all', status: 'open', q: '',
  current: null, messages: [], users: [], quickReplies: [],
  since: null, pollTimer: null,
  numbers: [], labels: [], numberFilter: '', labelFilter: '',
};

const LABEL_COLORS = ['#2563eb', '#16a34a', '#ea580c', '#dc2626', '#7c3aed', '#db2777', '#0891b2', '#ca8a04', '#4b5563'];
const labelById = (id) => state.labels.find((l) => l.id === id);
const labelChips = (ids = []) => ids.map(labelById).filter(Boolean)
  .map((l) => `<span class="lbl" style="--c:${esc(l.color)}">${esc(l.name)}</span>`).join('');
const multiNumber = () => state.numbers.length > 1;
const numberName = (id) => state.numbers.find((n) => n.id === id)?.label || '';
async function loadLabels() { state.labels = await api('/labels').catch(() => state.labels); }
const labelFilterOptions = () => `<option value="">🏷️ সব লেবেল</option>${state.labels.map((l) =>
  `<option value="${l.id}" ${String(l.id) === String(state.labelFilter) ? 'selected' : ''}>🏷️ ${esc(l.name)}</option>`).join('')}`;

// ---------- helpers ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/login') && !path.startsWith('/signup')) {
    state.me = null;
    renderAuth('login');
  }
  if (!res.ok) throw Object.assign(new Error(data.error || 'কিছু একটা ভুল হয়েছে'), { data, status: res.status });
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3200);
}

const parseTime = (ms) => (ms ? new Date(ms) : null);
function timeLabel(s) {
  const d = parseTime(s);
  if (!d) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('bn-BD', { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString('bn-BD', { day: 'numeric', month: 'short' });
}
const initials = (name) => (name || '#').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const avatarColor = (s) => `hsl(${[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 45% 52%)`;
const isManager = () => state.me && ['owner', 'admin'].includes(state.me.role);

function modal(html, onMount) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => bg.remove();
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  document.body.appendChild(bg);
  onMount?.(bg, close);
  $('input, textarea, select', bg)?.focus();
  return close;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

// ---------- auth screens ----------
async function renderAuth(mode) {
  clearTimeout(state.pollTimer);
  let signupAllowed = true;
  try { signupAllowed = (await api('/config')).signupAllowed; } catch { /* ignore */ }
  if (mode === 'signup' && !signupAllowed) mode = 'login';
  const signup = mode === 'signup';
  $('#app').innerHTML = `
  <div class="auth"><div class="auth-card">
    <div class="brand"><img class="logo" src="/icons/icon-192.png" alt=""> WA Business SaaS</div>
    <h1>${signup ? 'নতুন বিজনেস অ্যাকাউন্ট খুলুন' : 'লগইন করুন'}</h1>
    <div class="hint">${signup ? 'আপনি হবেন এই অ্যাকাউন্টের মালিক (Owner)। পরে টিমে অ্যাডমিন/এজেন্ট যোগ করতে পারবেন।' : 'আপনার টিমের WhatsApp ইনবক্সে প্রবেশ করুন'}</div>
    <form id="authForm">
      ${signup ? `
        <label>বিজনেসের নাম</label><input name="workspaceName" required maxlength="120" placeholder="যেমন: আত-তুরাস একাডেমি">
        <label>আপনার নাম</label><input name="name" required maxlength="120">` : ''}
      <label>ইমেইল</label><input name="email" type="email" required autocomplete="username">
      <label>পাসওয়ার্ড</label><input name="password" type="password" required minlength="${signup ? 8 : 1}" autocomplete="${signup ? 'new-password' : 'current-password'}">
      <div class="err" id="authErr"></div>
      <button class="btn" type="submit">${signup ? 'অ্যাকাউন্ট খুলুন' : 'লগইন'}</button>
    </form>
    ${signupAllowed ? `<div class="switch">${signup
      ? 'আগে থেকে অ্যাকাউন্ট আছে? <a href="#" data-mode="login">লগইন করুন</a>'
      : 'নতুন বিজনেস? <a href="#" data-mode="signup">অ্যাকাউন্ট খুলুন</a>'}</div>` : ''}
  </div></div>`;
  $('[data-mode]')?.addEventListener('click', (e) => { e.preventDefault(); renderAuth(e.target.dataset.mode); });
  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button', e.target);
    btn.disabled = true;
    try {
      await api(signup ? '/signup' : '/login', { method: 'POST', body: formData(e.target) });
      await boot();
    } catch (err) {
      $('#authErr').textContent = err.message;
      btn.disabled = false;
    }
  });
}

// ---------- shell ----------
const NAV = [
  { id: 'inbox', icon: '💬', label: 'ইনবক্স' },
  { id: 'broadcast', icon: '📢', label: 'ব্রডকাস্ট', manager: true },
  { id: 'dashboard', icon: '📊', label: 'ড্যাশবোর্ড' },
  { id: 'team', icon: '👥', label: 'টিম / অ্যাডমিন' },
  { id: 'quick', icon: '⚡', label: 'কুইক রিপ্লাই' },
  { id: 'labels', icon: '🏷️', label: 'লেবেল' },
  { id: 'settings', icon: '📞', label: 'WhatsApp নাম্বার', manager: true },
  { id: 'activity', icon: '📝', label: 'অ্যাক্টিভিটি লগ', manager: true },
  { id: 'account', icon: '🔑', label: 'আমার অ্যাকাউন্ট' },
];

function renderShell() {
  $('#app').innerHTML = `
  <div class="shell">
    <div class="mobile-top"><button id="menuBtn" aria-label="মেনু">☰</button><b>${esc(state.workspace.name)}</b></div>
    <aside class="side" id="side">
      <div class="brand"><img class="logo" src="/icons/icon-192.png" alt=""><span>${esc(state.workspace.name)}</span></div>
      <nav>${NAV.filter((n) => !n.manager || isManager()).map((n) =>
        `<a href="#/${n.id}" data-nav="${n.id}">${n.icon} ${n.label}${n.id === 'inbox' ? '<span class="badge" id="unreadBadge" hidden></span>' : ''}</a>`).join('')}
      </nav>
      <div class="app-tools" id="appTools"></div>
      <div class="me">
        <div>${esc(state.me.name)}</div>
        <div class="role">${ROLE_BN[state.me.role]}</div>
        <button id="logoutBtn">লগআউট</button>
      </div>
    </aside>
    <main class="main" id="main"></main>
  </div>`;
  $('#logoutBtn').onclick = async () => {
    await disablePush().catch(() => {}); // a logged-out device must not keep getting this team's messages
    await api('/logout', { method: 'POST', body: {} });
    state.me = null;
    renderAuth('login');
  };
  $('#menuBtn').onclick = () => $('#side').classList.toggle('open');
  $('#side').addEventListener('click', (e) => { if (e.target.closest('a')) $('#side').classList.remove('open'); });
}

function route() {
  if (!state.me) return;
  const [page, arg] = location.hash.replace(/^#\//, '').split('/');
  const target = NAV.find((n) => n.id === page && (!n.manager || isManager())) ? page : 'inbox';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === target));
  const pages = { inbox: pageInbox, dashboard: pageDashboard, team: pageTeam, quick: pageQuick, labels: pageLabels, broadcast: pageBroadcast, settings: pageSettings, activity: pageActivity, account: pageAccount };
  pages[target](arg);
}

function updateUnreadBadge() {
  const total = state.convs.reduce((a, c) => a + (c.unread || 0), 0);
  const b = $('#unreadBadge');
  if (b) { b.hidden = !total; b.textContent = total; }
  document.title = (total ? `(${total}) ` : '') + 'WA Business SaaS';
  if (navigator.setAppBadge) (total ? navigator.setAppBadge(total) : navigator.clearAppBadge()).catch(() => {});
}

// ---------- live updates (polling; Workers have no shared push channel on the free plan) ----------
function connectEvents() {
  state.since = null;
  poll();
}

async function poll() {
  clearTimeout(state.pollTimer);
  if (!state.me) return;
  if (state.polling) { state.pollAgain = true; return; }
  state.polling = true;
  try {
    const qs = new URLSearchParams();
    if (state.since != null) qs.set('since', state.since);
    if (state.current) qs.set('conv', state.current.id);
    const u = await api('/updates?' + qs);
    const first = state.since == null;
    // Overlap windows a little so a write that committed late is never missed; merging below is idempotent.
    state.since = u.now - 5000;
    if (!first) await applyUpdates(u);
  } catch { /* offline or logged out: try again later */ }
  state.polling = false;
  if (state.pollAgain) { state.pollAgain = false; return poll(); }
  if (state.me) state.pollTimer = setTimeout(poll, document.visibilityState === 'visible' ? 4000 : 20000);
}

async function applyUpdates(u) {
  // A teammate created or renamed labels: refresh them before drawing the chats that use them.
  const ids = u.conversations.flatMap((c) => c.label_ids || []);
  if (ids.some((id) => !labelById(id))) {
    await loadLabels();
    if ($('#labelSel')) $('#labelSel').innerHTML = labelFilterOptions();
  }
  for (const id of u.hidden) {
    state.convs = state.convs.filter((c) => c.id !== id);
    if (state.current?.id === id) { state.current = null; renderChat(); }
  }
  for (const c of u.conversations) {
    const prev = state.convs.find((x) => x.id === c.id) || (state.current?.id === c.id ? state.current : null);
    const newInbound = c.last_inbound_ms && c.last_inbound_ms === c.last_message_ms && (!prev || (prev.last_message_ms || 0) < c.last_message_ms);
    upsertConv(c);
    if (state.current?.id === c.id) {
      const windowChanged = state.current.window_open !== c.window_open;
      state.current = c;
      renderChatHead();
      if (windowChanged) renderComposer();
    } else if (newInbound) {
      toast(`নতুন মেসেজ: ${c.contact_name || '+' + c.wa_id}`);
    }
  }
  renderConvList();
  if (state.current && u.messages.length) {
    let added = false;
    for (const m of u.messages) {
      if (m.conversation_id !== state.current.id) continue;
      const i = state.messages.findIndex((x) => x.id === m.id);
      if (i >= 0) state.messages[i] = m; else { state.messages.push(m); added = true; }
    }
    state.messages.sort((a, b) => a.id - b.id);
    renderMessages(added);
    if (added && u.messages.some((m) => m.direction === 'in') && document.visibilityState === 'visible') markRead(state.current.id);
  }
}

function matchesFilters(c) {
  if (state.status && c.status !== state.status) return false;
  if (state.filter === 'mine' && c.assigned_to !== state.me.id) return false;
  if (state.filter === 'unassigned' && c.assigned_to != null) return false;
  if (state.numberFilter && c.number_id !== Number(state.numberFilter)) return false;
  if (state.labelFilter && !(c.label_ids || []).includes(Number(state.labelFilter))) return false;
  if (!c.last_message_ms && !state.labelFilter && !state.q) return false;
  if (state.q) {
    const q = state.q.toLowerCase();
    if (!(c.contact_name || '').toLowerCase().includes(q) && !c.wa_id.includes(q)) return false;
  }
  return true;
}

function upsertConv(conv) {
  const i = state.convs.findIndex((c) => c.id === conv.id);
  if (i >= 0) state.convs.splice(i, 1);
  if (matchesFilters(conv) || state.current?.id === conv.id) state.convs.unshift(conv);
  state.convs.sort((a, b) => (b.last_message_ms || b.created_ms) - (a.last_message_ms || a.created_ms));
  renderConvList();
}

// ---------- inbox ----------
async function pageInbox(convId) {
  if (!state.labels.length) await loadLabels();
  $('#main').innerHTML = `
  <div class="inbox" id="inbox">
    <section class="convlist">
      <div class="head">
        <div class="row" style="gap:8px">
          <input id="search" placeholder="নাম বা নাম্বার খুঁজুন…" value="${esc(state.q)}" style="flex:1">
          <button class="btn sm" id="newChat" title="নতুন চ্যাট">＋</button>
        </div>
        <div class="filters">
          ${[['all', 'সব'], ['mine', 'আমার'], ['unassigned', 'অ্যাসাইন হয়নি']].map(([k, l]) =>
            `<button class="chip ${state.filter === k ? 'on' : ''}" data-filter="${k}">${l}</button>`).join('')}
          <select id="statusSel" style="width:auto;padding:3px 8px;font-size:13px;border-radius:14px">
            <option value="open" ${state.status === 'open' ? 'selected' : ''}>চলমান</option>
            <option value="closed" ${state.status === 'closed' ? 'selected' : ''}>বন্ধ</option>
            <option value="" ${state.status === '' ? 'selected' : ''}>সব স্ট্যাটাস</option>
          </select>
          ${multiNumber() ? `<select id="numberSel" class="mini-sel"><option value="">📞 সব নাম্বার</option>
            ${state.numbers.map((n) => `<option value="${n.id}" ${String(n.id) === String(state.numberFilter) ? 'selected' : ''}>📞 ${esc(n.label)}</option>`).join('')}</select>` : ''}
          <select id="labelSel" class="mini-sel">${labelFilterOptions()}</select>
        </div>
      </div>
      <div id="pushBanner"></div>
      <div class="convs" id="convs"></div>
    </section>
    <section class="chat" id="chat"></section>
  </div>`;
  let searchTimer;
  $('#search').oninput = (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadConvs(); }, 250); };
  $$('[data-filter]').forEach((b) => (b.onclick = () => { state.filter = b.dataset.filter; pageInbox(state.current?.id); }));
  $('#statusSel').onchange = (e) => { state.status = e.target.value; loadConvs(); };
  $('#numberSel')?.addEventListener('change', (e) => { state.numberFilter = e.target.value; loadConvs(); });
  $('#labelSel').onchange = (e) => { state.labelFilter = e.target.value; loadConvs(); };
  $('#newChat').onclick = newChatModal;
  renderAppTools();
  if (!state.users.length) state.users = await api('/users').catch(() => []);
  await loadConvs();
  if (convId) openConv(Number(convId)); else renderChat();
}

async function loadConvs() {
  const qs = new URLSearchParams({ status: state.status, filter: state.filter, q: state.q, number: state.numberFilter, label: state.labelFilter });
  state.convs = await api('/conversations?' + qs);
  renderConvList();
}

function renderConvList() {
  updateUnreadBadge();
  const box = $('#convs');
  if (!box) return;
  if (!state.convs.length) {
    box.innerHTML = '<div class="empty">কোনো কথোপকথন নেই।<br>গ্রাহক মেসেজ দিলে এখানে দেখাবে।</div>';
    return;
  }
  box.innerHTML = state.convs.map((c) => `
    <div class="conv ${state.current?.id === c.id ? 'active' : ''}" data-id="${c.id}">
      <div class="avatar" style="background:${avatarColor(c.wa_id)}">${esc(initials(c.contact_name || c.wa_id.slice(-2)))}</div>
      <div class="meta">
        <div class="top"><span class="name">${esc(c.contact_name || '+' + c.wa_id)}</span><span class="time">${timeLabel(c.last_message_ms)}</span></div>
        <div class="bottom"><span class="preview">${esc(c.last_message_preview || '')}</span>${c.unread ? `<span class="unread">${c.unread}</span>` : ''}</div>
        <div class="assignee">${multiNumber() ? `<span class="numtag">📞 ${esc(c.number_label)}</span>` : ''}${c.assigned_name ? '👤 ' + esc(c.assigned_name) : ''}${c.status === 'closed' ? ' · বন্ধ' : ''}</div>
        ${c.label_ids?.length ? `<div class="lbls">${labelChips(c.label_ids)}</div>` : ''}
      </div>
    </div>`).join('');
  $$('.conv', box).forEach((el) => (el.onclick = () => { location.hash = `#/inbox/${el.dataset.id}`; }));
}

async function openConv(id) {
  try {
    const data = await api(`/conversations/${id}/messages`);
    state.current = data.conversation;
    state.messages = data.messages;
    renderChat();
    renderConvList();
    if (data.conversation.unread) markRead(id);
  } catch (err) {
    toast(err.message, true);
    location.hash = '#/inbox';
  }
}

async function markRead(id) {
  await api(`/conversations/${id}/read`, { method: 'POST', body: {} }).catch(() => {});
  poll();
}

function renderChat() {
  const chat = $('#chat');
  if (!chat) return;
  $('#inbox').classList.toggle('has-chat', !!state.current);
  if (!state.current) {
    chat.innerHTML = `<div class="empty" style="margin:auto">
      <div style="font-size:48px">💬</div>
      ${state.workspace.connected ? 'বাম পাশ থেকে একটি চ্যাট খুলুন' : `WhatsApp এখনো কানেক্ট করা হয়নি।<br>${isManager() ? '<a href="#/settings">সেটিংস থেকে কানেক্ট করুন</a>' : 'অ্যাডমিনকে সেটিংস করতে বলুন।'}`}
    </div>`;
    return;
  }
  chat.innerHTML = `
    <div class="head" id="chatHead"></div>
    <div class="msgs" id="msgs"></div>
    <div class="composer" id="composer"></div>`;
  renderChatHead();
  renderMessages(true);
  renderComposer();
}

function renderChatHead() {
  const c = state.current;
  const head = $('#chatHead');
  if (!head || !c) return;
  const canTake = (u) => u.active && (u.role === 'owner' || (u.number_ids || []).includes(c.number_id));
  const assignable = isManager() ? state.users.filter(canTake) : state.users.filter((u) => u.id === state.me.id);
  head.innerHTML = `
    <button class="btn ghost sm back" id="backBtn">←</button>
    <div class="avatar" style="background:${avatarColor(c.wa_id)}">${esc(initials(c.contact_name || c.wa_id.slice(-2)))}</div>
    <div class="who"><b>${esc(c.contact_name || '+' + c.wa_id)}</b><span>+${esc(c.wa_id)}${multiNumber() ? ` · 📞 ${esc(c.number_label)}` : ''} ${c.window_open ? '· 🟢 ২৪ ঘণ্টার উইন্ডো খোলা' : '· ⏳ শুধু টেমপ্লেট'}</span>
      <div class="lbls">${labelChips(c.label_ids)}${c.opted_out ? '<span class="lbl" style="--c:#6b7280">🚫 ব্রডকাস্ট বন্ধ (STOP)</span>' : ''}</div></div>
    <button class="btn ghost sm" id="labelBtn" title="লেবেল" aria-label="লেবেল">🏷️<span class="hide-sm"> লেবেল</span></button>
    <button class="btn ghost sm" id="notesBtn" title="নোট" aria-label="নোট">📝<span class="hide-sm"> নোট</span>${c.note_count ? ` (${c.note_count})` : ''}</button>
    <select id="assignSel" title="অ্যাসাইন">
      <option value="">— অ্যাসাইন হয়নি —</option>
      ${assignable.map((u) => `<option value="${u.id}" ${c.assigned_to === u.id ? 'selected' : ''}>👤 ${esc(u.name)}</option>`).join('')}
      ${c.assigned_to && !assignable.some((u) => u.id === c.assigned_to) ? `<option selected disabled>👤 ${esc(c.assigned_name)}</option>` : ''}
    </select>
    <button class="btn ghost sm" id="renameBtn" title="নাম পরিবর্তন">✏️</button>
    <button class="btn ${c.status === 'open' ? 'ghost' : ''} sm" id="statusBtn" title="${c.status === 'open' ? 'বন্ধ করুন' : 'আবার খুলুন'}">${c.status === 'open' ? '✔<span class="hide-sm"> বন্ধ করুন</span>' : '↺<span class="hide-sm"> আবার খুলুন</span>'}</button>`;
  $('#backBtn').onclick = () => { state.current = null; location.hash = '#/inbox'; };
  $('#assignSel').onchange = (e) => patchConv({ assigned_to: e.target.value ? Number(e.target.value) : null });
  $('#statusBtn').onclick = () => patchConv({ status: c.status === 'open' ? 'closed' : 'open' });
  $('#labelBtn').onclick = labelPicker;
  $('#notesBtn').onclick = notesModal;
  $('#renameBtn').onclick = () => {
    const name = prompt('গ্রাহকের নাম', c.contact_name || '');
    if (name !== null) patchConv({ contact_name: name });
  };
}

async function patchConv(body) {
  try {
    const updated = await api(`/conversations/${state.current.id}`, { method: 'PATCH', body });
    state.current = updated;
    upsertConv(updated);
    renderChatHead();
    renderComposer();
  } catch (err) { toast(err.message, true); renderChatHead(); }
}

const TICKS = { pending: '🕓', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠' };

function renderMessages(scroll) {
  const box = $('#msgs');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  let lastDay = '';
  box.innerHTML = state.messages.map((m) => {
    const d = parseTime(m.created_ms);
    const day = d.toLocaleDateString('bn-BD', { day: 'numeric', month: 'long', year: 'numeric' });
    const sep = day !== lastDay ? `<div class="daysep">${day}</div>` : '';
    lastDay = day;
    const media = m.media_id && ['image', 'sticker'].includes(m.type)
      ? `<img src="/api/media/${encodeURIComponent(m.media_id)}" alt="ছবি" loading="lazy">`
      : m.media_id ? `<a href="/api/media/${encodeURIComponent(m.media_id)}" target="_blank" rel="noopener">📎 ${esc(m.type)} ডাউনলোড</a>` : '';
    return `${sep}<div class="bubble ${m.direction}">
      ${m.direction === 'out' && m.sent_by_name ? `<div class="by">${esc(m.sent_by_name)}</div>` : ''}
      ${m.type === 'template' ? '<div class="tag">📋 টেমপ্লেট</div>' : ''}
      ${media}${m.body ? `<div class="text">${esc(m.body)}</div>` : ''}
      ${m.error ? `<div class="fail">⚠ ${esc(m.error)}</div>` : ''}
      <div class="foot">${d.toLocaleTimeString('bn-BD', { hour: 'numeric', minute: '2-digit' })}
        ${m.direction === 'out' ? `<span class="tick ${m.status}">${TICKS[m.status] || ''}</span>` : ''}</div>
    </div>`;
  }).join('') || '<div class="empty">এখনো কোনো মেসেজ নেই। টেমপ্লেট পাঠিয়ে কথোপকথন শুরু করুন।</div>';
  if (scroll || nearBottom) box.scrollTop = box.scrollHeight;
}

function renderComposer() {
  const c = state.current;
  const box = $('#composer');
  if (!box || !c) return;
  box.innerHTML = `
    ${!c.window_open ? '<div class="banner">⏳ গ্রাহক গত ২৪ ঘণ্টায় কোনো মেসেজ দেননি। WhatsApp-এর নিয়ম অনুযায়ী এখন শুধু অনুমোদিত <b>টেমপ্লেট</b> পাঠানো যাবে।</div>' : ''}
    <div class="tools">
      <button class="btn ghost sm" id="qrBtn">⚡ কুইক রিপ্লাই</button>
      <button class="btn ghost sm" id="tplBtn">📋 টেমপ্লেট পাঠান</button>
    </div>
    <div id="qrPop"></div>
    <form class="bar" id="sendForm">
      <textarea id="msgInput" rows="1" placeholder="${c.window_open ? 'মেসেজ লিখুন…' : 'টেমপ্লেট ব্যবহার করুন'}" ${c.window_open ? '' : 'disabled'}></textarea>
      <button class="btn" type="submit" ${c.window_open ? '' : 'disabled'}>পাঠান</button>
    </form>`;
  const input = $('#msgInput');
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#sendForm').requestSubmit(); }
  });
  $('#sendForm').onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const btn = $('button', e.target);
    btn.disabled = true;
    try {
      const msg = await api(`/conversations/${c.id}/messages`, { method: 'POST', body: { text } });
      input.value = '';
      input.style.height = 'auto';
      if (!state.messages.some((m) => m.id === msg.id)) { state.messages.push(msg); renderMessages(true); }
      poll();
    } catch (err) {
      toast(err.message, true);
      poll();
      if (err.data?.message && !state.messages.some((m) => m.id === err.data.message.id)) { state.messages.push(err.data.message); renderMessages(true); }
    } finally { btn.disabled = false; input.focus(); }
  };
  $('#qrBtn').onclick = async () => {
    const pop = $('#qrPop');
    if (pop.innerHTML) { pop.innerHTML = ''; return; }
    state.quickReplies = await api('/quick-replies');
    pop.innerHTML = `<div class="qr-pop">${state.quickReplies.map((q) => `<div data-qr="${q.id}"><b>${esc(q.title)}</b> — ${esc(q.body.slice(0, 70))}</div>`).join('')
      || `<div>কোনো কুইক রিপ্লাই নেই। ${isManager() ? '<a href="#/quick">যোগ করুন</a>' : ''}</div>`}</div>`;
    $$('[data-qr]', pop).forEach((el) => (el.onclick = () => {
      const q = state.quickReplies.find((x) => x.id === Number(el.dataset.qr));
      input.value = q.body;
      input.dispatchEvent(new Event('input'));
      pop.innerHTML = '';
      input.focus();
    }));
  };
  $('#tplBtn').onclick = templateModal;
}

async function templateModal() {
  const c = state.current;
  let templates;
  try { templates = await api(`/conversations/${c.id}/templates`); } catch (err) { return toast(err.message, true); }
  if (!templates.length) return toast('কোনো অনুমোদিত টেমপ্লেট পাওয়া যায়নি। Meta WhatsApp Manager থেকে টেমপ্লেট তৈরি করুন।', true);
  const bodyOf = (t) => (t.components || []).find((x) => x.type === 'BODY')?.text || '';
  modal(`
    <h3>📋 টেমপ্লেট মেসেজ পাঠান</h3>
    <div class="hint">প্রাপক: ${esc(c.contact_name || '+' + c.wa_id)}</div>
    <form id="tplForm">
      <label>টেমপ্লেট</label>
      <select name="tpl">${templates.map((t, i) => `<option value="${i}">${esc(t.name)} (${esc(t.language)}) — ${esc(t.category)}</option>`).join('')}</select>
      <div id="tplParams"></div>
      <label>প্রিভিউ</label>
      <div class="card" id="tplPreview" style="white-space:pre-wrap;margin:0"></div>
      <div class="actions"><button type="button" class="btn ghost" data-close>বাতিল</button><button class="btn" type="submit">পাঠান</button></div>
    </form>`, (bg, close) => {
    const form = $('#tplForm', bg);
    const sel = form.tpl;
    const preview = () => {
      const t = templates[sel.value];
      let text = bodyOf(t);
      $$('[data-param]', bg).forEach((inp) => { text = text.split(`{{${inp.dataset.param}}}`).join(inp.value || `{{${inp.dataset.param}}}`); });
      $('#tplPreview', bg).textContent = text || `(${t.name})`;
      return text;
    };
    const renderParams = () => {
      const t = templates[sel.value];
      const nums = [...new Set([...bodyOf(t).matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
      $('#tplParams', bg).innerHTML = nums.map((n) => `<label>ভ্যারিয়েবল {{${n}}}</label><input data-param="${n}" required>`).join('');
      $$('[data-param]', bg).forEach((i) => (i.oninput = preview));
      preview();
    };
    sel.onchange = renderParams;
    renderParams();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const t = templates[sel.value];
      const params = $$('[data-param]', bg).map((i) => i.value);
      try {
        const msg = await api(`/conversations/${c.id}/template`, { method: 'POST', body: { name: t.name, language: t.language, params, preview: preview() } });
        if (!state.messages.some((m) => m.id === msg.id)) { state.messages.push(msg); renderMessages(true); }
        close();
        toast('টেমপ্লেট পাঠানো হয়েছে');
      } catch (err) { toast(err.message, true); }
    };
  });
}

function labelPicker() {
  const c = state.current;
  const render = (bg) => {
    $('#lpList', bg).innerHTML = state.labels.map((l) => `<label class="lp-row">
      <input type="checkbox" value="${l.id}" ${(c.label_ids || []).includes(l.id) ? 'checked' : ''} style="width:auto">
      <span class="lbl" style="--c:${esc(l.color)}">${esc(l.name)}</span></label>`).join('') || '<div class="hint">এখনো কোনো লেবেল নেই</div>';
  };
  modal(`<h3>🏷️ লেবেল</h3>
    <div class="hint">${esc(c.contact_name || '+' + c.wa_id)} — এক বা একাধিক লেবেল বাছাই করুন</div>
    <div id="lpList" class="lp-list"></div>
    <details class="lp-new"><summary>＋ নতুন লেবেল বানান</summary>
      <div class="row" style="margin-top:8px;flex-wrap:nowrap"><input id="lpName" maxlength="40" placeholder="যেমন: ক্লাস ৫ / অভিভাবক">
      <button type="button" class="btn sm" id="lpAdd">যোগ</button></div>
      <div class="swatches" id="lpColors">${LABEL_COLORS.map((col, i) => `<button type="button" class="sw ${i === 0 ? 'on' : ''}" data-color="${col}" style="--c:${col}" aria-label="${col}"></button>`).join('')}</div>
    </details>
    <div class="actions"><button type="button" class="btn ghost" data-close>বাতিল</button><button class="btn" id="lpSave">সেভ</button></div>`, (bg, close) => {
    render(bg);
    let color = LABEL_COLORS[0];
    $$('#lpColors .sw', bg).forEach((b) => (b.onclick = () => { color = b.dataset.color; $$('#lpColors .sw', bg).forEach((x) => x.classList.toggle('on', x === b)); }));
    $('#lpAdd', bg).onclick = async () => {
      const name = $('#lpName', bg).value.trim();
      if (!name) return;
      try {
        const checked = $$('#lpList input:checked', bg).map((i) => Number(i.value));
        const label = await api('/labels', { method: 'POST', body: { name, color } });
        state.labels.push(label);
        if ($('#labelSel')) $('#labelSel').innerHTML = labelFilterOptions();
        c.label_ids = [...checked, label.id];
        $('#lpName', bg).value = '';
        render(bg);
      } catch (err) { toast(err.message, true); }
    };
    $('#lpSave', bg).onclick = async () => {
      const ids = $$('#lpList input:checked', bg).map((i) => Number(i.value));
      try {
        const updated = await api(`/conversations/${c.id}/labels`, { method: 'PUT', body: { label_ids: ids } });
        state.current = updated;
        upsertConv(updated);
        renderChatHead();
        close();
      } catch (err) { toast(err.message, true); }
    };
  });
}

async function notesModal() {
  const c = state.current;
  const close = modal(`<h3>📝 নোট</h3>
    <div class="hint">${esc(c.contact_name || '+' + c.wa_id)} — শুধু টিমের সদস্যরা দেখবেন, গ্রাহক নয়।</div>
    <form id="noteForm" class="row" style="margin-top:10px;flex-wrap:nowrap;align-items:flex-end">
      <textarea name="body" rows="2" required placeholder="যেমন: বাবা সন্ধ্যায় ফোন করবেন, ৫ম শ্রেণিতে ভর্তি করাতে চান"></textarea>
      <button class="btn">যোগ</button></form>
    <div id="noteList" class="note-list"></div>
    <div class="actions"><button type="button" class="btn ghost" data-close>বন্ধ</button></div>`);
  const load = async () => {
    const notes = await api(`/conversations/${c.id}/notes`).catch(() => []);
    const box = $('#noteList');
    if (!box) return;
    box.innerHTML = notes.map((n) => `<div class="note"><div class="text">${esc(n.body)}</div>
      <div class="hint">${esc(n.user_name || '—')} · ${parseTime(n.created_ms).toLocaleString('bn-BD')}
      ${n.user_id === state.me.id || isManager() ? ` · <a href="#" data-del-note="${n.id}">মুছুন</a>` : ''}</div></div>`).join('')
      || '<div class="hint" style="margin-top:10px">এখনো কোনো নোট নেই</div>';
    $$('[data-del-note]', box).forEach((a) => (a.onclick = async (e) => {
      e.preventDefault();
      await api(`/notes/${a.dataset.delNote}`, { method: 'DELETE', body: {} }).catch((err) => toast(err.message, true));
      load(); poll();
    }));
  };
  $('#noteForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/conversations/${c.id}/notes`, { method: 'POST', body: formData(e.target) }); e.target.reset(); load(); poll(); } catch (err) { toast(err.message, true); }
  };
  load();
  return close;
}

function newChatModal() {
  modal(`
    <h3>নতুন চ্যাট শুরু করুন</h3>
    <div class="hint">নতুন গ্রাহককে প্রথম মেসেজ হিসেবে শুধু অনুমোদিত টেমপ্লেট পাঠানো যায়।</div>
    <form id="ncForm">
      <label>WhatsApp নাম্বার (দেশের কোডসহ)</label><input name="phone" required placeholder="8801XXXXXXXXX" inputmode="tel">
      <label>নাম (ঐচ্ছিক)</label><input name="name" maxlength="120">
      ${multiNumber() ? `<label>কোন নাম্বার থেকে</label><select name="number_id">${state.numbers.map((n) => `<option value="${n.id}">${esc(n.label)}</option>`).join('')}</select>` : ''}
      <div class="actions"><button type="button" class="btn ghost" data-close>বাতিল</button><button class="btn" type="submit">চ্যাট খুলুন</button></div>
    </form>`, (bg, close) => {
    $('#ncForm', bg).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const conv = await api('/conversations', { method: 'POST', body: formData(e.target) });
        close();
        state.status = '';
        location.hash = `#/inbox/${conv.id}`;
      } catch (err) { toast(err.message, true); }
    };
  });
}

// ---------- dashboard ----------
async function pageDashboard() {
  const s = await api('/stats?dayStart=' + new Date().setHours(0, 0, 0, 0));
  $('#main').innerHTML = `<div class="page">
    <h2>📊 ড্যাশবোর্ড</h2>
    ${!state.workspace.connected ? `<div class="banner">⚠ WhatsApp এখনো কানেক্ট করা হয়নি। ${isManager() ? '<a href="#/settings">এখনই কানেক্ট করুন →</a>' : ''}</div>` : ''}
    <div class="stats">
      ${[['open', 'চলমান চ্যাট'], ['unassigned', 'অ্যাসাইন হয়নি'], ['unread', 'অপঠিত মেসেজ'], ['contacts', 'মোট কন্টাক্ট'], ['inbound_today', 'আজ এসেছে'], ['outbound_today', 'আজ পাঠানো']]
        .map(([k, l]) => `<div class="stat"><div class="n">${s[k].toLocaleString('bn-BD')}</div><div class="l">${l}</div></div>`).join('')}
    </div>
    <div class="card"><h3>টিমের পারফরম্যান্স (আজ)</h3>
      <table><thead><tr><th>নাম</th><th>রোল</th><th>চলমান চ্যাট</th><th>আজ পাঠিয়েছে</th></tr></thead><tbody>
      ${s.per_agent.map((u) => `<tr><td>${esc(u.name)}</td><td><span class="pill ${u.role}">${ROLE_BN[u.role]}</span></td><td>${u.open_chats}</td><td>${u.sent_today}</td></tr>`).join('')}
      </tbody></table>
    </div>
  </div>`;
}

// ---------- team ----------
async function pageTeam() {
  state.users = await api('/users');
  const me = state.me;
  const canManage = (u) => u.id !== me.id && (me.role === 'owner' ? u.role !== 'owner' : me.role === 'admin' && u.role === 'agent');
  $('#main').innerHTML = `<div class="page">
    <div class="row" style="justify-content:space-between;margin-bottom:16px">
      <h2 style="margin:0">👥 টিম / অ্যাডমিন</h2>
      ${isManager() ? '<button class="btn" id="addUser">＋ নতুন সদস্য যোগ করুন</button>' : ''}
    </div>
    <div class="card">
      <div class="hint" style="margin-bottom:10px">
        <b>মালিক</b> — সব নাম্বার ও সব কিছু · <b>অ্যাডমিন</b> — নিজের নাম্বারগুলোর সব চ্যাট, এজেন্ট যোগ/বাদ · <b>এজেন্ট</b> — নিজের নাম্বারগুলোর নিজের ও অ্যাসাইন-না-হওয়া চ্যাট
      </div>
      <table><thead><tr><th>নাম</th><th class="hide-sm">ইমেইল</th><th>রোল</th>${multiNumber() ? '<th class="hide-sm">নাম্বার</th>' : ''}<th class="hide-sm">শেষ লগইন</th><th></th></tr></thead><tbody>
      ${state.users.map((u) => `<tr>
        <td>${esc(u.name)}${u.id === me.id ? ' <span class="hint">(আপনি)</span>' : ''}</td>
        <td class="hide-sm">${esc(u.email)}</td>
        <td><span class="pill ${u.role}">${ROLE_BN[u.role]}</span> ${u.active ? '' : '<span class="pill off">নিষ্ক্রিয়</span>'}</td>
        ${multiNumber() ? `<td class="hide-sm hint">${u.role === 'owner' ? 'সব নাম্বার' : u.number_ids.map(numberName).filter(Boolean).map(esc).join(', ') || '—'}</td>` : ''}
        <td class="hide-sm">${u.last_login_ms ? timeLabel(u.last_login_ms) : '—'}</td>
        <td style="text-align:right">${canManage(u) ? `<button class="btn ghost sm" data-edit="${u.id}">সম্পাদনা</button>` : ''}</td>
      </tr>`).join('')}
      </tbody></table>
    </div></div>`;
  // Which numbers a member works on (owners always see all). Admins can only hand out their own numbers.
  const numberBoxes = (selected) => multiNumber() ? `<label>কোন কোন নাম্বারে কাজ করবেন</label><div class="checks">
    ${state.numbers.map((n) => `<label><input type="checkbox" name="number_ids" value="${n.id}" ${selected.includes(n.id) ? 'checked' : ''} style="width:auto"> ${esc(n.label)}</label>`).join('')}</div>` : '';
  const checkedNumbers = (form) => $$('input[name=number_ids]:checked', form).map((i) => Number(i.value));
  const roleOptions = (current) => (me.role === 'owner' ? ['admin', 'agent'] : ['agent'])
    .map((r) => `<option value="${r}" ${r === current ? 'selected' : ''}>${ROLE_BN[r]}</option>`).join('');
  $('#addUser')?.addEventListener('click', () => modal(`
    <h3>নতুন সদস্য যোগ করুন</h3>
    <div class="hint">সদস্য এই ইমেইল ও পাসওয়ার্ড দিয়ে লগইন করবেন। পাসওয়ার্ড তাকে নিরাপদে জানিয়ে দিন।</div>
    <form id="uForm">
      <label>নাম</label><input name="name" required maxlength="120">
      <label>ইমেইল</label><input name="email" type="email" required>
      <label>রোল</label><select name="role">${roleOptions('agent')}</select>
      <label>পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর)</label><input name="password" type="text" required minlength="8" value="${esc(randomPassword())}">
      ${numberBoxes(state.numbers.map((n) => n.id))}
      <div class="actions"><button type="button" class="btn ghost" data-close>বাতিল</button><button class="btn" type="submit">যোগ করুন</button></div>
    </form>`, (bg, close) => {
    $('#uForm', bg).onsubmit = async (e) => {
      e.preventDefault();
      const body = formData(e.target);
      if (multiNumber()) body.number_ids = checkedNumbers(e.target);
      try { await api('/users', { method: 'POST', body }); close(); toast('সদস্য যোগ হয়েছে'); pageTeam(); } catch (err) { toast(err.message, true); }
    };
  }));
  $$('[data-edit]').forEach((b) => (b.onclick = () => {
    const u = state.users.find((x) => x.id === Number(b.dataset.edit));
    modal(`
      <h3>${esc(u.name)}</h3><div class="hint">${esc(u.email)}</div>
      <form id="eForm">
        <label>নাম</label><input name="name" required value="${esc(u.name)}">
        <label>রোল</label><select name="role">${roleOptions(u.role)}</select>
        <label>নতুন পাসওয়ার্ড (খালি রাখলে আগেরটাই থাকবে)</label><input name="password" type="text" minlength="8">
        ${numberBoxes(u.number_ids)}
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" ${u.active ? 'checked' : ''} style="width:auto"> সক্রিয় (লগইন করতে পারবে)</label>
        <div class="actions" style="justify-content:space-between">
          <button type="button" class="btn danger" id="delUser">মুছে ফেলুন</button>
          <span><button type="button" class="btn ghost" data-close>বাতিল</button> <button class="btn" type="submit">সেভ</button></span>
        </div>
      </form>`, (bg, close) => {
      $('#eForm', bg).onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target;
        const body = { name: f.name.value, role: f.role.value, active: f.active.checked };
        if (f.password.value) body.password = f.password.value;
        if (multiNumber()) body.number_ids = checkedNumbers(f);
        try { await api(`/users/${u.id}`, { method: 'PATCH', body }); close(); toast('সেভ হয়েছে'); pageTeam(); } catch (err) { toast(err.message, true); }
      };
      $('#delUser', bg).onclick = async () => {
        if (!confirm(`${u.name} কে টিম থেকে মুছে ফেলবেন?`)) return;
        try { await api(`/users/${u.id}`, { method: 'DELETE', body: {} }); close(); toast('মুছে ফেলা হয়েছে'); pageTeam(); } catch (err) { toast(err.message, true); }
      };
    });
  }));
}

function randomPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint32Array(12))].map((n) => chars[n % chars.length]).join('');
}

// ---------- quick replies ----------
async function pageQuick() {
  const list = await api('/quick-replies');
  $('#main').innerHTML = `<div class="page">
    <h2>⚡ কুইক রিপ্লাই</h2>
    ${isManager() ? `<div class="card"><h3>নতুন কুইক রিপ্লাই</h3>
      <form id="qForm"><label>শিরোনাম</label><input name="title" required maxlength="80" placeholder="যেমন: অফিস টাইম">
      <label>মেসেজ</label><textarea name="body" required rows="3"></textarea>
      <button class="btn" style="margin-top:10px">যোগ করুন</button></form></div>` : ''}
    <div class="card">${list.map((q) => `<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--border);padding:10px 0;flex-wrap:nowrap">
      <div style="min-width:0"><b>${esc(q.title)}</b><div class="hint" style="white-space:pre-wrap">${esc(q.body)}</div></div>
      ${isManager() ? `<button class="btn ghost sm" data-del="${q.id}">মুছুন</button>` : ''}</div>`).join('') || '<div class="empty">এখনো কোনো কুইক রিপ্লাই নেই</div>'}</div>
  </div>`;
  $('#qForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/quick-replies', { method: 'POST', body: formData(e.target) }); pageQuick(); } catch (err) { toast(err.message, true); }
  });
  $$('[data-del]').forEach((b) => (b.onclick = async () => { await api(`/quick-replies/${b.dataset.del}`, { method: 'DELETE', body: {} }); pageQuick(); }));
}

// ---------- WhatsApp numbers (connect each number; who works on it is set on the Team page) ----------
async function pageSettings(arg) {
  await refreshMe();
  const numbers = state.numbers;
  const current = numbers.find((n) => String(n.id) === String(arg)) || numbers[0];
  const done = (ok) => (ok ? '<span class="pill agent">✓ হয়েছে</span>' : '<span class="pill off">বাকি</span>');
  const copyRow = (label, value) => `<label>${label}</label>
    <div class="row" style="flex-wrap:nowrap"><code style="flex:1;padding:9px 11px">${esc(value)}</code>
    <button type="button" class="btn ghost sm" data-copy="${esc(value)}">📋 কপি</button></div>`;
  const s = current ? await api(`/numbers/${current.id}`) : null;
  $('#main').innerHTML = `<div class="page">
    <h2>📞 WhatsApp নাম্বার</h2>
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h3 style="margin:0">আপনার নাম্বারগুলো</h3>
        <button class="btn sm" id="addNumber">＋ নতুন নাম্বার যোগ করুন</button>
      </div>
      <div class="hint" style="margin:6px 0 10px">প্রতিটি নাম্বারে কোন অ্যাডমিন/এজেন্ট কাজ করবেন তা <a href="#/team">টিম</a> পেজ থেকে ঠিক করুন।</div>
      <div class="num-list">${numbers.map((n) => `<a class="num ${n.id === current?.id ? 'on' : ''}" href="#/settings/${n.id}">
        <b>📞 ${esc(n.label)}</b><span>${n.display_phone ? esc(n.display_phone) : ''} ${n.connected ? '🟢 কানেক্টেড' : '⚪ কানেক্ট হয়নি'}</span></a>`).join('')}</div>
    </div>
    ${s ? `
    <div class="banner">নিচের ধাপগুলো <b>"${esc(s.label)}"</b> নাম্বারের জন্য। প্রতিটি নাম্বারে একবারই করতে হবে। আটকে গেলে স্ক্রিনশট নিয়ে সাহায্য চাইতে পারেন।</div>
    <div class="card">
      <h3>ধাপ ১ — Meta-তে নাম্বার যোগ করুন ${done(s.wa_phone_number_id)}</h3>
      <ol class="steps hint">
        <li><a href="https://developers.facebook.com/apps/creation/" target="_blank" rel="noopener"><b>developers.facebook.com</b></a> এ লগইন করুন। প্রথমবার হলে <b>Create App</b> → use case <b>"Connect with customers through WhatsApp"</b> → <b>Create app</b>। (পরের নাম্বারগুলোর জন্য একই অ্যাপ ব্যবহার করতে পারেন।)</li>
        <li>বাম পাশে <b>WhatsApp → API Setup</b> খুলুন। নতুন নাম্বার হলে <b>Add phone number</b> দিয়ে যোগ করুন, অথবা Meta-র ফ্রি <b>টেস্ট নাম্বার</b> ব্যবহার করুন।</li>
        <li>টেস্ট নাম্বারে মেসেজ পাঠাতে <b>"To"</b> অংশে নিজের মোবাইল নাম্বার যোগ করুন।</li>
        <li>এই নাম্বারের <b>Phone number ID</b>, <b>WhatsApp Business Account ID</b> আর <b>Generate access token</b> চেপে পাওয়া টোকেন নিচে বসান।</li>
      </ol>
      <form id="sForm">
        <label>নাম্বারের নাম (টিম যেন চিনতে পারে)</label><input name="label" value="${esc(s.label)}" required maxlength="60" placeholder="যেমন: ভর্তি বিভাগ / হিফজ বিভাগ">
        <div class="grid2">
          <div><label>Phone number ID</label><input name="wa_phone_number_id" value="${esc(s.wa_phone_number_id)}" inputmode="numeric" placeholder="যেমন 1234567890123456"></div>
          <div><label>WhatsApp Business Account ID</label><input name="wa_business_account_id" value="${esc(s.wa_business_account_id)}" inputmode="numeric"></div>
        </div>
        <label>Access token</label>
        <input name="wa_access_token" type="password" autocomplete="off" placeholder="${s.token_set ? 'সেভ করা আছে ' + esc(s.token_hint) + ' — বদলাতে নতুন টোকেন পেস্ট করুন' : 'EAAG… দিয়ে শুরু হওয়া লম্বা লেখা'}">
        <label>App secret (ধাপ ৩ এ পাবেন)</label>
        <input name="wa_app_secret" type="password" autocomplete="off" placeholder="${s.app_secret_set ? 'সেভ করা আছে — বদলাতে নতুনটি দিন' : 'ঐচ্ছিক, কিন্তু নিরাপত্তার জন্য দিন'}">
        <div class="row" style="margin-top:14px">
          <button class="btn">সেভ করুন</button>
          <button type="button" class="btn ghost" id="testBtn">🔌 কানেকশন টেস্ট</button>
          ${state.me.role === 'owner' && numbers.length > 1 ? '<button type="button" class="btn danger sm" id="delNumber" style="margin-left:auto">নাম্বারটি মুছুন</button>' : ''}
        </div>
        <div id="testResult" class="hint" style="margin-top:8px"></div>
      </form>
    </div>

    <div class="card">
      <h3>ধাপ ২ — মেসেজ আসার রাস্তা (Webhook) চালু করুন</h3>
      <ol class="steps hint">
        <li>Meta-তে বাম পাশে <b>WhatsApp → Configuration</b> খুলুন।</li>
        <li><b>Webhook</b> অংশে <b>Edit</b> চাপুন, নিচের দুটি জিনিস কপি করে বসান, তারপর <b>Verify and save</b>।</li>
        <li>নিচে <b>Webhook fields</b> এ <b>messages</b> এর পাশে <b>Subscribe</b> চাপুন।</li>
      </ol>
      <div class="hint">সব নাম্বারের জন্য একই Callback URL ও Verify token — একই Meta অ্যাপে একবার সেট করলেই হবে।</div>
      ${copyRow('Callback URL', s.webhook_url)}
      ${copyRow('Verify token', s.verify_token)}
    </div>

    <div class="card">
      <h3>ধাপ ৩ — App secret ${done(s.app_secret_set)}</h3>
      <div class="hint">Meta-তে বাম পাশে <b>App settings → Basic</b> খুলুন → <b>App secret</b> এর পাশে <b>Show</b> চাপুন → কপি করে ধাপ ১ এর "App secret" ঘরে বসিয়ে সেভ করুন।</div>
    </div>

    <div class="card">
      <h3>ধাপ ৪ — স্থায়ী টোকেন (২৪ ঘণ্টা পর পর টোকেন বদলানোর ঝামেলা এড়াতে)</h3>
      <ol class="steps hint">
        <li><a href="https://business.facebook.com/settings/system-users" target="_blank" rel="noopener"><b>business.facebook.com → Settings → System users</b></a> খুলুন → <b>Add</b> → যেকোনো নাম, রোল <b>Admin</b>।</li>
        <li>সেই System user এ <b>Assign assets</b> → আপনার App এবং WhatsApp account দুটোতেই <b>Full control</b> দিন।</li>
        <li><b>Generate token</b> → App বাছাই → মেয়াদ <b>Never</b> → পারমিশন <b>whatsapp_business_messaging</b> ও <b>whatsapp_business_management</b> → Generate।</li>
        <li>নতুন টোকেনটি ধাপ ১ এর "Access token" ঘরে বসিয়ে সেভ করুন।</li>
      </ol>
    </div>

    <div class="card">
      <h3>🧪 WhatsApp ছাড়াই ট্রাই করুন</h3>
      <div class="hint">"${esc(s.label)}" নাম্বারে একজন গ্রাহক মেসেজ পাঠিয়েছে এমনভাবে ইনবক্সে একটি নমুনা মেসেজ যোগ হবে।</div>
      <form id="simForm" class="grid2">
        <div><label>নাম্বার</label><input name="phone" value="8801700000000" required></div>
        <div><label>নাম</label><input name="name" value="টেস্ট গ্রাহক"></div>
        <div style="grid-column:1/-1"><label>মেসেজ</label><input name="text" value="আসসালামু আলাইকুম, কোর্সের ফি কত?" required></div>
        <div><button class="btn ghost" style="margin-top:12px">ইনবক্সে পাঠান</button></div>
      </form>
    </div>` : '<div class="card">এখনো কোনো নাম্বার নেই। উপরের বাটন দিয়ে যোগ করুন।</div>'}

    <div class="card">
      <h3>বিজনেসের নাম</h3>
      <form id="wsForm" class="row" style="flex-wrap:nowrap"><input name="name" value="${esc(state.workspace.name)}" required maxlength="120"><button class="btn">সেভ</button></form>
    </div>
  </div>`;
  $$('[data-copy]').forEach((b) => (b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('কপি হয়েছে'); } catch { toast('কপি করা যায়নি — হাতে সিলেক্ট করে কপি করুন', true); }
  }));
  $('#addNumber').onclick = () => modal(`<h3>＋ নতুন WhatsApp নাম্বার</h3>
    <div class="hint">আগে একটা নাম দিন, তারপর পরের পেজে Meta থেকে তথ্য বসাবেন।</div>
    <form id="nForm"><label>নাম্বারের নাম</label><input name="label" required maxlength="60" placeholder="যেমন: হিফজ বিভাগ">
    <div class="actions"><button type="button" class="btn ghost" data-close>বাতিল</button><button class="btn">যোগ করুন</button></div></form>`, (bg, close) => {
    $('#nForm', bg).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('/numbers', { method: 'POST', body: formData(e.target) });
        close();
        toast('নাম্বার যোগ হয়েছে — এখন Meta থেকে তথ্য বসান');
        location.hash = `#/settings/${r.id}`;
      } catch (err) { toast(err.message, true); }
    };
  });
  $('#wsForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/workspace', { method: 'PUT', body: formData(e.target) }); await refreshMe(); renderShell(); route(); toast('সেভ হয়েছে'); } catch (err) { toast(err.message, true); }
  };
  if (!s) return;
  $('#sForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/numbers/${s.id}`, { method: 'PUT', body: formData(e.target) });
      toast('সেভ হয়েছে');
      pageSettings(s.id);
    } catch (err) { toast(err.message, true); }
  };
  $('#testBtn').onclick = async () => {
    const out = $('#testResult');
    out.textContent = 'যাচাই হচ্ছে…';
    try {
      const info = await api(`/numbers/${s.id}/test`, { method: 'POST', body: {} });
      out.textContent = `✅ কানেক্টেড: ${info.verified_name || ''} ${info.display_phone_number || ''}`;
    } catch (err) { out.textContent = '❌ ' + err.message; }
  };
  $('#delNumber')?.addEventListener('click', async () => {
    const typed = prompt(`সাবধান! "${s.label}" নাম্বারের সব চ্যাট ও মেসেজ মুছে যাবে।\nনিশ্চিত হলে নাম্বারের নামটি হুবহু লিখুন:`);
    if (typed === null) return;
    if (typed.trim() !== s.label) return toast('নাম মেলেনি — কিছু মোছা হয়নি', true);
    try { await api(`/numbers/${s.id}`, { method: 'DELETE', body: {} }); toast('নাম্বার মুছে ফেলা হয়েছে'); location.hash = '#/settings'; pageSettings(); } catch (err) { toast(err.message, true); }
  });
  $('#simForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/simulate-inbound', { method: 'POST', body: { ...formData(e.target), number_id: s.id } });
      toast('ইনবক্সে মেসেজ যোগ হয়েছে');
      location.hash = `#/inbox/${r.convId}`;
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- labels ----------
async function pageLabels() {
  await loadLabels();
  $('#main').innerHTML = `<div class="page">
    <h2>🏷️ লেবেল</h2>
    <div class="card">
      <h3>নতুন লেবেল</h3>
      <div class="hint">লেবেল দিয়ে লিড/গ্রাহকদের ভাগ করুন — যেমন "নতুন লিড", "ক্লাস ৫", "পেমেন্ট বাকি"। চ্যাটের ভেতরের 🏷️ বাটন থেকেও বানানো যায়।</div>
      <form id="lForm" class="row" style="margin-top:10px;flex-wrap:nowrap"><input name="name" required maxlength="40" placeholder="লেবেলের নাম"><button class="btn">যোগ করুন</button></form>
      <div class="swatches" id="lColors">${LABEL_COLORS.map((c, i) => `<button type="button" class="sw ${i === 0 ? 'on' : ''}" data-color="${c}" style="--c:${c}" aria-label="${c}"></button>`).join('')}</div>
    </div>
    <div class="card">${state.labels.map((l) => `<div class="row lrow">
      <span class="lbl" style="--c:${esc(l.color)}">${esc(l.name)}</span>
      <a class="hint" href="#/inbox" data-filter-label="${l.id}">${l.count} টি চ্যাট →</a>
      ${isManager() ? `<span style="margin-left:auto" class="row"><button class="btn ghost sm" data-edit-label="${l.id}">সম্পাদনা</button>
        <button class="btn ghost sm" data-del-label="${l.id}">মুছুন</button></span>` : ''}</div>`).join('') || '<div class="empty">এখনো কোনো লেবেল নেই</div>'}</div>
  </div>`;
  let color = LABEL_COLORS[0];
  $$('#lColors .sw').forEach((b) => (b.onclick = () => { color = b.dataset.color; $$('#lColors .sw').forEach((x) => x.classList.toggle('on', x === b)); }));
  $('#lForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/labels', { method: 'POST', body: { name: e.target.name.value, color } }); pageLabels(); } catch (err) { toast(err.message, true); }
  };
  $$('[data-filter-label]').forEach((a) => (a.onclick = () => { state.labelFilter = a.dataset.filterLabel; state.status = ''; }));
  $$('[data-del-label]').forEach((b) => (b.onclick = async () => {
    const l = labelById(Number(b.dataset.delLabel));
    if (!confirm(`"${l.name}" লেবেলটি মুছবেন? চ্যাটগুলো থাকবে, শুধু লেবেলটি সরে যাবে।`)) return;
    try { await api(`/labels/${l.id}`, { method: 'DELETE', body: {} }); pageLabels(); } catch (err) { toast(err.message, true); }
  }));
  $$('[data-edit-label]').forEach((b) => (b.onclick = () => {
    const l = labelById(Number(b.dataset.editLabel));
    let c2 = l.color;
    modal(`<h3>লেবেল সম্পাদনা</h3><form id="leForm"><label>নাম</label><input name="name" required maxlength="40" value="${esc(l.name)}">
      <label>রং</label><div class="swatches">${LABEL_COLORS.map((c) => `<button type="button" class="sw ${c === l.color ? 'on' : ''}" data-color="${c}" style="--c:${c}" aria-label="${c}"></button>`).join('')}</div>
      <div class="actions"><button type="button" class="btn ghost" data-close>বাতিল</button><button class="btn">সেভ</button></div></form>`, (bg, close) => {
      $$('.sw', bg).forEach((x) => (x.onclick = () => { c2 = x.dataset.color; $$('.sw', bg).forEach((y) => y.classList.toggle('on', y === x)); }));
      $('#leForm', bg).onsubmit = async (e) => {
        e.preventDefault();
        try { await api(`/labels/${l.id}`, { method: 'PATCH', body: { name: e.target.name.value, color: c2 } }); close(); pageLabels(); } catch (err) { toast(err.message, true); }
      };
    });
  }));
}

// ---------- broadcasts & contact import ----------
const BC_STATUS = { scheduled: ['🕓 শিডিউল করা', 'admin'], sending: ['📤 পাঠানো হচ্ছে', 'agent'], done: ['✅ শেষ', 'agent'], cancelled: ['⛔ বাতিল', 'off'] };
const bcPill = (s) => `<span class="pill ${BC_STATUS[s]?.[1] || ''}">${BC_STATUS[s]?.[0] || s}</span>`;
let bcTimer = null;

async function pageBroadcast(arg) {
  clearTimeout(bcTimer);
  if (!state.labels.length) await loadLabels();
  if (arg === 'new') return pageBroadcastNew();
  if (arg === 'import') return pageImport();
  if (arg) return pageBroadcastReport(Number(arg));
  const list = await api('/broadcasts');
  $('#main').innerHTML = `<div class="page">
    <div class="row" style="justify-content:space-between;margin-bottom:16px">
      <h2 style="margin:0">📢 ব্রডকাস্ট</h2>
      <span class="row"><a class="btn ghost" href="#/broadcast/import">👥 কন্টাক্ট ইমপোর্ট</a><a class="btn" href="#/broadcast/new">＋ নতুন ব্রডকাস্ট</a></span>
    </div>
    <div class="card hint">
      একটি মেসেজ একসাথে অনেককে — লেবেল ধরে (যেমন "ক্লাস ৫")। প্রত্যেকে আলাদা মেসেজ হিসেবে পান, উত্তর দিলে ইনবক্সে আসে।
      <ul class="steps">
        <li>যারা গত ২৪ ঘণ্টায় মেসেজ দেননি, তাদের শুধু Meta-অনুমোদিত <b>টেমপ্লেট</b> পাঠানো যায় (Meta প্রতি মেসেজের দাম নেয়)।</li>
        <li>শুধু পরিচিতদের পাঠান — অচেনাদের পাঠালে Block/Report বাড়ে, নাম্বার ঝুঁকিতে পড়ে। কেউ <b>STOP</b> বা <b>বন্ধ</b> লিখলে তাকে আর পাঠানো হয় না।</li>
        <li>নতুন নাম্বারে দিনে প্রায় ২৫০ জনকে প্রথম মেসেজ পাঠানো যায়; ভালো ব্যবহারে Meta সীমা বাড়ায়। অ্যাপ ধীরে ধীরে পাঠায়।</li>
      </ul>
    </div>
    <div class="card">${list.length ? `<table><thead><tr><th>নাম</th><th class="hide-sm">নাম্বার</th><th>অবস্থা</th><th>পাঠানো</th><th class="hide-sm">সময়</th></tr></thead><tbody>
      ${list.map((b) => `<tr class="clickable" data-bc="${b.id}">
        <td><b>${esc(b.name)}</b><div class="hint">${b.kind === 'template' ? '📋 টেমপ্লেট' : '✍️ লেখা'}</div></td>
        <td class="hide-sm hint">${esc(b.number_label)}</td>
        <td>${bcPill(b.status)}</td>
        <td>${b.sent}/${b.total}${b.failed ? ` <span class="hint">· ব্যর্থ ${b.failed}</span>` : ''}</td>
        <td class="hide-sm hint">${parseTime(b.scheduled_ms).toLocaleString('bn-BD')}</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">এখনো কোনো ব্রডকাস্ট পাঠানো হয়নি।<br>আগে কন্টাক্ট ইমপোর্ট করে লেবেল দিন, তারপর নতুন ব্রডকাস্ট।</div>'}</div>
  </div>`;
  $$('[data-bc]').forEach((tr) => (tr.onclick = () => { location.hash = `#/broadcast/${tr.dataset.bc}`; }));
}

const labelChecks = (name, selected = []) => `<div class="checks label-checks">${state.labels.map((l) => `<label>
  <input type="checkbox" name="${name}" value="${l.id}" ${selected.includes(l.id) ? 'checked' : ''} style="width:auto">
  <span class="lbl" style="--c:${esc(l.color)}">${esc(l.name)}</span></label>`).join('') || '<div class="hint">কোনো লেবেল নেই</div>'}</div>`;
const numberSelect = (name = 'number_id') => `<select name="${name}">${state.numbers.map((n) => `<option value="${n.id}">${esc(n.label)}${n.connected ? '' : ' (কানেক্ট হয়নি)'}</option>`).join('')}</select>`;
const checkedIds = (root, name) => $$(`input[name=${name}]:checked`, root).map((i) => Number(i.value));

// --- import ---
function normalizePhoneClient(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('01')) d = '88' + d;
  else if (d.length === 10 && d.startsWith('1')) d = '880' + d;
  return d.length >= 8 && d.length <= 15 ? d : null;
}

function parseDelimited(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  const sample = lines.slice(0, 5).join('\n');
  const delim = sample.includes('\t') ? '\t' : sample.includes(';') && !sample.includes(',') ? ';' : ',';
  return lines.map((line) => {
    const cells = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === delim && !q) { cells.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  });
}

let xlsxLoading = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { xlsxLoading = null; reject(new Error('Excel পড়ার টুল লোড হয়নি — ইন্টারনেট দেখুন, অথবা ফাইলটি CSV হিসেবে সেভ করুন')); };
    document.head.appendChild(s);
  });
  return xlsxLoading;
}

// Pick the phone and name columns automatically; the first row is a header if it has no phone number in it.
function detectColumns(rows) {
  const width = Math.max(...rows.slice(0, 50).map((r) => r.length), 0);
  const hasHeader = rows.length > 1 && !rows[0].some((c) => normalizePhoneClient(c));
  const body = hasHeader ? rows.slice(1) : rows;
  let phone = 0; let best = -1;
  for (let i = 0; i < width; i++) {
    const hits = body.slice(0, 50).filter((r) => normalizePhoneClient(r[i])).length;
    if (hits > best) { best = hits; phone = i; }
  }
  let name = -1;
  if (hasHeader) name = rows[0].findIndex((h, i) => i !== phone && /name|নাম/i.test(h));
  if (name < 0) name = [...Array(width).keys()].find((i) => i !== phone && body.slice(0, 20).some((r) => r[i] && !normalizePhoneClient(r[i]))) ?? -1;
  return { hasHeader, phone, name, headers: hasHeader ? rows[0] : [...Array(width).keys()].map((i) => `কলাম ${i + 1}`) };
}

function pageImport() {
  let rows = [];
  let cols = null;
  $('#main').innerHTML = `<div class="page">
    <h2><a href="#/broadcast" class="back-link">📢</a> 👥 কন্টাক্ট ইমপোর্ট</h2>
    <div class="card">
      <h3>১. নাম্বারের তালিকা দিন</h3>
      <div class="hint">Excel (.xlsx), CSV ফাইল বেছে নিন — অথবা Excel/Google Sheet থেকে নাম ও নাম্বারের ঘরগুলো কপি করে নিচে পেস্ট করুন। 01XXXXXXXXX ফরম্যাট চলবে।</div>
      <input type="file" id="impFile" accept=".csv,.txt,.xlsx,.xls" style="margin-top:10px">
      <textarea id="impText" rows="5" placeholder="রহিম	01712345678&#10;করিম	01812345678" style="margin-top:10px"></textarea>
      <div id="impCols" class="grid2"></div>
      <div id="impPreview"></div>
    </div>
    <div class="card">
      <h3>২. কোথায় যোগ হবে</h3>
      ${multiNumber() ? `<label>কোন নাম্বারের কন্টাক্ট</label>${numberSelect()}` : ''}
      <label>লেবেল (যেমন: ক্লাস ৫, অভিভাবক) — পরে এই লেবেল ধরে ব্রডকাস্ট পাঠাবেন</label>
      <div id="impLabels">${labelChecks('imp_labels')}</div>
      <div class="row" style="margin-top:8px;flex-wrap:nowrap"><input id="impNewLabel" maxlength="40" placeholder="নতুন লেবেলের নাম"><button type="button" class="btn ghost sm" id="impAddLabel">＋ লেবেল</button></div>
      <div class="row" style="margin-top:16px"><button class="btn" id="impGo" disabled>ইমপোর্ট করুন</button><span id="impStatus" class="hint"></span></div>
      <div class="progress" id="impBar" hidden><div></div></div>
    </div>
  </div>`;
  const contactsFromRows = () => {
    if (!cols) return { valid: [], invalid: [] };
    const body = cols.hasHeader ? rows.slice(1) : rows;
    const valid = []; const invalid = [];
    for (const r of body) {
      const phone = normalizePhoneClient(r[cols.phone]);
      const name = cols.name >= 0 ? (r[cols.name] || '').trim() : '';
      if (phone) valid.push({ phone, name }); else if ((r[cols.phone] || '').trim()) invalid.push(r[cols.phone]);
    }
    const seen = new Set();
    const unique = valid.filter((c) => !seen.has(c.phone) && seen.add(c.phone));
    return { valid: unique, invalid };
  };
  const renderPreview = () => {
    const { valid, invalid } = contactsFromRows();
    $('#impCols').innerHTML = cols ? `<div><label>নাম্বারের কলাম</label><select id="colPhone">${cols.headers.map((h, i) => `<option value="${i}" ${i === cols.phone ? 'selected' : ''}>${esc(h || `কলাম ${i + 1}`)}</option>`).join('')}</select></div>
      <div><label>নামের কলাম</label><select id="colName"><option value="-1">— নাম নেই —</option>${cols.headers.map((h, i) => `<option value="${i}" ${i === cols.name ? 'selected' : ''}>${esc(h || `কলাম ${i + 1}`)}</option>`).join('')}</select></div>` : '';
    $('#colPhone')?.addEventListener('change', (e) => { cols.phone = Number(e.target.value); renderPreview(); });
    $('#colName')?.addEventListener('change', (e) => { cols.name = Number(e.target.value); renderPreview(); });
    $('#impPreview').innerHTML = cols ? `<div class="banner" style="margin-top:12px">✅ ${valid.length.toLocaleString('bn-BD')}টি নাম্বার পাওয়া গেছে${invalid.length ? ` · ⚠ ${invalid.length.toLocaleString('bn-BD')}টি বাদ যাবে (ভুল ফরম্যাট)` : ''}</div>
      <table><thead><tr><th>নাম</th><th>নাম্বার</th></tr></thead><tbody>${valid.slice(0, 8).map((c) => `<tr><td>${esc(c.name || '—')}</td><td>+${esc(c.phone)}</td></tr>`).join('')}</tbody></table>
      ${valid.length > 8 ? `<div class="hint">…আরও ${(valid.length - 8).toLocaleString('bn-BD')} জন</div>` : ''}` : '';
    $('#impGo').disabled = !valid.length;
  };
  const useRows = (r) => { rows = r.filter((x) => x.some((c) => String(c ?? '').trim())).map((x) => x.map((c) => String(c ?? ''))); cols = rows.length ? detectColumns(rows) : null; renderPreview(); };
  $('#impText').oninput = (e) => useRows(parseDelimited(e.target.value));
  $('#impFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      if (/\.xlsx?$/i.test(file.name)) {
        const XLSX = await loadXlsx();
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        useRows(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false }));
      } else {
        useRows(parseDelimited(await file.text()));
      }
    } catch (err) { toast(err.message, true); }
  };
  $('#impAddLabel').onclick = async () => {
    const name = $('#impNewLabel').value.trim();
    if (!name) return;
    try {
      const keep = checkedIds($('#impLabels'), 'imp_labels');
      const label = await api('/labels', { method: 'POST', body: { name, color: LABEL_COLORS[state.labels.length % LABEL_COLORS.length] } });
      state.labels.push(label);
      $('#impLabels').innerHTML = labelChecks('imp_labels', [...keep, label.id]);
      $('#impNewLabel').value = '';
    } catch (err) { toast(err.message, true); }
  };
  $('#impGo').onclick = async () => {
    const { valid } = contactsFromRows();
    const labelIds = checkedIds($('#impLabels'), 'imp_labels');
    const numberId = Number($('#main select[name=number_id]')?.value || state.numbers[0]?.id);
    if (!labelIds.length && !confirm('কোনো লেবেল বাছাই করা হয়নি। লেবেল ছাড়া ইমপোর্ট করলে ব্রডকাস্টে বাছাই করা কঠিন হবে। তবুও চালিয়ে যাবেন?')) return;
    $('#impGo').disabled = true;
    const bar = $('#impBar'); bar.hidden = false;
    let done = 0; let bad = 0;
    try {
      for (let i = 0; i < valid.length; i += 90) {
        const r = await api('/contacts/import', { method: 'POST', body: { number_id: numberId, label_ids: labelIds, contacts: valid.slice(i, i + 90) } });
        done += r.imported; bad += r.invalid.length;
        $('div', bar).style.width = `${Math.round(((i + 90) / valid.length) * 100)}%`;
        $('#impStatus').textContent = `${done.toLocaleString('bn-BD')} / ${valid.length.toLocaleString('bn-BD')} যোগ হয়েছে…`;
      }
      $('#impStatus').textContent = `✅ ${done.toLocaleString('bn-BD')}টি কন্টাক্ট যোগ হয়েছে${bad ? ` · ${bad}টি বাদ` : ''}`;
      toast('ইমপোর্ট শেষ — এখন ব্রডকাস্ট পাঠাতে পারেন');
      await loadLabels();
    } catch (err) { toast(err.message, true); $('#impGo').disabled = false; }
  };
}

// --- new broadcast ---
async function pageBroadcastNew() {
  const hasLabels = state.labels.length;
  $('#main').innerHTML = `<div class="page">
    <h2><a href="#/broadcast" class="back-link">📢</a> নতুন ব্রডকাস্ট</h2>
    <form id="bcForm">
      <div class="card">
        <h3>১. কাদের পাঠাবেন</h3>
        <label>ব্রডকাস্টের নাম (শুধু আপনার টিম দেখবে)</label><input name="name" required maxlength="100" placeholder="যেমন: ক্লাস ৫ — ছুটির নোটিশ">
        ${multiNumber() ? `<label>কোন নাম্বার থেকে</label>${numberSelect()}` : ''}
        <label>লেবেল (যেকোনো একটি থাকলেই পাবেন)</label>
        ${hasLabels ? labelChecks('bc_labels') : '<div class="banner">আগে <a href="#/broadcast/import">কন্টাক্ট ইমপোর্ট</a> করে লেবেল দিন।</div>'}
        <div id="bcCount" class="banner" style="margin-top:10px" hidden></div>
      </div>
      <div class="card">
        <h3>২. কী পাঠাবেন</h3>
        <div class="row">
          <label class="radio"><input type="radio" name="kind" value="template" checked> 📋 টেমপ্লেট (সবাইকে পাঠানো যায়)</label>
          <label class="radio"><input type="radio" name="kind" value="text"> ✍️ সাধারণ লেখা (শুধু গত ২৪ ঘণ্টায় যারা মেসেজ দিয়েছেন)</label>
        </div>
        <div id="bcTemplate"></div>
        <div id="bcText" hidden>
          <label>মেসেজ</label><textarea name="body" rows="4" placeholder="আসসালামু আলাইকুম {{নাম}}, ..."></textarea>
          <button type="button" class="btn ghost sm" id="insName" style="margin-top:6px">＋ {{নাম}} বসান</button>
        </div>
        <label>নাম না থাকলে কী লিখবে</label><input name="name_fallback" value="অভিভাবক" maxlength="60">
        <label>প্রিভিউ</label><div class="card preview-bubble" id="bcPreview"></div>
      </div>
      <div class="card">
        <h3>৩. কখন পাঠাবেন</h3>
        <div class="row">
          <label class="radio"><input type="radio" name="when" value="now" checked> এখনই</label>
          <label class="radio"><input type="radio" name="when" value="later"> পরে</label>
          <input type="datetime-local" name="at" style="width:auto" hidden>
        </div>
        <div class="row" style="margin-top:16px"><button class="btn" id="bcSend">📢 ব্রডকাস্ট পাঠান</button></div>
      </div>
    </form>
  </div>`;
  const form = $('#bcForm');
  let templates = [];
  let tpl = null;
  const numberId = () => Number(form.number_id?.value || state.numbers[0]?.id);
  const kind = () => form.kind.value;
  const bodyOf = (t) => (t?.components || []).find((x) => x.type === 'BODY')?.text || '';
  const headerOf = (t) => (t?.components || []).find((x) => x.type === 'HEADER' && ['IMAGE', 'DOCUMENT', 'VIDEO'].includes(x.format));
  const paramSpecs = () => $$('[data-pmode]', form).map((sel) => (sel.value === 'name'
    ? { type: 'name' } : { type: 'text', value: $(`[data-pval="${sel.dataset.pmode}"]`, form).value }));
  const renderPreview = () => {
    const sample = 'রহিম';
    let text;
    if (kind() === 'template') {
      text = bodyOf(tpl);
      paramSpecs().forEach((p, i) => { text = text.split(`{{${i + 1}}}`).join(p.type === 'name' ? sample : p.value || `{{${i + 1}}}`); });
    } else text = (form.body.value || '').split('{{নাম}}').join(sample);
    $('#bcPreview').textContent = text || '—';
  };
  const renderTemplate = () => {
    const box = $('#bcTemplate');
    if (!templates.length) { box.innerHTML = '<div class="banner">এই নাম্বারে কোনো অনুমোদিত টেমপ্লেট নেই। Meta-র <b>WhatsApp Manager → Message templates</b> থেকে টেমপ্লেট বানিয়ে অনুমোদন নিন।</div>'; return; }
    const nums = [...new Set([...bodyOf(tpl).matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
    const header = headerOf(tpl);
    box.innerHTML = `<label>টেমপ্লেট</label><select id="tplSel">${templates.map((t, i) => `<option value="${i}" ${t === tpl ? 'selected' : ''}>${esc(t.name)} (${esc(t.language)}) — ${esc(t.category)}</option>`).join('')}</select>
      ${tpl.category === 'MARKETING' ? '<div class="hint">ℹ️ এটি MARKETING টেমপ্লেট — Meta এর দাম বেশি নেয়। নোটিশ/রিমাইন্ডারের জন্য UTILITY টেমপ্লেট সস্তা।</div>' : ''}
      ${nums.map((n, i) => `<div class="row" style="flex-wrap:nowrap;margin-top:8px"><span style="min-width:48px">{{${n}}}</span>
        <select data-pmode="${n}" style="width:auto"><option value="name" ${i === 0 ? 'selected' : ''}>গ্রাহকের নাম</option><option value="text" ${i === 0 ? '' : 'selected'}>নির্দিষ্ট লেখা</option></select>
        <input data-pval="${n}" placeholder="লেখা" ${i === 0 ? 'hidden' : ''}></div>`).join('')}
      ${header ? `<label>হেডারের ${header.format === 'IMAGE' ? 'ছবি' : header.format === 'VIDEO' ? 'ভিডিও' : 'ফাইল (PDF)'} — পাবলিক লিংক (https://…)</label><input name="header_link" required placeholder="https://...">` : ''}`;
    $('#tplSel').onchange = (e) => { tpl = templates[Number(e.target.value)]; renderTemplate(); };
    $$('[data-pmode]', box).forEach((s) => (s.onchange = () => { $(`[data-pval="${s.dataset.pmode}"]`, box).hidden = s.value === 'name'; renderPreview(); }));
    $$('[data-pval]', box).forEach((i) => (i.oninput = renderPreview));
    renderPreview();
  };
  const loadTemplates = async () => {
    $('#bcTemplate').innerHTML = '<div class="hint">টেমপ্লেট লোড হচ্ছে…</div>';
    try { templates = await api(`/numbers/${numberId()}/templates`); } catch (err) {
      templates = [];
      if ($('#bcTemplate')) $('#bcTemplate').innerHTML = `<div class="banner">${esc(err.message)}</div>`;
      return;
    }
    if (!$('#bcTemplate')) return;
    tpl = templates[0];
    renderTemplate();
  };
  let countTimer;
  const updateCount = () => {
    clearTimeout(countTimer);
    countTimer = setTimeout(async () => {
      const labelIds = checkedIds(form, 'bc_labels');
      const box = $('#bcCount');
      if (!box) return; // left the page
      if (!labelIds.length) { box.hidden = true; return; }
      try {
        const c = await api('/broadcasts/preview', { method: 'POST', body: { number_id: numberId(), label_ids: labelIds, kind: kind() } });
        box.hidden = false;
        box.innerHTML = `👥 <b>${c.eligible.toLocaleString('bn-BD')} জন</b> পাবেন${c.opted_out ? ` · ${c.opted_out.toLocaleString('bn-BD')} জন STOP করেছেন` : ''}${c.outside_window ? ` · ${c.outside_window.toLocaleString('bn-BD')} জন ২৪ ঘণ্টার বাইরে (তাদের জন্য টেমপ্লেট লাগবে)` : ''}
          ${c.eligible > 250 ? '<div class="hint">⚠ নতুন নাম্বারে দিনে প্রায় ২৫০ জনের সীমা থাকতে পারে — বাকিরা Meta সীমা বাড়ালে পরে যাবে।</div>' : ''}`;
        box.dataset.eligible = c.eligible;
      } catch (err) { box.hidden = false; box.textContent = err.message; }
    }, 250);
  };
  $$('input[name=bc_labels]', form).forEach((i) => (i.onchange = updateCount));
  form.number_id?.addEventListener('change', () => { updateCount(); if (kind() === 'template') loadTemplates(); });
  $$('input[name=kind]', form).forEach((r) => (r.onchange = () => {
    $('#bcTemplate').hidden = kind() !== 'template';
    $('#bcText').hidden = kind() !== 'text';
    updateCount(); renderPreview();
  }));
  $$('input[name=when]', form).forEach((r) => (r.onchange = () => { form.at.hidden = form.when.value !== 'later'; }));
  form.body.oninput = renderPreview;
  $('#insName').onclick = () => { form.body.value += '{{নাম}}'; renderPreview(); form.body.focus(); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const labelIds = checkedIds(form, 'bc_labels');
    if (!labelIds.length) return toast('অন্তত একটি লেবেল বাছাই করুন', true);
    if (kind() === 'template' && !tpl) return toast('টেমপ্লেট বাছাই করুন', true);
    let scheduled = null;
    if (form.when.value === 'later') {
      scheduled = form.at.value ? new Date(form.at.value).getTime() : NaN;
      if (!(scheduled > Date.now())) return toast('ভবিষ্যতের একটি সময় দিন', true);
    }
    let eligible;
    try { eligible = (await api('/broadcasts/preview', { method: 'POST', body: { number_id: numberId(), label_ids: labelIds, kind: kind() } })).eligible; } catch (err) { return toast(err.message, true); }
    if (!eligible) return toast(kind() === 'text' ? 'এই লেবেলে গত ২৪ ঘণ্টায় কেউ মেসেজ দেননি — টেমপ্লেট বেছে নিন' : 'এই লেবেলে পাঠানোর মতো কেউ নেই', true);
    if (!confirm(`${eligible.toLocaleString('bn-BD')} জনকে এই মেসেজ পাঠানো হবে${scheduled ? ` (${new Date(scheduled).toLocaleString('bn-BD')})` : ''}।${kind() === 'template' ? '\nMeta প্রতি মেসেজের দাম নেবে।' : ''}\nনিশ্চিত?`)) return;
    const header = headerOf(tpl);
    const body = {
      name: form.name.value, number_id: numberId(), label_ids: labelIds, kind: kind(), name_fallback: form.name_fallback.value,
      scheduled_ms: scheduled || undefined,
      ...(kind() === 'template'
        ? { template: { name: tpl.name, language: tpl.language, category: tpl.category }, body: bodyOf(tpl), params: paramSpecs(),
          header: header ? { type: header.format.toLowerCase(), link: form.header_link.value } : undefined }
        : { body: form.body.value }),
    };
    $('#bcSend').disabled = true;
    try {
      const r = await api('/broadcasts', { method: 'POST', body });
      toast(scheduled ? 'ব্রডকাস্ট শিডিউল করা হয়েছে' : 'পাঠানো শুরু হয়েছে');
      location.hash = `#/broadcast/${r.id}`;
    } catch (err) { toast(err.message, true); $('#bcSend').disabled = false; }
  };
  loadTemplates();
}

// --- report ---
async function pageBroadcastReport(id) {
  clearTimeout(bcTimer);
  let data;
  try { data = await api(`/broadcasts/${id}`); } catch (err) { toast(err.message, true); location.hash = '#/broadcast'; return; }
  if (location.hash !== `#/broadcast/${id}`) return;
  const { broadcast: b, counts: c, recipients } = data;
  const active = c.total - c.skipped;
  const done = c.sent + c.failed;
  const R_STATUS = { pending: '🕓 বাকি', sending: '📤 যাচ্ছে', sent: '✓ পাঠানো', failed: '⚠ ব্যর্থ', skipped: '— বাদ' };
  const MSG = { delivered: '✓✓ পৌঁছেছে', read: '✓✓ পড়েছে' };
  $('#main').innerHTML = `<div class="page">
    <h2><a href="#/broadcast" class="back-link">📢</a> ${esc(b.name)} ${bcPill(b.status)}</h2>
    <div class="hint" style="margin-bottom:12px">📞 ${esc(b.number_label)} · ${b.kind === 'template' ? `📋 ${esc(b.template_name)}` : '✍️ লেখা'} · ${esc(b.created_by_name || '')} · ${parseTime(b.scheduled_ms).toLocaleString('bn-BD')}</div>
    <div class="card"><div class="progress"><div style="width:${active ? Math.round((done / active) * 100) : 100}%"></div></div>
      <div class="stats" style="margin:14px 0 0">
        ${[['sent', 'পাঠানো'], ['delivered', 'পৌঁছেছে'], ['read', 'পড়েছে'], ['replied', 'উত্তর দিয়েছে'], ['pending', 'বাকি'], ['failed', 'ব্যর্থ'], ['skipped', 'বাদ পড়েছে']]
          .map(([k, l]) => `<div class="stat"><div class="n">${(c[k] || 0).toLocaleString('bn-BD')}</div><div class="l">${l}</div></div>`).join('')}
      </div>
      ${['scheduled', 'sending'].includes(b.status) ? `<button class="btn ghost sm" id="bcCancel" style="margin-top:12px">⛔ বাকিগুলো বাতিল করুন</button>` : ''}
      ${b.status === 'scheduled' && b.scheduled_ms > Date.now() ? `<div class="hint" style="margin-top:8px">নির্দিষ্ট সময়ে নিজে থেকেই পাঠানো শুরু হবে — অ্যাপ খোলা রাখার দরকার নেই।</div>` : ''}
      ${b.status === 'sending' ? '<div class="hint" style="margin-top:8px">পাঠানো চলছে। পেজ বন্ধ করলেও প্রতি মিনিটে নিজে থেকে বাকিগুলো যাবে।</div>' : ''}
    </div>
    <div class="card"><div class="hint" style="white-space:pre-wrap;margin-bottom:10px">${esc((b.params || []).reduce((t, x, i) => t.split(`{{${i + 1}}}`).join(x.type === 'name' ? '[নাম]' : x.value), b.body).split('{{নাম}}').join('[নাম]'))}</div>
      <table><thead><tr><th>নাম</th><th>নাম্বার</th><th>অবস্থা</th><th class="hide-sm">কারণ</th></tr></thead><tbody>
      ${recipients.map((r) => `<tr><td>${esc(r.name || '—')}</td><td>+${esc(r.wa_id)}</td>
        <td>${r.status === 'sent' ? (MSG[r.message_status] || R_STATUS.sent) : R_STATUS[r.status]}${r.replied ? ` · <a href="#/inbox/${r.conversation_id}">💬 উত্তর</a>` : ''}</td>
        <td class="hide-sm hint">${esc(r.error || '')}</td></tr>`).join('')}
      </tbody></table></div>
  </div>`;
  $('#bcCancel')?.addEventListener('click', async () => {
    if (!confirm('যাদের এখনো পাঠানো হয়নি, তাদের আর পাঠানো হবে না। নিশ্চিত?')) return;
    try { await api(`/broadcasts/${id}/cancel`, { method: 'POST', body: {} }); pageBroadcastReport(id); } catch (err) { toast(err.message, true); }
  });
  // While this page is open, keep sending in small batches (the cron job also does this every minute).
  if (b.status === 'sending' || (b.status === 'scheduled' && b.scheduled_ms <= Date.now())) {
    bcTimer = setTimeout(async () => {
      if (location.hash !== `#/broadcast/${id}`) return;
      await api(`/broadcasts/${id}/run`, { method: 'POST', body: {} }).catch(() => {});
      pageBroadcastReport(id);
    }, 2500);
  }
}

// ---------- activity ----------
const ACTION_BN = {
  'workspace.created': 'অ্যাকাউন্ট তৈরি', 'user.login': 'লগইন', 'user.added': 'সদস্য যোগ', 'user.updated': 'সদস্য আপডেট',
  'user.removed': 'সদস্য মুছে ফেলা', 'settings.updated': 'সেটিংস পরিবর্তন', 'conversation.assigned': 'চ্যাট অ্যাসাইন',
  'number.added': 'নাম্বার যোগ', 'number.updated': 'নাম্বার আপডেট', 'number.removed': 'নাম্বার মুছে ফেলা',
  'label.added': 'লেবেল যোগ', 'label.removed': 'লেবেল মুছে ফেলা',
  'broadcast.created': 'ব্রডকাস্ট পাঠানো', 'broadcast.cancelled': 'ব্রডকাস্ট বাতিল',
};
async function pageActivity() {
  const rows = await api('/activity');
  $('#main').innerHTML = `<div class="page"><h2>📝 অ্যাক্টিভিটি লগ</h2><div class="card">
    <table><thead><tr><th>সময়</th><th>কে</th><th>কাজ</th><th class="hide-sm">বিস্তারিত</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${parseTime(r.created_ms).toLocaleString('bn-BD')}</td><td>${esc(r.user_name || '—')}</td>
      <td>${esc(ACTION_BN[r.action] || r.action)}</td><td class="hide-sm">${esc(r.detail || '')}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

// ---------- account ----------
async function pageAccount() {
  $('#main').innerHTML = `<div class="page"><h2>🔑 আমার অ্যাকাউন্ট</h2>
    <div class="card"><b>${esc(state.me.name)}</b> · ${esc(state.me.email)} · <span class="pill ${state.me.role}">${ROLE_BN[state.me.role]}</span></div>
    ${await notificationCard()}
    <div class="card" style="max-width:420px"><h3>পাসওয়ার্ড পরিবর্তন</h3>
      <form id="pForm"><label>বর্তমান পাসওয়ার্ড</label><input name="currentPassword" type="password" required autocomplete="current-password">
      <label>নতুন পাসওয়ার্ড</label><input name="newPassword" type="password" required minlength="8" autocomplete="new-password">
      <button class="btn" style="margin-top:12px">পরিবর্তন করুন</button></form></div></div>`;
  $('#pForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/me/password', { method: 'POST', body: formData(e.target) }); e.target.reset(); toast('পাসওয়ার্ড পরিবর্তন হয়েছে'); } catch (err) { toast(err.message, true); }
  };
  const refresh = () => { renderAppTools(); if (location.hash === '#/account') pageAccount(); };
  $('#pushOn')?.addEventListener('click', async () => { if (await enablePush()) refresh(); });
  $('#pushOff')?.addEventListener('click', async () => { await disablePush(); toast('নোটিফিকেশন বন্ধ করা হয়েছে'); refresh(); });
  $('#pushTest')?.addEventListener('click', async () => {
    try { await api('/push/test', { method: 'POST', body: {} }); toast('টেস্ট নোটিফিকেশন পাঠানো হয়েছে — কয়েক সেকেন্ডের মধ্যে আসার কথা'); } catch (err) { toast(err.message, true); }
  });
  $('#installBtn2')?.addEventListener('click', installApp);
}

// ---------- installable app (PWA) & push notifications ----------
const pwa = {
  installEvent: null,
  isIOS: /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  standalone: window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  pushSupported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
};

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // A tapped notification asks an open window to show that chat.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && e.data.url) {
      const hash = new URL(e.data.url).hash;
      if (hash && location.hash !== hash) location.hash = hash;
    }
  });
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  pwa.installEvent = e;
  renderAppTools();
});
window.addEventListener('appinstalled', () => { pwa.installEvent = null; pwa.standalone = true; renderAppTools(); toast('অ্যাপ ইনস্টল হয়েছে 🎉'); });

function b64uToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!pwa.pushSupported) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

const pushEnabled = async () => pwa.pushSupported && Notification.permission === 'granted' && !!(await currentSubscription().catch(() => null));

async function enablePush() {
  if (!pwa.pushSupported) {
    toast(pwa.isIOS && !pwa.standalone ? 'iPhone-এ আগে অ্যাপটি হোম স্ক্রিনে যোগ করুন, তারপর সেখান থেকে খুলে নোটিফিকেশন চালু করুন।' : 'এই ব্রাউজারে নোটিফিকেশন সাপোর্ট নেই', true);
    return false;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    toast('নোটিফিকেশনের অনুমতি দেওয়া হয়নি। ব্রাউজার/ফোনের সেটিংস থেকে অনুমতি দিন।', true);
    return false;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/push/key');
    let sub = await reg.pushManager.getSubscription();
    const key = b64uToBytes(publicKey);
    const sameKey = (s) => { const k = s?.options?.applicationServerKey; return !k || new Uint8Array(k).every((v, i) => v === key[i]); };
    if (sub && !sameKey(sub)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
    toast('🔔 নোটিফিকেশন চালু হয়েছে');
    return true;
  } catch (err) {
    toast('নোটিফিকেশন চালু করা যায়নি: ' + err.message, true);
    return false;
  }
}

async function disablePush() {
  const sub = await currentSubscription().catch(() => null);
  if (sub) {
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
}

// Keep the server's record of this device pointing at whoever is logged in now.
async function syncPush() {
  if (!pwa.pushSupported || Notification.permission !== 'granted') return;
  const sub = await currentSubscription().catch(() => null);
  if (sub) await api('/push/subscribe', { method: 'POST', body: sub.toJSON() }).catch(() => {});
}

async function installApp() {
  if (pwa.installEvent) {
    pwa.installEvent.prompt();
    await pwa.installEvent.userChoice.catch(() => null);
    pwa.installEvent = null;
    renderAppTools();
  } else {
    modal(`<h3>📲 অ্যাপ হিসেবে ইনস্টল করুন</h3>
      ${pwa.isIOS ? `<ol class="steps hint">
        <li>Safari-তে এই পেজটি খুলুন।</li>
        <li>নিচের <b>Share</b> বাটন (⬆️ চিহ্ন) চাপুন।</li>
        <li><b>Add to Home Screen</b> চাপুন → <b>Add</b>।</li>
        <li>হোম স্ক্রিনের নতুন আইকন থেকে অ্যাপটি খুলুন, তারপর নোটিফিকেশন চালু করুন।</li></ol>`
      : `<ol class="steps hint">
        <li>Chrome-এ উপরে ডানদিকের <b>⋮</b> মেনু চাপুন।</li>
        <li><b>Install app</b> বা <b>Add to Home screen</b> চাপুন।</li></ol>`}
      <div class="actions"><button class="btn" data-close>ঠিক আছে</button></div>`);
  }
}

// Sidebar buttons + inbox banner reflect the current install/notification state.
async function renderAppTools() {
  const tools = $('#appTools');
  if (tools) {
    tools.innerHTML = `${!pwa.standalone ? '<button id="installBtn">📲 অ্যাপ ইনস্টল করুন</button>' : ''}
      ${!(await pushEnabled().catch(() => false)) ? '<button id="pushBtn">🔔 নোটিফিকেশন চালু করুন</button>' : ''}`;
    $('#installBtn')?.addEventListener('click', installApp);
    $('#pushBtn')?.addEventListener('click', async () => { if (await enablePush()) renderAppTools(); });
  }
  const banner = $('#pushBanner');
  if (banner) {
    const dismissed = (() => { try { return localStorage.getItem('pushBannerDismissed') === '1'; } catch { return false; } })();
    const show = !dismissed && !(await pushEnabled().catch(() => false)) && !('Notification' in window && Notification.permission === 'denied');
    banner.innerHTML = show ? `<div class="push-banner">
      <span>🔔 নতুন মেসেজ এলে ফোনে নোটিফিকেশন পেতে চালু করুন</span>
      <span class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn sm" id="pushBannerOn">চালু করুন</button>
      <button class="btn ghost sm" id="pushBannerX" aria-label="বন্ধ">✕</button></span></div>` : '';
    $('#pushBannerOn')?.addEventListener('click', async () => {
      if (pwa.isIOS && !pwa.standalone) return installApp();
      if (await enablePush()) renderAppTools();
    });
    $('#pushBannerX')?.addEventListener('click', () => { try { localStorage.setItem('pushBannerDismissed', '1'); } catch { /* ignore */ } banner.innerHTML = ''; });
  }
}

async function notificationCard() {
  const on = await pushEnabled().catch(() => false);
  const blocked = 'Notification' in window && Notification.permission === 'denied';
  return `<div class="card" style="max-width:520px"><h3>🔔 নোটিফিকেশন (এই ডিভাইস)</h3>
    <div class="hint" style="margin-bottom:10px">চালু থাকলে নতুন গ্রাহক-মেসেজ এলে অ্যাপ বন্ধ থাকলেও এই ফোন/কম্পিউটারে নোটিফিকেশন আসবে।
      মালিক ও অ্যাডমিনরা সব চ্যাটের, এজেন্টরা নিজের ও অ্যাসাইন-না-হওয়া চ্যাটের নোটিফিকেশন পাবেন। প্রত্যেক ডিভাইসে আলাদাভাবে চালু করতে হয়।</div>
    ${!pwa.pushSupported && pwa.isIOS && !pwa.standalone
      ? '<div class="banner">iPhone/iPad-এ নোটিফিকেশন পেতে আগে অ্যাপটি হোম স্ক্রিনে যোগ করুন (নিচের বাটন), তারপর সেই আইকন থেকে খুলে এখানে চালু করুন।</div>'
      : !pwa.pushSupported ? '<div class="banner">এই ব্রাউজারে নোটিফিকেশন সাপোর্ট নেই। Chrome ব্যবহার করুন।</div>'
      : blocked ? '<div class="banner">নোটিফিকেশন ব্লক করা আছে। ব্রাউজারের ঠিকানার বারের 🔒 চিহ্ন → Notifications → Allow করুন।</div>' : ''}
    <div class="row">
      <span class="pill ${on ? 'agent' : 'off'}">${on ? 'চালু আছে' : 'বন্ধ'}</span>
      ${pwa.pushSupported && !blocked ? (on
        ? '<button class="btn ghost sm" id="pushOff">বন্ধ করুন</button><button class="btn sm" id="pushTest">টেস্ট নোটিফিকেশন পাঠান</button>'
        : '<button class="btn sm" id="pushOn">চালু করুন</button>') : ''}
      ${!pwa.standalone ? '<button class="btn ghost sm" id="installBtn2">📲 অ্যাপ ইনস্টল করুন</button>' : ''}
    </div></div>`;
}

// ---------- boot ----------
async function refreshMe() {
  const data = await api('/me');
  state.me = data.user;
  state.workspace = data.workspace;
  state.numbers = data.numbers || [];
}

async function boot() {
  try { await refreshMe(); } catch { return renderAuth('login'); }
  renderShell();
  connectEvents();
  route();
  renderAppTools();
  syncPush();
}

window.addEventListener('hashchange', () => {
  const [page, arg] = location.hash.replace(/^#\//, '').split('/');
  // Switching chats inside the inbox shouldn't rebuild the whole page.
  if (page === 'inbox' && $('#inbox')) {
    if (arg) openConv(Number(arg)); else { state.current = null; renderChat(); renderConvList(); }
    return;
  }
  route();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (state.current?.unread) markRead(state.current.id);
  if (state.me && state.since != null) poll();
});

boot();
