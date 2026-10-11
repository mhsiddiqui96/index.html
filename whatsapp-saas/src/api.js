'use strict';
const express = require('express');
const { get, all, run, tx, logActivity } = require('./db');
const { hashPassword, verifyPassword, encrypt, decrypt } = require('./security');
const { createSession, destroySession, requireAuth, requireRole, rateLimit } = require('./auth');
const wa = require('./whatsapp');
const inbox = require('./inbox');
const events = require('./events');

const router = express.Router();
const ROLES = ['owner', 'admin', 'agent'];
const MANAGERS = ['owner', 'admin'];

// Reject cross-site form posts: state-changing API calls must be JSON (forces a CORS preflight).
router.use((req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type application/json প্রয়োজন' });
  }
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const normalizePhone = (v) => String(v || '').replace(/[^\d]/g, '');

function badRequest(res, error) {
  res.status(400).json({ error });
}

function workspaceOf(req) {
  return get('SELECT * FROM workspaces WHERE id = ?', req.user.workspace_id);
}

function loadConversation(req, res) {
  const conv = inbox.conversationView(Number(req.params.id));
  if (!conv || conv.workspace_id !== req.user.workspace_id) {
    res.status(404).json({ error: 'কথোপকথন পাওয়া যায়নি' });
    return null;
  }
  if (!inbox.canAccess(req.user, conv)) {
    res.status(403).json({ error: 'এই চ্যাটটি অন্য এজেন্টকে দেওয়া আছে' });
    return null;
  }
  return conv;
}

// ---------- Auth ----------
router.get('/config', (req, res) => {
  const hasUsers = !!get('SELECT 1 FROM users LIMIT 1');
  res.json({ signupAllowed: process.env.ALLOW_SIGNUP !== 'false' || !hasUsers });
});

router.post('/signup', rateLimit(10, 15 * 60e3), (req, res) => {
  const hasUsers = !!get('SELECT 1 FROM users LIMIT 1');
  if (process.env.ALLOW_SIGNUP === 'false' && hasUsers) return res.status(403).json({ error: 'সাইন-আপ বন্ধ আছে' });
  const workspaceName = str(req.body.workspaceName, 120);
  const name = str(req.body.name, 120);
  const email = str(req.body.email, 200).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!workspaceName || !name) return badRequest(res, 'বিজনেসের নাম ও আপনার নাম দিন');
  if (!isEmail(email)) return badRequest(res, 'সঠিক ইমেইল দিন');
  if (password.length < 8) return badRequest(res, 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে');
  if (get('SELECT 1 FROM users WHERE email = ?', email)) return badRequest(res, 'এই ইমেইল দিয়ে আগেই অ্যাকাউন্ট আছে');

  const userId = tx(() => {
    const ws = run('INSERT INTO workspaces (name) VALUES (?)', workspaceName);
    const wsId = Number(ws.lastInsertRowid);
    const u = run('INSERT INTO users (workspace_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      wsId, name, email, hashPassword(password), 'owner');
    logActivity(wsId, Number(u.lastInsertRowid), 'workspace.created', workspaceName);
    return Number(u.lastInsertRowid);
  });
  createSession(res, userId);
  res.status(201).json({ ok: true });
});

router.post('/login', rateLimit(20, 15 * 60e3), (req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'ইমেইল বা পাসওয়ার্ড ভুল' });
  }
  if (!user.active) return res.status(403).json({ error: 'আপনার অ্যাকাউন্ট নিষ্ক্রিয় করা আছে। অ্যাডমিনের সাথে যোগাযোগ করুন।' });
  createSession(res, user.id);
  logActivity(user.workspace_id, user.id, 'user.login', null);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

router.use(requireAuth);

router.get('/me', (req, res) => {
  const ws = workspaceOf(req);
  res.json({
    user: req.user,
    workspace: { id: ws.id, name: ws.name, connected: !!(ws.wa_phone_number_id && ws.wa_access_token), display_phone: ws.wa_display_phone },
  });
});

router.post('/me/password', (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const row = get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(String(currentPassword || ''), row.password_hash)) return badRequest(res, 'বর্তমান পাসওয়ার্ড ভুল');
  if (typeof newPassword !== 'string' || newPassword.length < 8) return badRequest(res, 'নতুন পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে');
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(newPassword), req.user.id);
  res.json({ ok: true });
});

router.get('/events', (req, res) => events.subscribe(req, res));

// ---------- Team (admins & agents) ----------
router.get('/users', (req, res) => {
  res.json(all(`SELECT id, name, email, role, active, last_login_at, created_at FROM users
                WHERE workspace_id = ? ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, name`,
  req.user.workspace_id));
});

// Owners manage admins and agents; admins manage agents only.
const canManageRole = (actor, role) => actor.role === 'owner' ? role !== 'owner' : actor.role === 'admin' && role === 'agent';

router.post('/users', requireRole(...MANAGERS), (req, res) => {
  const name = str(req.body.name, 120);
  const email = str(req.body.email, 200).toLowerCase();
  const role = str(req.body.role, 10);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!name) return badRequest(res, 'নাম দিন');
  if (!isEmail(email)) return badRequest(res, 'সঠিক ইমেইল দিন');
  if (!ROLES.includes(role) || !canManageRole(req.user, role)) return res.status(403).json({ error: 'এই রোলে ইউজার যোগ করার অনুমতি নেই' });
  if (password.length < 8) return badRequest(res, 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে');
  if (get('SELECT 1 FROM users WHERE email = ?', email)) return badRequest(res, 'এই ইমেইল দিয়ে আগেই ইউজার আছে');
  const r = run('INSERT INTO users (workspace_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    req.user.workspace_id, name, email, hashPassword(password), role);
  logActivity(req.user.workspace_id, req.user.id, 'user.added', `${name} <${email}> (${role})`);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

function loadManagedUser(req, res) {
  const target = get('SELECT * FROM users WHERE id = ? AND workspace_id = ?', Number(req.params.id), req.user.workspace_id);
  if (!target) { res.status(404).json({ error: 'ইউজার পাওয়া যায়নি' }); return null; }
  if (target.id === req.user.id) { badRequest(res, 'নিজের রোল/স্ট্যাটাস এখান থেকে বদলানো যাবে না'); return null; }
  if (!canManageRole(req.user, target.role)) { res.status(403).json({ error: 'এই ইউজারকে পরিবর্তনের অনুমতি নেই' }); return null; }
  return target;
}

router.patch('/users/:id', requireRole(...MANAGERS), (req, res) => {
  const target = loadManagedUser(req, res);
  if (!target) return;
  const changes = [];
  if (req.body.name !== undefined) {
    const name = str(req.body.name, 120);
    if (!name) return badRequest(res, 'নাম দিন');
    run('UPDATE users SET name = ? WHERE id = ?', name, target.id);
    changes.push('name');
  }
  if (req.body.role !== undefined) {
    if (!ROLES.includes(req.body.role) || !canManageRole(req.user, req.body.role)) return res.status(403).json({ error: 'এই রোল দেওয়ার অনুমতি নেই' });
    run('UPDATE users SET role = ? WHERE id = ?', req.body.role, target.id);
    changes.push(`role=${req.body.role}`);
  }
  if (req.body.active !== undefined) {
    run('UPDATE users SET active = ? WHERE id = ?', req.body.active ? 1 : 0, target.id);
    if (!req.body.active) run('DELETE FROM sessions WHERE user_id = ?', target.id);
    changes.push(req.body.active ? 'activated' : 'deactivated');
  }
  if (req.body.password !== undefined) {
    if (typeof req.body.password !== 'string' || req.body.password.length < 8) return badRequest(res, 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে');
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(req.body.password), target.id);
    run('DELETE FROM sessions WHERE user_id = ?', target.id);
    changes.push('password reset');
  }
  logActivity(req.user.workspace_id, req.user.id, 'user.updated', `${target.email}: ${changes.join(', ')}`);
  res.json({ ok: true });
});

router.delete('/users/:id', requireRole(...MANAGERS), (req, res) => {
  const target = loadManagedUser(req, res);
  if (!target) return;
  run('DELETE FROM users WHERE id = ?', target.id);
  logActivity(req.user.workspace_id, req.user.id, 'user.removed', target.email);
  res.json({ ok: true });
});

// ---------- WhatsApp settings ----------
router.get('/settings', requireRole(...MANAGERS), (req, res) => {
  const ws = workspaceOf(req);
  const token = decrypt(ws.wa_access_token);
  res.json({
    name: ws.name,
    wa_phone_number_id: ws.wa_phone_number_id || '',
    wa_business_account_id: ws.wa_business_account_id || '',
    wa_display_phone: ws.wa_display_phone || '',
    token_set: !!token,
    token_hint: token ? `••••${token.slice(-4)}` : '',
    webhook_path: '/webhook',
    verify_token_set: !!process.env.WEBHOOK_VERIFY_TOKEN,
    signature_check: !!process.env.META_APP_SECRET,
  });
});

router.put('/settings', requireRole(...MANAGERS), (req, res) => {
  const ws = workspaceOf(req);
  const name = str(req.body.name, 120) || ws.name;
  const phoneId = str(req.body.wa_phone_number_id, 40).replace(/\D/g, '') || null;
  const wabaId = str(req.body.wa_business_account_id, 40).replace(/\D/g, '') || null;
  const token = str(req.body.wa_access_token, 1000);
  if (phoneId && get('SELECT 1 FROM workspaces WHERE wa_phone_number_id = ? AND id != ?', phoneId, ws.id)) {
    return badRequest(res, 'এই Phone Number ID অন্য একটি অ্যাকাউন্টে যুক্ত আছে');
  }
  run(`UPDATE workspaces SET name = ?, wa_phone_number_id = ?, wa_business_account_id = ?,
         wa_access_token = COALESCE(?, wa_access_token) WHERE id = ?`,
  name, phoneId, wabaId, token ? encrypt(token) : null, ws.id);
  logActivity(ws.id, req.user.id, 'settings.updated', token ? 'access token changed' : null);
  res.json({ ok: true });
});

router.post('/settings/test', requireRole(...MANAGERS), wrap(async (req, res) => {
  const ws = workspaceOf(req);
  const info = await wa.getPhoneInfo(ws);
  run('UPDATE workspaces SET wa_display_phone = ? WHERE id = ?', info.display_phone_number || null, ws.id);
  res.json(info);
}));

// ---------- Inbox ----------
router.get('/conversations', (req, res) => {
  const where = ['c.workspace_id = ?'];
  const params = [req.user.workspace_id];
  if (req.user.role === 'agent') { where.push('(c.assigned_to IS NULL OR c.assigned_to = ?)'); params.push(req.user.id); }
  if (['open', 'closed'].includes(req.query.status)) { where.push('c.status = ?'); params.push(req.query.status); }
  if (req.query.filter === 'mine') { where.push('c.assigned_to = ?'); params.push(req.user.id); }
  if (req.query.filter === 'unassigned') where.push('c.assigned_to IS NULL');
  if (req.query.q) {
    where.push('(ct.name LIKE ? OR ct.wa_id LIKE ?)');
    const q = `%${str(req.query.q, 100)}%`;
    params.push(q, q);
  }
  const rows = all(`
    SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT 300`, ...params);
  res.json(rows.map((r) => inbox.conversationView(r.id)));
});

router.post('/conversations', (req, res) => {
  const waId = normalizePhone(req.body.phone);
  if (waId.length < 8 || waId.length > 15) return badRequest(res, 'দেশের কোডসহ সঠিক নাম্বার দিন (যেমন 8801XXXXXXXXX)');
  const convId = tx(() => inbox.upsertContactConversation(req.user.workspace_id, waId, str(req.body.name, 120) || null));
  const conv = inbox.conversationView(convId);
  if (!inbox.canAccess(req.user, conv)) return res.status(403).json({ error: 'এই চ্যাটটি অন্য এজেন্টকে দেওয়া আছে' });
  if (req.user.role === 'agent' && conv.assigned_to == null) {
    run('UPDATE conversations SET assigned_to = ? WHERE id = ?', req.user.id, convId);
  }
  res.status(201).json(inbox.conversationView(convId));
});

router.get('/conversations/:id/messages', (req, res) => {
  const conv = loadConversation(req, res);
  if (!conv) return;
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = all(`
    SELECT m.*, u.name AS sent_by_name FROM messages m LEFT JOIN users u ON u.id = m.sent_by
    WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT 100`, conv.id, before);
  res.json({ conversation: conv, messages: rows.reverse() });
});

router.post('/conversations/:id/read', wrap(async (req, res) => {
  const conv = loadConversation(req, res);
  if (!conv) return;
  run('UPDATE conversations SET unread = 0 WHERE id = ?', conv.id);
  inbox.broadcastConversation(inbox.conversationView(conv.id));
  res.json({ ok: true });
  // Blue ticks for the customer: mark their latest message as read on WhatsApp (best effort).
  const last = get(`SELECT wa_message_id FROM messages WHERE conversation_id = ? AND direction = 'in'
                    AND wa_message_id IS NOT NULL ORDER BY id DESC LIMIT 1`, conv.id);
  if (last && conv.unread > 0) wa.markRead(workspaceOf(req), last.wa_message_id).catch(() => {});
}));

router.patch('/conversations/:id', (req, res) => {
  const conv = loadConversation(req, res);
  if (!conv) return;
  if (req.body.status !== undefined) {
    if (!['open', 'closed'].includes(req.body.status)) return badRequest(res, 'ভুল স্ট্যাটাস');
    run('UPDATE conversations SET status = ? WHERE id = ?', req.body.status, conv.id);
  }
  if (req.body.assigned_to !== undefined) {
    const assignee = req.body.assigned_to === null ? null : Number(req.body.assigned_to);
    if (req.user.role === 'agent' && assignee !== req.user.id && !(assignee === null && conv.assigned_to === req.user.id)) {
      return res.status(403).json({ error: 'এজেন্ট শুধু নিজেকে চ্যাট অ্যাসাইন করতে পারবে' });
    }
    if (assignee !== null && !get('SELECT 1 FROM users WHERE id = ? AND workspace_id = ? AND active = 1', assignee, req.user.workspace_id)) {
      return badRequest(res, 'ইউজার পাওয়া যায়নি');
    }
    run('UPDATE conversations SET assigned_to = ? WHERE id = ?', assignee, conv.id);
    logActivity(req.user.workspace_id, req.user.id, 'conversation.assigned', `+${conv.wa_id} → ${assignee ?? 'unassigned'}`);
  }
  if (req.body.contact_name !== undefined) {
    run('UPDATE contacts SET name = ? WHERE id = ?', str(req.body.contact_name, 120) || null, conv.contact_id);
  }
  const updated = inbox.conversationView(conv.id);
  inbox.broadcastConversation(updated);
  // Tell agents who lost access to drop the chat from their list.
  events.publish(req.user.workspace_id, 'conversation_hidden', { id: conv.id }, (u) => !inbox.canAccess(u, updated));
  res.json(updated);
});

async function sendAndStore(req, res, conv, type, body, sender) {
  const ws = workspaceOf(req);
  try {
    const waMessageId = await sender(ws);
    res.status(201).json(inbox.storeOutbound(conv, { type, body, waMessageId, status: 'sent', userId: req.user.id }));
  } catch (err) {
    if (!(err instanceof wa.WhatsAppError)) throw err;
    const message = inbox.storeOutbound(conv, { type, body, status: 'failed', error: err.message, userId: req.user.id });
    res.status(502).json({ error: err.message, message });
  }
}

router.post('/conversations/:id/messages', wrap(async (req, res) => {
  const conv = loadConversation(req, res);
  if (!conv) return;
  const text = str(req.body.text, 4096);
  if (!text) return badRequest(res, 'মেসেজ লিখুন');
  if (!conv.window_open) {
    return badRequest(res, 'গ্রাহক গত ২৪ ঘণ্টায় মেসেজ দেননি — WhatsApp নিয়ম অনুযায়ী এখন শুধু অনুমোদিত টেমপ্লেট পাঠানো যাবে।');
  }
  if (req.user.role === 'agent' && conv.assigned_to == null) {
    run('UPDATE conversations SET assigned_to = ? WHERE id = ?', req.user.id, conv.id);
  }
  await sendAndStore(req, res, conv, 'text', text, (ws) => wa.sendText(ws, conv.wa_id, text));
}));

router.post('/conversations/:id/template', wrap(async (req, res) => {
  const conv = loadConversation(req, res);
  if (!conv) return;
  const name = str(req.body.name, 512);
  const language = str(req.body.language, 20) || 'en_US';
  const params = Array.isArray(req.body.params) ? req.body.params.map((p) => str(p, 1000)) : [];
  if (!name) return badRequest(res, 'টেমপ্লেট বাছাই করুন');
  const preview = str(req.body.preview, 4096) || `[template: ${name}]`;
  await sendAndStore(req, res, conv, 'template', preview, (ws) => wa.sendTemplate(ws, conv.wa_id, name, language, params));
}));

router.get('/templates', wrap(async (req, res) => {
  const list = await wa.listTemplates(workspaceOf(req));
  res.json(list.filter((t) => t.status === 'APPROVED'));
}));

router.get('/media/:mediaId', wrap(async (req, res) => {
  const msg = get('SELECT conversation_id FROM messages WHERE media_id = ? AND workspace_id = ?', req.params.mediaId, req.user.workspace_id);
  if (!msg) return res.sendStatus(404);
  const conv = inbox.conversationView(msg.conversation_id);
  if (!inbox.canAccess(req.user, conv)) return res.sendStatus(403);
  const { res: media, mimeType } = await wa.downloadMedia(workspaceOf(req), req.params.mediaId);
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(Buffer.from(await media.arrayBuffer()));
}));

// ---------- Quick replies ----------
router.get('/quick-replies', (req, res) => {
  res.json(all('SELECT id, title, body FROM quick_replies WHERE workspace_id = ? ORDER BY title', req.user.workspace_id));
});

router.post('/quick-replies', requireRole(...MANAGERS), (req, res) => {
  const title = str(req.body.title, 80);
  const body = str(req.body.body, 4096);
  if (!title || !body) return badRequest(res, 'শিরোনাম ও মেসেজ দুটোই দিন');
  const r = run('INSERT INTO quick_replies (workspace_id, title, body) VALUES (?, ?, ?)', req.user.workspace_id, title, body);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

router.delete('/quick-replies/:id', requireRole(...MANAGERS), (req, res) => {
  run('DELETE FROM quick_replies WHERE id = ? AND workspace_id = ?', Number(req.params.id), req.user.workspace_id);
  res.json({ ok: true });
});

// ---------- Dashboard & activity ----------
router.get('/stats', (req, res) => {
  const ws = req.user.workspace_id;
  const one = (sql, ...p) => Object.values(get(sql, ws, ...p))[0];
  res.json({
    open: one("SELECT COUNT(*) FROM conversations WHERE workspace_id = ? AND status = 'open'"),
    unassigned: one("SELECT COUNT(*) FROM conversations WHERE workspace_id = ? AND status = 'open' AND assigned_to IS NULL"),
    unread: one('SELECT COALESCE(SUM(unread), 0) FROM conversations WHERE workspace_id = ?'),
    contacts: one('SELECT COUNT(*) FROM contacts WHERE workspace_id = ?'),
    inbound_today: one("SELECT COUNT(*) FROM messages WHERE workspace_id = ? AND direction = 'in' AND created_at >= date('now')"),
    outbound_today: one("SELECT COUNT(*) FROM messages WHERE workspace_id = ? AND direction = 'out' AND created_at >= date('now')"),
    per_agent: all(`
      SELECT u.id, u.name, u.role,
        (SELECT COUNT(*) FROM conversations c WHERE c.assigned_to = u.id AND c.status = 'open') AS open_chats,
        (SELECT COUNT(*) FROM messages m WHERE m.sent_by = u.id AND m.created_at >= date('now')) AS sent_today
      FROM users u WHERE u.workspace_id = ? AND u.active = 1 ORDER BY sent_today DESC, u.name`, ws),
  });
});

router.get('/activity', requireRole(...MANAGERS), (req, res) => {
  res.json(all(`SELECT a.id, a.action, a.detail, a.created_at, u.name AS user_name FROM activity a
                LEFT JOIN users u ON u.id = a.user_id WHERE a.workspace_id = ? ORDER BY a.id DESC LIMIT 200`,
  req.user.workspace_id));
});

// ---------- Testing without a live WhatsApp number ----------
router.post('/simulate-inbound', requireRole(...MANAGERS), (req, res) => {
  const waId = normalizePhone(req.body.phone);
  const text = str(req.body.text, 4096);
  if (waId.length < 8 || !text) return badRequest(res, 'নাম্বার ও মেসেজ দিন');
  const result = inbox.storeInbound(req.user.workspace_id, {
    waId, name: str(req.body.name, 120) || null, waMessageId: null, type: 'text', body: text,
  });
  res.status(201).json(result);
});

router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof wa.WhatsAppError) return res.status(err.status >= 500 ? 502 : 400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'সার্ভারে সমস্যা হয়েছে' });
});

module.exports = router;
