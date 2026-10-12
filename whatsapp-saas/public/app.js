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
  es: null,
};

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

const parseTime = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z') : null);
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
  state.es?.close();
  let signupAllowed = true;
  try { signupAllowed = (await api('/config')).signupAllowed; } catch { /* ignore */ }
  if (mode === 'signup' && !signupAllowed) mode = 'login';
  const signup = mode === 'signup';
  $('#app').innerHTML = `
  <div class="auth"><div class="auth-card">
    <div class="brand"><div class="logo">✆</div> WA Business SaaS</div>
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
  { id: 'settings', icon: '⚙️', label: 'WhatsApp সেটিংস', manager: true },
  { id: 'activity', icon: '📝', label: 'অ্যাক্টিভিটি লগ', manager: true },
  { id: 'account', icon: '🔑', label: 'আমার অ্যাকাউন্ট' },
];

function renderShell() {
  $('#app').innerHTML = `
  <div class="shell">
    <div class="mobile-top"><button id="menuBtn" aria-label="মেনু">☰</button><b>${esc(state.workspace.name)}</b></div>
    <aside class="side" id="side">
      <div class="brand"><div class="logo">✆</div><span>${esc(state.workspace.name)}</span></div>
      <nav>${NAV.filter((n) => !n.manager || isManager()).map((n) =>
        `<a href="#/${n.id}" data-nav="${n.id}">${n.icon} ${n.label}${n.id === 'inbox' ? '<span class="badge" id="unreadBadge" hidden></span>' : ''}</a>`).join('')}
      </nav>
      <div class="me">
        <div>${esc(state.me.name)}</div>
        <div class="role">${ROLE_BN[state.me.role]}</div>
        <button id="logoutBtn">লগআউট</button>
      </div>
    </aside>
    <main class="main" id="main"></main>
  </div>`;
  $('#logoutBtn').onclick = async () => { await api('/logout', { method: 'POST', body: {} }); state.me = null; renderAuth('login'); };
  $('#menuBtn').onclick = () => $('#side').classList.toggle('open');
  $('#side').addEventListener('click', (e) => { if (e.target.closest('a')) $('#side').classList.remove('open'); });
}

function route() {
  if (!state.me) return;
  const [page, arg] = location.hash.replace(/^#\//, '').split('/');
  const target = NAV.find((n) => n.id === page && (!n.manager || isManager())) ? page : 'inbox';
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === target));
  const pages = { inbox: pageInbox, dashboard: pageDashboard, team: pageTeam, quick: pageQuick, settings: pageSettings, activity: pageActivity, account: pageAccount };
  pages[target](arg);
}

function updateUnreadBadge() {
  const total = state.convs.reduce((a, c) => a + (c.unread || 0), 0);
  const b = $('#unreadBadge');
  if (b) { b.hidden = !total; b.textContent = total; }
  document.title = (total ? `(${total}) ` : '') + 'WA Business SaaS';
}

// ---------- realtime ----------
function connectEvents() {
  state.es?.close();
  const es = new EventSource('/api/events');
  state.es = es;
  es.addEventListener('conversation', (e) => {
    const { conversation, message } = JSON.parse(e.data);
    upsertConv(conversation);
    if (state.current?.id === conversation.id) {
      state.current = conversation;
      if (message && !state.messages.some((m) => m.id === message.id)) {
        state.messages.push(message);
        renderMessages(true);
        if (message.direction === 'in' && document.visibilityState === 'visible') markRead(conversation.id);
      }
      renderChatHead();
    } else if (message?.direction === 'in') {
      toast(`নতুন মেসেজ: ${conversation.contact_name || '+' + conversation.wa_id}`);
    }
  });
  es.addEventListener('status', (e) => {
    const s = JSON.parse(e.data);
    const m = state.messages.find((x) => x.id === s.message_id);
    if (m) { m.status = s.status; m.error = s.error; renderMessages(false); }
  });
  es.addEventListener('conversation_hidden', (e) => {
    const { id } = JSON.parse(e.data);
    state.convs = state.convs.filter((c) => c.id !== id);
    if (state.current?.id === id) { state.current = null; renderChat(); }
    renderConvList();
  });
}

function matchesFilters(c) {
  if (state.status && c.status !== state.status) return false;
  if (state.filter === 'mine' && c.assigned_to !== state.me.id) return false;
  if (state.filter === 'unassigned' && c.assigned_to != null) return false;
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
  state.convs.sort((a, b) => (b.last_message_at || b.created_at).localeCompare(a.last_message_at || a.created_at));
  renderConvList();
}

// ---------- inbox ----------
async function pageInbox(convId) {
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
        </div>
      </div>
      <div class="convs" id="convs"></div>
    </section>
    <section class="chat" id="chat"></section>
  </div>`;
  let searchTimer;
  $('#search').oninput = (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadConvs(); }, 250); };
  $$('[data-filter]').forEach((b) => (b.onclick = () => { state.filter = b.dataset.filter; pageInbox(state.current?.id); }));
  $('#statusSel').onchange = (e) => { state.status = e.target.value; loadConvs(); };
  $('#newChat').onclick = newChatModal;
  if (!state.users.length) state.users = await api('/users').catch(() => []);
  await loadConvs();
  if (convId) openConv(Number(convId)); else renderChat();
}

async function loadConvs() {
  const qs = new URLSearchParams({ status: state.status, filter: state.filter, q: state.q });
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
        <div class="top"><span class="name">${esc(c.contact_name || '+' + c.wa_id)}</span><span class="time">${timeLabel(c.last_message_at)}</span></div>
        <div class="bottom"><span class="preview">${esc(c.last_message_preview || '')}</span>${c.unread ? `<span class="unread">${c.unread}</span>` : ''}</div>
        <div class="assignee">${c.assigned_name ? '👤 ' + esc(c.assigned_name) : ''}${c.status === 'closed' ? ' · বন্ধ' : ''}</div>
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
  const assignable = isManager() ? state.users.filter((u) => u.active) : state.users.filter((u) => u.id === state.me.id);
  head.innerHTML = `
    <button class="btn ghost sm back" id="backBtn">←</button>
    <div class="avatar" style="background:${avatarColor(c.wa_id)}">${esc(initials(c.contact_name || c.wa_id.slice(-2)))}</div>
    <div class="who"><b>${esc(c.contact_name || '+' + c.wa_id)}</b><span>+${esc(c.wa_id)} ${c.window_open ? '· 🟢 ২৪ ঘণ্টার উইন্ডো খোলা' : '· ⏳ শুধু টেমপ্লেট'}</span></div>
    <select id="assignSel" title="অ্যাসাইন">
      <option value="">— অ্যাসাইন হয়নি —</option>
      ${assignable.map((u) => `<option value="${u.id}" ${c.assigned_to === u.id ? 'selected' : ''}>👤 ${esc(u.name)}</option>`).join('')}
      ${c.assigned_to && !assignable.some((u) => u.id === c.assigned_to) ? `<option selected disabled>👤 ${esc(c.assigned_name)}</option>` : ''}
    </select>
    <button class="btn ghost sm" id="renameBtn" title="নাম পরিবর্তন">✏️</button>
    <button class="btn ${c.status === 'open' ? 'ghost' : ''} sm" id="statusBtn">${c.status === 'open' ? '✔ বন্ধ করুন' : '↺ আবার খুলুন'}</button>`;
  $('#backBtn').onclick = () => { state.current = null; location.hash = '#/inbox'; };
  $('#assignSel').onchange = (e) => patchConv({ assigned_to: e.target.value ? Number(e.target.value) : null });
  $('#statusBtn').onclick = () => patchConv({ status: c.status === 'open' ? 'closed' : 'open' });
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
    const d = parseTime(m.created_at);
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
    } catch (err) {
      toast(err.message, true);
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
  try { templates = await api('/templates'); } catch (err) { return toast(err.message, true); }
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

function newChatModal() {
  modal(`
    <h3>নতুন চ্যাট শুরু করুন</h3>
    <div class="hint">নতুন গ্রাহককে প্রথম মেসেজ হিসেবে শুধু অনুমোদিত টেমপ্লেট পাঠানো যায়।</div>
    <form id="ncForm">
      <label>WhatsApp নাম্বার (দেশের কোডসহ)</label><input name="phone" required placeholder="8801XXXXXXXXX" inputmode="tel">
      <label>নাম (ঐচ্ছিক)</label><input name="name" maxlength="120">
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
  const s = await api('/stats');
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
        <b>মালিক</b> — সব কিছু, অ্যাডমিন যোগ/বাদ · <b>অ্যাডমিন</b> — সব চ্যাট, এজেন্ট যোগ/বাদ, সেটিংস · <b>এজেন্ট</b> — শুধু নিজের ও অ্যাসাইন-না-হওয়া চ্যাট
      </div>
      <table><thead><tr><th>নাম</th><th class="hide-sm">ইমেইল</th><th>রোল</th><th class="hide-sm">শেষ লগইন</th><th></th></tr></thead><tbody>
      ${state.users.map((u) => `<tr>
        <td>${esc(u.name)}${u.id === me.id ? ' <span class="hint">(আপনি)</span>' : ''}</td>
        <td class="hide-sm">${esc(u.email)}</td>
        <td><span class="pill ${u.role}">${ROLE_BN[u.role]}</span> ${u.active ? '' : '<span class="pill off">নিষ্ক্রিয়</span>'}</td>
        <td class="hide-sm">${u.last_login_at ? timeLabel(u.last_login_at) : '—'}</td>
        <td style="text-align:right">${canManage(u) ? `<button class="btn ghost sm" data-edit="${u.id}">সম্পাদনা</button>` : ''}</td>
      </tr>`).join('')}
      </tbody></table>
    </div></div>`;
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
      <div class="actions"><button type="button" class="btn ghost" data-close>বাতিল</button><button class="btn" type="submit">যোগ করুন</button></div>
    </form>`, (bg, close) => {
    $('#uForm', bg).onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/users', { method: 'POST', body: formData(e.target) }); close(); toast('সদস্য যোগ হয়েছে'); pageTeam(); } catch (err) { toast(err.message, true); }
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

// ---------- settings ----------
async function pageSettings() {
  const s = await api('/settings');
  const webhookUrl = `${location.origin}${s.webhook_path}`;
  $('#main').innerHTML = `<div class="page">
    <h2>⚙️ WhatsApp সেটিংস</h2>
    <div class="card">
      <h3>১. WhatsApp Business নাম্বার কানেক্ট করুন</h3>
      <ol class="steps hint">
        <li><a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">developers.facebook.com</a> এ একটি <b>Business</b> টাইপ অ্যাপ তৈরি করে <b>WhatsApp</b> প্রোডাক্ট যোগ করুন।</li>
        <li>WhatsApp → API Setup থেকে <b>Phone Number ID</b> ও <b>WhatsApp Business Account ID</b> কপি করুন।</li>
        <li>Business Settings → System Users থেকে <b>whatsapp_business_messaging</b> ও <b>whatsapp_business_management</b> পারমিশনসহ একটি স্থায়ী (permanent) Access Token তৈরি করুন।</li>
      </ol>
      <form id="sForm">
        <label>বিজনেসের নাম</label><input name="name" value="${esc(s.name)}" required>
        <div class="grid2">
          <div><label>Phone Number ID</label><input name="wa_phone_number_id" value="${esc(s.wa_phone_number_id)}" inputmode="numeric"></div>
          <div><label>WhatsApp Business Account ID</label><input name="wa_business_account_id" value="${esc(s.wa_business_account_id)}" inputmode="numeric"></div>
        </div>
        <label>Access Token</label>
        <input name="wa_access_token" type="password" placeholder="${s.token_set ? 'সেভ করা আছে ' + esc(s.token_hint) + ' — বদলাতে নতুন টোকেন দিন' : 'EAAG…'}" autocomplete="off">
        <div class="hint">টোকেন এনক্রিপ্ট করে সংরক্ষণ করা হয়, কোনো ইউজারকে আর দেখানো হয় না।</div>
        <div class="row" style="margin-top:14px">
          <button class="btn">সেভ করুন</button>
          <button type="button" class="btn ghost" id="testBtn">🔌 কানেকশন টেস্ট</button>
          <span id="testResult" class="hint"></span>
        </div>
      </form>
    </div>
    <div class="card">
      <h3>২. Webhook সেট করুন (মেসেজ রিসিভ করার জন্য)</h3>
      <div class="hint">Meta App → WhatsApp → Configuration → Webhook এ নিচের তথ্য দিন, তারপর <b>messages</b> ফিল্ড Subscribe করুন।</div>
      <label>Callback URL</label><code>${esc(webhookUrl)}</code>
      <label>Verify Token</label><div>${s.verify_token_set ? 'সার্ভারের <code>WEBHOOK_VERIFY_TOKEN</code> এ যা দেওয়া আছে' : '⚠ সার্ভারে <code>WEBHOOK_VERIFY_TOKEN</code> সেট করা নেই'}</div>
      <label>সিগনেচার যাচাই</label><div>${s.signature_check ? '✅ চালু (META_APP_SECRET)' : '⚠ বন্ধ — প্রোডাকশনে <code>META_APP_SECRET</code> সেট করুন'}</div>
      <div class="hint" style="margin-top:8px">Webhook এর জন্য সার্ভারটি পাবলিক <b>HTTPS</b> URL এ থাকতে হবে।</div>
    </div>
    <div class="card">
      <h3>🧪 টেস্ট মেসেজ (WhatsApp ছাড়া ইনবক্স ট্রাই করুন)</h3>
      <div class="hint">একজন গ্রাহক মেসেজ পাঠিয়েছে এমনভাবে ইনবক্সে একটি মেসেজ যোগ হবে।</div>
      <form id="simForm" class="grid2">
        <div><label>নাম্বার</label><input name="phone" value="8801700000000" required></div>
        <div><label>নাম</label><input name="name" value="টেস্ট গ্রাহক"></div>
        <div style="grid-column:1/-1"><label>মেসেজ</label><input name="text" value="আসসালামু আলাইকুম, কোর্সের ফি কত?" required></div>
        <div><button class="btn ghost" style="margin-top:12px">ইনবক্সে পাঠান</button></div>
      </form>
    </div>
  </div>`;
  $('#sForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/settings', { method: 'PUT', body: formData(e.target) });
      toast('সেটিংস সেভ হয়েছে');
      await refreshMe();
      pageSettings();
    } catch (err) { toast(err.message, true); }
  };
  $('#testBtn').onclick = async () => {
    const out = $('#testResult');
    out.textContent = 'যাচাই হচ্ছে…';
    try {
      const info = await api('/settings/test', { method: 'POST', body: {} });
      out.textContent = `✅ কানেক্টেড: ${info.verified_name || ''} ${info.display_phone_number || ''} (Quality: ${info.quality_rating || '—'})`;
    } catch (err) { out.textContent = '❌ ' + err.message; }
  };
  $('#simForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('/simulate-inbound', { method: 'POST', body: formData(e.target) });
      toast('ইনবক্সে মেসেজ যোগ হয়েছে');
      location.hash = `#/inbox/${r.convId}`;
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- activity ----------
const ACTION_BN = {
  'workspace.created': 'অ্যাকাউন্ট তৈরি', 'user.login': 'লগইন', 'user.added': 'সদস্য যোগ', 'user.updated': 'সদস্য আপডেট',
  'user.removed': 'সদস্য মুছে ফেলা', 'settings.updated': 'সেটিংস পরিবর্তন', 'conversation.assigned': 'চ্যাট অ্যাসাইন',
};
async function pageActivity() {
  const rows = await api('/activity');
  $('#main').innerHTML = `<div class="page"><h2>📝 অ্যাক্টিভিটি লগ</h2><div class="card">
    <table><thead><tr><th>সময়</th><th>কে</th><th>কাজ</th><th class="hide-sm">বিস্তারিত</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${parseTime(r.created_at).toLocaleString('bn-BD')}</td><td>${esc(r.user_name || '—')}</td>
      <td>${esc(ACTION_BN[r.action] || r.action)}</td><td class="hide-sm">${esc(r.detail || '')}</td></tr>`).join('')}
    </tbody></table></div></div>`;
}

// ---------- account ----------
function pageAccount() {
  $('#main').innerHTML = `<div class="page"><h2>🔑 আমার অ্যাকাউন্ট</h2>
    <div class="card"><b>${esc(state.me.name)}</b> · ${esc(state.me.email)} · <span class="pill ${state.me.role}">${ROLE_BN[state.me.role]}</span></div>
    <div class="card" style="max-width:420px"><h3>পাসওয়ার্ড পরিবর্তন</h3>
      <form id="pForm"><label>বর্তমান পাসওয়ার্ড</label><input name="currentPassword" type="password" required autocomplete="current-password">
      <label>নতুন পাসওয়ার্ড</label><input name="newPassword" type="password" required minlength="8" autocomplete="new-password">
      <button class="btn" style="margin-top:12px">পরিবর্তন করুন</button></form></div></div>`;
  $('#pForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/me/password', { method: 'POST', body: formData(e.target) }); e.target.reset(); toast('পাসওয়ার্ড পরিবর্তন হয়েছে'); } catch (err) { toast(err.message, true); }
  };
}

// ---------- boot ----------
async function refreshMe() {
  const data = await api('/me');
  state.me = data.user;
  state.workspace = data.workspace;
}

async function boot() {
  try { await refreshMe(); } catch { return renderAuth('login'); }
  renderShell();
  connectEvents();
  route();
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
  if (document.visibilityState === 'visible' && state.current?.unread) markRead(state.current.id);
});

boot();
