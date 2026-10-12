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
  const pages = { inbox: pageInbox, dashboard: pageDashboard, team: pageTeam, quick: pageQuick, labels: pageLabels, settings: pageSettings, activity: pageActivity, account: pageAccount };
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
      <div class="lbls">${labelChips(c.label_ids)}</div></div>
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

// ---------- activity ----------
const ACTION_BN = {
  'workspace.created': 'অ্যাকাউন্ট তৈরি', 'user.login': 'লগইন', 'user.added': 'সদস্য যোগ', 'user.updated': 'সদস্য আপডেট',
  'user.removed': 'সদস্য মুছে ফেলা', 'settings.updated': 'সেটিংস পরিবর্তন', 'conversation.assigned': 'চ্যাট অ্যাসাইন',
  'number.added': 'নাম্বার যোগ', 'number.updated': 'নাম্বার আপডেট', 'number.removed': 'নাম্বার মুছে ফেলা',
  'label.added': 'লেবেল যোগ', 'label.removed': 'লেবেল মুছে ফেলা',
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
