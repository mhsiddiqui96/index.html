import { hashPassword, verifyPassword, encrypt, decrypt, randomToken, sha256Hex } from './crypto.js';
import * as wa from './whatsapp.js';
import * as inbox from './inbox.js';
import { vapidKeys, notifyInbound, notifyUser } from './push.js';

const ROLES = ['owner', 'admin', 'agent'];
const MANAGERS = ['owner', 'admin'];
const SESSION_DAYS = 30;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const phoneDigits = (v) => String(v || '').replace(/\D/g, '');
const pw = (v) => (typeof v === 'string' ? v : '');

function cookies(request) {
  const out = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function rateLimit(db, request, name, max, windowMs) {
  const key = `${name}:${request.headers.get('CF-Connecting-IP') || 'local'}`;
  const now = Date.now();
  const row = await db.first(
    `INSERT INTO login_attempts (key, count, reset_ms) VALUES (?, 1, ?)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN login_attempts.reset_ms < ? THEN 1 ELSE login_attempts.count + 1 END,
       reset_ms = CASE WHEN login_attempts.reset_ms < ? THEN excluded.reset_ms ELSE login_attempts.reset_ms END
     RETURNING count`, key, now + windowMs, now, now);
  if (row.count > max) fail(429, 'অনেকবার চেষ্টা করা হয়েছে, কিছুক্ষণ পর আবার চেষ্টা করুন');
}

async function createSession(db, request, userId) {
  const token = randomToken();
  const now = Date.now();
  await db.batch([
    db.prep('INSERT INTO sessions (token_hash, user_id, expires_ms) VALUES (?, ?, ?)', await sha256Hex(token), userId, now + SESSION_DAYS * 864e5),
    db.prep('UPDATE users SET last_login_ms = ? WHERE id = ?', now, userId),
    db.prep('DELETE FROM sessions WHERE expires_ms < ?', now),
  ]);
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

async function currentUser(db, request) {
  const token = cookies(request).sid;
  if (!token) return null;
  const user = await db.first(`
    SELECT u.id, u.workspace_id, u.name, u.email, u.role, u.active, s.expires_ms
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, await sha256Hex(token));
  if (!user || !user.active || user.expires_ms < Date.now()) return null;
  delete user.expires_ms;
  return user;
}

const requireRole = (user, roles) => { if (!roles.includes(user.role)) fail(403, 'এই কাজের অনুমতি আপনার নেই'); };
// Owners manage admins and agents; admins manage agents only.
const canManageRole = (actor, role) => (actor.role === 'owner' ? role !== 'owner' : actor.role === 'admin' && role === 'agent');

const signupAllowed = async (env, db) => env.ALLOW_SIGNUP === 'true' || !(await db.first('SELECT 1 FROM users LIMIT 1'));

export async function handleApi(request, env, ctx, db) {
  try {
    return await route(request, env, ctx, db);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    if (err instanceof wa.WhatsAppError) return json({ error: err.message }, err.status >= 500 ? 502 : 400);
    console.error(err);
    return json({ error: 'সার্ভারে সমস্যা হয়েছে' }, 500);
  }
}

async function route(request, env, ctx, db) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  const method = request.method;
  // State-changing calls must be JSON: blocks cross-site form posts (CSRF).
  let body = {};
  if (!['GET', 'HEAD'].includes(method)) {
    if (!(request.headers.get('Content-Type') || '').includes('application/json')) fail(415, 'Content-Type application/json প্রয়োজন');
    body = await request.json().catch(() => ({}));
    if (!body || typeof body !== 'object') body = {};
  }
  const m = (verb, pattern) => {
    if (method !== verb) return null;
    const match = path.match(new RegExp(`^${pattern}$`));
    return match ? match.slice(1) : null;
  };

  // ---------- Public ----------
  if (m('GET', '/config')) return json({ signupAllowed: await signupAllowed(env, db) });

  if (m('POST', '/signup')) {
    await rateLimit(db, request, 'signup', 10, 15 * 60e3);
    if (!(await signupAllowed(env, db))) fail(403, 'নতুন অ্যাকাউন্ট খোলা বন্ধ আছে। মালিকের কাছ থেকে লগইন নিন।');
    const workspaceName = str(body.workspaceName, 120);
    const name = str(body.name, 120);
    const email = str(body.email, 200).toLowerCase();
    const password = pw(body.password);
    if (!workspaceName || !name) fail(400, 'বিজনেসের নাম ও আপনার নাম দিন');
    if (!isEmail(email)) fail(400, 'সঠিক ইমেইল দিন');
    if (password.length < 8) fail(400, 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে');
    if (await db.first('SELECT 1 FROM users WHERE email = ?', email)) fail(400, 'এই ইমেইল দিয়ে আগেই অ্যাকাউন্ট আছে');
    const now = Date.now();
    const ws = await db.first('INSERT INTO workspaces (name, wa_verify_token, created_ms) VALUES (?, ?, ?) RETURNING id',
      workspaceName, randomToken(18), now);
    const user = await db.first(
      'INSERT INTO users (workspace_id, name, email, password_hash, role, created_ms) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      ws.id, name, email, await hashPassword(password), 'owner', now);
    await db.log(ws.id, user.id, 'workspace.created', workspaceName);
    return json({ ok: true }, 201, { 'Set-Cookie': await createSession(db, request, user.id) });
  }

  if (m('POST', '/login')) {
    await rateLimit(db, request, 'login', 20, 15 * 60e3);
    const user = await db.first('SELECT * FROM users WHERE email = ?', str(body.email, 200).toLowerCase());
    if (!user || !(await verifyPassword(pw(body.password), user.password_hash))) fail(401, 'ইমেইল বা পাসওয়ার্ড ভুল');
    if (!user.active) fail(403, 'আপনার অ্যাকাউন্ট নিষ্ক্রিয় করা আছে। অ্যাডমিনের সাথে যোগাযোগ করুন।');
    await db.log(user.workspace_id, user.id, 'user.login', null);
    return json({ ok: true }, 200, { 'Set-Cookie': await createSession(db, request, user.id) });
  }

  if (m('POST', '/logout')) {
    const token = cookies(request).sid;
    if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(token));
    return json({ ok: true }, 200, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  // ---------- Authenticated ----------
  const user = await currentUser(db, request);
  if (!user) fail(401, 'লগইন করুন');
  const wsId = user.workspace_id;
  const workspace = () => db.first('SELECT * FROM workspaces WHERE id = ?', wsId);

  async function loadConversation(id) {
    const conv = await inbox.conversationView(db, Number(id));
    if (!conv || conv.workspace_id !== wsId) fail(404, 'কথোপকথন পাওয়া যায়নি');
    if (!inbox.canAccess(user, conv)) fail(403, 'এই চ্যাটটি অন্য এজেন্টকে দেওয়া আছে');
    return conv;
  }

  if (m('GET', '/me')) {
    const ws = await workspace();
    return json({ user, workspace: { id: ws.id, name: ws.name, connected: !!(ws.wa_phone_number_id && ws.wa_access_token), display_phone: ws.wa_display_phone } });
  }

  if (m('POST', '/me/password')) {
    const row = await db.first('SELECT password_hash FROM users WHERE id = ?', user.id);
    if (!(await verifyPassword(pw(body.currentPassword), row.password_hash))) fail(400, 'বর্তমান পাসওয়ার্ড ভুল');
    if (pw(body.newPassword).length < 8) fail(400, 'নতুন পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে');
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(body.newPassword), user.id);
    return json({ ok: true });
  }

  // ---------- Live updates (polled by the browser every few seconds) ----------
  if (m('GET', '/updates')) {
    // No `since` (first poll): start from now and return nothing.
    const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) || 0 : Date.now();
    const convId = Number(url.searchParams.get('conv')) || 0;
    const now = Date.now();
    const visible = user.role === 'agent' ? ' AND (c.assigned_to IS NULL OR c.assigned_to = ?)' : '';
    const conversations = await inbox.conversationsWhere(db, `c.workspace_id = ? AND c.updated_ms > ?${visible}`,
      user.role === 'agent' ? [wsId, since, user.id] : [wsId, since], 200);
    const hidden = user.role === 'agent'
      ? (await db.all('SELECT id FROM conversations WHERE workspace_id = ? AND updated_ms > ? AND assigned_to IS NOT NULL AND assigned_to != ?',
        wsId, since, user.id)).map((r) => r.id)
      : [];
    let messages = [];
    if (convId && !hidden.includes(convId)) {
      const conv = await inbox.conversationView(db, convId);
      if (conv && conv.workspace_id === wsId && inbox.canAccess(user, conv)) {
        messages = await db.all(`${inbox.MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.updated_ms > ? ORDER BY m.id LIMIT 200`, convId, since);
      }
    }
    return json({ now, conversations, hidden, messages });
  }

  // ---------- Team ----------
  if (m('GET', '/users')) {
    return json(await db.all(`SELECT id, name, email, role, active, last_login_ms, created_ms FROM users WHERE workspace_id = ?
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, name`, wsId));
  }

  if (m('POST', '/users')) {
    requireRole(user, MANAGERS);
    const name = str(body.name, 120);
    const email = str(body.email, 200).toLowerCase();
    const role = str(body.role, 10);
    if (!name) fail(400, 'নাম দিন');
    if (!isEmail(email)) fail(400, 'সঠিক ইমেইল দিন');
    if (!ROLES.includes(role) || !canManageRole(user, role)) fail(403, 'এই রোলে সদস্য যোগ করার অনুমতি নেই');
    if (pw(body.password).length < 8) fail(400, 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে');
    if (await db.first('SELECT 1 FROM users WHERE email = ?', email)) fail(400, 'এই ইমেইল দিয়ে আগেই সদস্য আছে');
    const row = await db.first(
      'INSERT INTO users (workspace_id, name, email, password_hash, role, created_ms) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      wsId, name, email, await hashPassword(body.password), role, Date.now());
    await db.log(wsId, user.id, 'user.added', `${name} <${email}> (${role})`);
    return json({ id: row.id }, 201);
  }

  let p;
  if ((p = m('PATCH', '/users/(\\d+)')) || (p = m('DELETE', '/users/(\\d+)'))) {
    requireRole(user, MANAGERS);
    const target = await db.first('SELECT * FROM users WHERE id = ? AND workspace_id = ?', Number(p[0]), wsId);
    if (!target) fail(404, 'সদস্য পাওয়া যায়নি');
    if (target.id === user.id) fail(400, 'নিজের রোল/স্ট্যাটাস এখান থেকে বদলানো যাবে না');
    if (!canManageRole(user, target.role)) fail(403, 'এই সদস্যকে পরিবর্তনের অনুমতি নেই');
    if (method === 'DELETE') {
      await db.run('DELETE FROM users WHERE id = ?', target.id);
      await db.log(wsId, user.id, 'user.removed', target.email);
      return json({ ok: true });
    }
    const changes = [];
    if (body.name !== undefined) {
      if (!str(body.name, 120)) fail(400, 'নাম দিন');
      await db.run('UPDATE users SET name = ? WHERE id = ?', str(body.name, 120), target.id);
      changes.push('name');
    }
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role) || !canManageRole(user, body.role)) fail(403, 'এই রোল দেওয়ার অনুমতি নেই');
      await db.run('UPDATE users SET role = ? WHERE id = ?', body.role, target.id);
      changes.push(`role=${body.role}`);
    }
    if (body.active !== undefined) {
      await db.run('UPDATE users SET active = ? WHERE id = ?', body.active ? 1 : 0, target.id);
      if (!body.active) await db.run('DELETE FROM sessions WHERE user_id = ?', target.id);
      changes.push(body.active ? 'activated' : 'deactivated');
    }
    if (body.password !== undefined) {
      if (pw(body.password).length < 8) fail(400, 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে');
      await db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(body.password), target.id);
      await db.run('DELETE FROM sessions WHERE user_id = ?', target.id);
      changes.push('password reset');
    }
    await db.log(wsId, user.id, 'user.updated', `${target.email}: ${changes.join(', ')}`);
    return json({ ok: true });
  }

  // ---------- WhatsApp settings ----------
  if (m('GET', '/settings')) {
    requireRole(user, MANAGERS);
    const ws = await workspace();
    const token = await decrypt(db, ws.wa_access_token);
    return json({
      name: ws.name,
      wa_phone_number_id: ws.wa_phone_number_id || '',
      wa_business_account_id: ws.wa_business_account_id || '',
      wa_display_phone: ws.wa_display_phone || '',
      token_set: !!token,
      token_hint: token ? `••••${token.slice(-4)}` : '',
      app_secret_set: !!ws.wa_app_secret,
      webhook_url: `${url.origin}/webhook`,
      verify_token: ws.wa_verify_token,
    });
  }

  if (m('PUT', '/settings')) {
    requireRole(user, MANAGERS);
    const ws = await workspace();
    const name = str(body.name, 120) || ws.name;
    const phoneId = phoneDigits(str(body.wa_phone_number_id, 40)) || null;
    const wabaId = phoneDigits(str(body.wa_business_account_id, 40)) || null;
    const token = str(body.wa_access_token, 2000);
    const appSecret = str(body.wa_app_secret, 200);
    if (phoneId && await db.first('SELECT 1 FROM workspaces WHERE wa_phone_number_id = ? AND id != ?', phoneId, wsId)) {
      fail(400, 'এই Phone Number ID অন্য একটি অ্যাকাউন্টে যুক্ত আছে');
    }
    await db.run(`UPDATE workspaces SET name = ?, wa_phone_number_id = ?, wa_business_account_id = ?,
        wa_access_token = COALESCE(?, wa_access_token), wa_app_secret = COALESCE(?, wa_app_secret) WHERE id = ?`,
    name, phoneId, wabaId, token ? await encrypt(db, token) : null, appSecret ? await encrypt(db, appSecret) : null, wsId);
    await db.log(wsId, user.id, 'settings.updated', [token && 'access token', appSecret && 'app secret'].filter(Boolean).join(', ') || null);
    return json({ ok: true });
  }

  if (m('POST', '/settings/test')) {
    requireRole(user, MANAGERS);
    const info = await wa.getPhoneInfo(env, db, await workspace());
    await db.run('UPDATE workspaces SET wa_display_phone = ? WHERE id = ?', info.display_phone_number || null, wsId);
    return json(info);
  }

  // ---------- Inbox ----------
  if (m('GET', '/conversations')) {
    const where = ['c.workspace_id = ?'];
    const params = [wsId];
    if (user.role === 'agent') { where.push('(c.assigned_to IS NULL OR c.assigned_to = ?)'); params.push(user.id); }
    const status = url.searchParams.get('status');
    if (['open', 'closed'].includes(status)) { where.push('c.status = ?'); params.push(status); }
    const filter = url.searchParams.get('filter');
    if (filter === 'mine') { where.push('c.assigned_to = ?'); params.push(user.id); }
    if (filter === 'unassigned') where.push('c.assigned_to IS NULL');
    const q = str(url.searchParams.get('q') || '', 100);
    if (q) { where.push('(ct.name LIKE ? OR ct.wa_id LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    return json(await inbox.conversationsWhere(db, where.join(' AND '), params));
  }

  if (m('POST', '/conversations')) {
    const waId = phoneDigits(body.phone);
    if (waId.length < 8 || waId.length > 15) fail(400, 'দেশের কোডসহ সঠিক নাম্বার দিন (যেমন 8801XXXXXXXXX)');
    const convId = await inbox.upsertConversation(db, wsId, waId, str(body.name, 120) || null);
    const conv = await inbox.conversationView(db, convId);
    if (!inbox.canAccess(user, conv)) fail(403, 'এই চ্যাটটি অন্য এজেন্টকে দেওয়া আছে');
    if (user.role === 'agent' && conv.assigned_to == null) {
      await db.run('UPDATE conversations SET assigned_to = ?, updated_ms = ? WHERE id = ?', user.id, Date.now(), convId);
    }
    return json(await inbox.conversationView(db, convId), 201);
  }

  if ((p = m('GET', '/conversations/(\\d+)/messages'))) {
    const conv = await loadConversation(p[0]);
    const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
    const rows = await db.all(`${inbox.MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT 100`, conv.id, before);
    return json({ conversation: conv, messages: rows.reverse() });
  }

  if ((p = m('POST', '/conversations/(\\d+)/read'))) {
    const conv = await loadConversation(p[0]);
    if (conv.unread > 0) {
      await db.run('UPDATE conversations SET unread = 0, updated_ms = ? WHERE id = ?', Date.now(), conv.id);
      // Blue ticks for the customer (best effort, in the background).
      const last = await db.first(`SELECT wa_message_id FROM messages WHERE conversation_id = ? AND direction = 'in'
        AND wa_message_id IS NOT NULL ORDER BY id DESC LIMIT 1`, conv.id);
      if (last) ctx.waitUntil(workspace().then((ws) => wa.markRead(env, db, ws, last.wa_message_id)).catch(() => {}));
    }
    return json({ ok: true });
  }

  if ((p = m('PATCH', '/conversations/(\\d+)'))) {
    const conv = await loadConversation(p[0]);
    const now = Date.now();
    if (body.status !== undefined) {
      if (!['open', 'closed'].includes(body.status)) fail(400, 'ভুল স্ট্যাটাস');
      await db.run('UPDATE conversations SET status = ?, updated_ms = ? WHERE id = ?', body.status, now, conv.id);
    }
    if (body.assigned_to !== undefined) {
      const assignee = body.assigned_to === null ? null : Number(body.assigned_to);
      if (user.role === 'agent' && assignee !== user.id && !(assignee === null && conv.assigned_to === user.id)) {
        fail(403, 'এজেন্ট শুধু নিজেকে চ্যাট অ্যাসাইন করতে পারবে');
      }
      if (assignee !== null && !(await db.first('SELECT 1 FROM users WHERE id = ? AND workspace_id = ? AND active = 1', assignee, wsId))) {
        fail(400, 'সদস্য পাওয়া যায়নি');
      }
      await db.run('UPDATE conversations SET assigned_to = ?, updated_ms = ? WHERE id = ?', assignee, now, conv.id);
      await db.log(wsId, user.id, 'conversation.assigned', `+${conv.wa_id} → ${assignee ?? 'unassigned'}`);
    }
    if (body.contact_name !== undefined) {
      await db.batch([
        db.prep('UPDATE contacts SET name = ? WHERE id = ?', str(body.contact_name, 120) || null, conv.contact_id),
        db.prep('UPDATE conversations SET updated_ms = ? WHERE id = ?', now, conv.id),
      ]);
    }
    return json(await inbox.conversationView(db, conv.id));
  }

  async function sendAndStore(conv, type, text, sender) {
    try {
      const waMessageId = await sender(await workspace());
      return json(await inbox.storeOutbound(db, conv, { type, body: text, waMessageId, status: 'sent', userId: user.id }), 201);
    } catch (err) {
      if (!(err instanceof wa.WhatsAppError)) throw err;
      const message = await inbox.storeOutbound(db, conv, { type, body: text, status: 'failed', error: err.message, userId: user.id });
      return json({ error: err.message, message }, 502);
    }
  }

  if ((p = m('POST', '/conversations/(\\d+)/messages'))) {
    const conv = await loadConversation(p[0]);
    const text = str(body.text, 4096);
    if (!text) fail(400, 'মেসেজ লিখুন');
    if (!conv.window_open) fail(400, 'গ্রাহক গত ২৪ ঘণ্টায় মেসেজ দেননি — WhatsApp নিয়ম অনুযায়ী এখন শুধু অনুমোদিত টেমপ্লেট পাঠানো যাবে।');
    if (user.role === 'agent' && conv.assigned_to == null) {
      await db.run('UPDATE conversations SET assigned_to = ? WHERE id = ?', user.id, conv.id);
    }
    return sendAndStore(conv, 'text', text, (ws) => wa.sendText(env, db, ws, conv.wa_id, text));
  }

  if ((p = m('POST', '/conversations/(\\d+)/template'))) {
    const conv = await loadConversation(p[0]);
    const name = str(body.name, 512);
    const language = str(body.language, 20) || 'en_US';
    const params = Array.isArray(body.params) ? body.params.map((x) => str(x, 1000)) : [];
    if (!name) fail(400, 'টেমপ্লেট বাছাই করুন');
    const text = str(body.preview, 4096) || `[template: ${name}]`;
    return sendAndStore(conv, 'template', text, (ws) => wa.sendTemplate(env, db, ws, conv.wa_id, name, language, params));
  }

  if (m('GET', '/templates')) {
    const list = await wa.listTemplates(env, db, await workspace());
    return json(list.filter((t) => t.status === 'APPROVED'));
  }

  if ((p = m('GET', '/media/([\\w.-]+)'))) {
    const msg = await db.first('SELECT conversation_id FROM messages WHERE media_id = ? AND workspace_id = ?', p[0], wsId);
    if (!msg) fail(404, 'পাওয়া যায়নি');
    await loadConversation(msg.conversation_id);
    const media = await wa.downloadMedia(env, db, await workspace(), p[0]);
    return new Response(media.body, {
      headers: { 'Content-Type': media.mimeType || 'application/octet-stream', 'Cache-Control': 'private, max-age=86400' },
    });
  }

  // ---------- Quick replies ----------
  if (m('GET', '/quick-replies')) {
    return json(await db.all('SELECT id, title, body FROM quick_replies WHERE workspace_id = ? ORDER BY title', wsId));
  }
  if (m('POST', '/quick-replies')) {
    requireRole(user, MANAGERS);
    const title = str(body.title, 80);
    const text = str(body.body, 4096);
    if (!title || !text) fail(400, 'শিরোনাম ও মেসেজ দুটোই দিন');
    const row = await db.first('INSERT INTO quick_replies (workspace_id, title, body, created_ms) VALUES (?, ?, ?, ?) RETURNING id',
      wsId, title, text, Date.now());
    return json({ id: row.id }, 201);
  }
  if ((p = m('DELETE', '/quick-replies/(\\d+)'))) {
    requireRole(user, MANAGERS);
    await db.run('DELETE FROM quick_replies WHERE id = ? AND workspace_id = ?', Number(p[0]), wsId);
    return json({ ok: true });
  }

  // ---------- Dashboard & activity ----------
  if (m('GET', '/stats')) {
    const dayStart = Number(url.searchParams.get('dayStart')) || Date.now() - 864e5;
    const count = async (sql, ...params) => Object.values(await db.first(sql, wsId, ...params))[0];
    return json({
      open: await count("SELECT COUNT(*) FROM conversations WHERE workspace_id = ? AND status = 'open'"),
      unassigned: await count("SELECT COUNT(*) FROM conversations WHERE workspace_id = ? AND status = 'open' AND assigned_to IS NULL"),
      unread: await count('SELECT COALESCE(SUM(unread), 0) FROM conversations WHERE workspace_id = ?'),
      contacts: await count('SELECT COUNT(*) FROM contacts WHERE workspace_id = ?'),
      inbound_today: await count("SELECT COUNT(*) FROM messages WHERE workspace_id = ? AND direction = 'in' AND created_ms >= ?", dayStart),
      outbound_today: await count("SELECT COUNT(*) FROM messages WHERE workspace_id = ? AND direction = 'out' AND created_ms >= ?", dayStart),
      per_agent: await db.all(`
        SELECT u.id, u.name, u.role,
          (SELECT COUNT(*) FROM conversations c WHERE c.assigned_to = u.id AND c.status = 'open') AS open_chats,
          (SELECT COUNT(*) FROM messages m WHERE m.sent_by = u.id AND m.created_ms >= ?) AS sent_today
        FROM users u WHERE u.workspace_id = ? AND u.active = 1 ORDER BY sent_today DESC, u.name`, dayStart, wsId),
    });
  }

  if (m('GET', '/activity')) {
    requireRole(user, MANAGERS);
    return json(await db.all(`SELECT a.id, a.action, a.detail, a.created_ms, u.name AS user_name FROM activity a
      LEFT JOIN users u ON u.id = a.user_id WHERE a.workspace_id = ? ORDER BY a.id DESC LIMIT 200`, wsId));
  }

  // ---------- Push notifications (installed app / browser) ----------
  if (m('GET', '/push/key')) return json({ publicKey: (await vapidKeys(db)).publicKey });

  if (m('POST', '/push/subscribe')) {
    const endpoint = str(body.endpoint, 1000);
    const p256dh = str(body.keys?.p256dh, 200);
    const auth = str(body.keys?.auth, 100);
    if (!/^https:\/\//.test(endpoint) && !(env.ALLOW_HTTP_PUSH === 'true' && /^http:\/\//.test(endpoint))) fail(400, 'ভুল সাবস্ক্রিপশন');
    if (!p256dh || !auth) fail(400, 'ভুল সাবস্ক্রিপশন');
    // One row per device; re-subscribing on a shared device moves it to whoever is logged in now.
    await db.run(`INSERT INTO push_subscriptions (workspace_id, user_id, endpoint, p256dh, auth, created_ms) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (endpoint) DO UPDATE SET workspace_id = excluded.workspace_id, user_id = excluded.user_id,
        p256dh = excluded.p256dh, auth = excluded.auth`, wsId, user.id, endpoint, p256dh, auth, Date.now());
    return json({ ok: true }, 201);
  }

  if (m('POST', '/push/test')) {
    const devices = await notifyUser(db, user.id, {
      title: 'WA Business SaaS', body: '✅ নোটিফিকেশন ঠিকমতো কাজ করছে!', url: '/#/inbox', tag: 'test',
    }, url.origin);
    if (!devices) fail(400, 'এই অ্যাকাউন্টে কোনো ডিভাইসে নোটিফিকেশন চালু নেই');
    return json({ devices });
  }

  if (m('POST', '/push/unsubscribe')) {
    await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', str(body.endpoint, 1000), user.id);
    return json({ ok: true });
  }

  // ---------- Try the inbox without a live WhatsApp number ----------
  if (m('POST', '/simulate-inbound')) {
    requireRole(user, MANAGERS);
    const waId = phoneDigits(body.phone);
    const text = str(body.text, 4096);
    if (waId.length < 8 || !text) fail(400, 'নাম্বার ও মেসেজ দিন');
    const stored = await inbox.storeInbound(db, wsId, { waId, name: str(body.name, 120) || null, type: 'text', body: text });
    if (stored) {
      ctx.waitUntil(inbox.conversationView(db, stored.convId)
        .then((conv) => notifyInbound(db, conv, text, url.origin))
        .catch((err) => console.error('push failed', err)));
    }
    return json(stored, 201);
  }

  fail(404, 'পাওয়া যায়নি');
}
