'use strict';
// Shared inbox logic: storing inbound/outbound messages and building conversation views.
const { get, run, tx } = require('./db');
const events = require('./events');

const WINDOW_MS = 24 * 3600 * 1000;

function conversationView(id) {
  const c = get(`
    SELECT c.*, ct.wa_id, ct.name AS contact_name, u.name AS assigned_name
    FROM conversations c
    JOIN contacts ct ON ct.id = c.contact_id
    LEFT JOIN users u ON u.id = c.assigned_to
    WHERE c.id = ?`, id);
  if (!c) return null;
  c.window_open = !!c.last_inbound_at && Date.now() - Date.parse(c.last_inbound_at.replace(' ', 'T') + 'Z') < WINDOW_MS;
  return c;
}

function messageView(id) {
  return get(`
    SELECT m.*, u.name AS sent_by_name FROM messages m
    LEFT JOIN users u ON u.id = m.sent_by WHERE m.id = ?`, id);
}

// Agents see only chats assigned to them or unassigned; owners/admins see everything.
const canAccess = (user, conv) =>
  user.role !== 'agent' || conv.assigned_to == null || conv.assigned_to === user.id;

function broadcastConversation(conv, message) {
  events.publish(conv.workspace_id, 'conversation', { conversation: conv, message: message || null },
    (user) => canAccess(user, conv));
}

function upsertContactConversation(workspaceId, waId, name) {
  let contact = get('SELECT * FROM contacts WHERE workspace_id = ? AND wa_id = ?', workspaceId, waId);
  if (!contact) {
    const r = run('INSERT INTO contacts (workspace_id, wa_id, name) VALUES (?, ?, ?)', workspaceId, waId, name || null);
    contact = { id: Number(r.lastInsertRowid) };
  } else if (name && name !== contact.name) {
    run('UPDATE contacts SET name = ? WHERE id = ?', name, contact.id);
  }
  let conv = get('SELECT id FROM conversations WHERE contact_id = ?', contact.id);
  if (!conv) {
    const r = run('INSERT INTO conversations (workspace_id, contact_id) VALUES (?, ?)', workspaceId, contact.id);
    conv = { id: Number(r.lastInsertRowid) };
  }
  return conv.id;
}

function preview(type, body) {
  const text = body || `[${type}]`;
  return text.length > 80 ? text.slice(0, 80) + '…' : text;
}

function storeInbound(workspaceId, { waId, name, waMessageId, type, body, mediaId, timestamp }) {
  const result = tx(() => {
    if (waMessageId && get('SELECT 1 FROM messages WHERE wa_message_id = ?', waMessageId)) return null; // duplicate delivery
    const convId = upsertContactConversation(workspaceId, waId, name);
    const at = new Date(timestamp ? timestamp * 1000 : Date.now()).toISOString().slice(0, 19).replace('T', ' ');
    const r = run(`INSERT INTO messages (workspace_id, conversation_id, direction, type, body, media_id, wa_message_id, status, created_at)
                   VALUES (?, ?, 'in', ?, ?, ?, ?, 'received', ?)`,
      workspaceId, convId, type, body ?? null, mediaId ?? null, waMessageId ?? null, at);
    run(`UPDATE conversations SET unread = unread + 1, status = 'open', last_message_at = ?, last_inbound_at = ?,
           last_message_preview = ? WHERE id = ?`, at, at, preview(type, body), convId);
    return { convId, messageId: Number(r.lastInsertRowid) };
  });
  if (result) broadcastConversation(conversationView(result.convId), messageView(result.messageId));
  return result;
}

function storeOutbound(conv, { type, body, waMessageId, status, error, userId }) {
  const r = run(`INSERT INTO messages (workspace_id, conversation_id, direction, type, body, wa_message_id, status, error, sent_by)
                 VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?)`,
    conv.workspace_id, conv.id, type, body, waMessageId ?? null, status, error ?? null, userId);
  run(`UPDATE conversations SET last_message_at = datetime('now'), last_message_preview = ? WHERE id = ?`,
    preview(type, body), conv.id);
  const message = messageView(Number(r.lastInsertRowid));
  broadcastConversation(conversationView(conv.id), message);
  return message;
}

const STATUS_RANK = { failed: 0, pending: 1, sent: 2, delivered: 3, read: 4 };

function updateStatus(workspaceId, waMessageId, status, error) {
  const msg = get('SELECT id, status, conversation_id FROM messages WHERE wa_message_id = ? AND workspace_id = ?',
    waMessageId, workspaceId);
  if (!msg) return;
  // Webhooks can arrive out of order; never downgrade read -> delivered etc. (failed always wins).
  if (status !== 'failed' && (STATUS_RANK[msg.status] ?? 0) >= (STATUS_RANK[status] ?? 0)) return;
  run('UPDATE messages SET status = ?, error = ? WHERE id = ?', status, error ?? null, msg.id);
  const conv = conversationView(msg.conversation_id);
  events.publish(workspaceId, 'status', { conversation_id: msg.conversation_id, message_id: msg.id, status, error: error ?? null },
    (user) => canAccess(user, conv));
}

module.exports = {
  conversationView, messageView, canAccess, broadcastConversation,
  upsertContactConversation, storeInbound, storeOutbound, updateStatus,
};
