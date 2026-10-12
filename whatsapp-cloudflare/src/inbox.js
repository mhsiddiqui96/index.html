// Shared inbox logic: storing inbound/outbound messages, conversation views and who may see what.
const WINDOW_MS = 24 * 3600 * 1000;

const CONV_SELECT = `
  SELECT c.*, ct.wa_id, ct.name AS contact_name, u.name AS assigned_name, n.label AS number_label,
    (SELECT json_group_array(cl.label_id) FROM conversation_labels cl WHERE cl.conversation_id = c.id) AS label_ids,
    (SELECT COUNT(*) FROM notes nt WHERE nt.conversation_id = c.id) AS note_count
  FROM conversations c
  JOIN contacts ct ON ct.id = c.contact_id
  JOIN numbers n ON n.id = c.number_id
  LEFT JOIN users u ON u.id = c.assigned_to`;

export function decorate(c) {
  if (!c) return c;
  c.window_open = !!c.last_inbound_ms && Date.now() - c.last_inbound_ms < WINDOW_MS;
  try { c.label_ids = JSON.parse(c.label_ids || '[]'); } catch { c.label_ids = []; }
  return c;
}

export async function conversationView(db, id) {
  return decorate(await db.first(`${CONV_SELECT} WHERE c.id = ?`, id));
}

export async function conversationsWhere(db, where, params, limit = 300) {
  const rows = await db.all(`${CONV_SELECT} WHERE ${where} ORDER BY COALESCE(c.last_message_ms, c.created_ms) DESC LIMIT ${limit}`, ...params);
  return rows.map(decorate);
}

export const MESSAGE_SELECT = 'SELECT m.*, u.name AS sent_by_name FROM messages m LEFT JOIN users u ON u.id = m.sent_by';

// Owners see every number; admins and agents only the numbers they were given.
// On top of that, agents see only chats assigned to them or unassigned.
export const canAccess = (user, conv) =>
  (user.role === 'owner' || (user.numberIds || []).includes(conv.number_id)) &&
  (user.role !== 'agent' || conv.assigned_to == null || conv.assigned_to === user.id);

// SQL fragment limiting conversations (alias c) to the user's numbers.
export const numberScope = (user) => (user.role === 'owner'
  ? ['1 = 1', []]
  : ['c.number_id IN (SELECT number_id FROM number_access WHERE user_id = ?)', [user.id]]);

function preview(type, body) {
  const text = body || `[${type}]`;
  return text.length > 80 ? text.slice(0, 80) + '…' : text;
}

export async function upsertConversation(db, workspaceId, numberId, waId, name) {
  const now = Date.now();
  const contact = await db.first(
    `INSERT INTO contacts (workspace_id, wa_id, name, created_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, wa_id) DO UPDATE SET name = COALESCE(excluded.name, contacts.name)
     RETURNING id`, workspaceId, waId, name || null, now);
  await db.run(
    `INSERT INTO conversations (workspace_id, number_id, contact_id, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (number_id, contact_id) DO NOTHING`, workspaceId, numberId, contact.id, now, now);
  const conv = await db.first('SELECT id FROM conversations WHERE number_id = ? AND contact_id = ?', numberId, contact.id);
  return conv.id;
}

export async function storeInbound(db, workspaceId, numberId, { waId, name, waMessageId, type, body, mediaId, timestampMs }) {
  if (waMessageId && await db.first('SELECT 1 FROM messages WHERE wa_message_id = ?', waMessageId)) return null; // Meta retried
  const convId = await upsertConversation(db, workspaceId, numberId, waId, name);
  const at = Math.min(timestampMs || Date.now(), Date.now());
  const now = Date.now();
  const inserted = await db.first(
    `INSERT INTO messages (workspace_id, conversation_id, direction, type, body, media_id, wa_message_id, status, created_ms, updated_ms)
     VALUES (?, ?, 'in', ?, ?, ?, ?, 'received', ?, ?)
     ON CONFLICT (wa_message_id) DO NOTHING RETURNING id`,
    workspaceId, convId, type, body ?? null, mediaId ?? null, waMessageId ?? null, at, now);
  if (!inserted) return null;
  await db.run(
    `UPDATE conversations SET unread = unread + 1, status = 'open', last_message_ms = ?, last_inbound_ms = ?,
       last_message_preview = ?, updated_ms = ? WHERE id = ?`, at, at, preview(type, body), now, convId);
  return { convId, messageId: inserted.id };
}

export async function storeOutbound(db, conv, { type, body, waMessageId, status, error, userId }) {
  const now = Date.now();
  const row = await db.first(
    `INSERT INTO messages (workspace_id, conversation_id, direction, type, body, wa_message_id, status, error, sent_by, created_ms, updated_ms)
     VALUES (?, ?, 'out', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    conv.workspace_id, conv.id, type, body, waMessageId ?? null, status, error ?? null, userId, now, now);
  await db.run('UPDATE conversations SET last_message_ms = ?, last_message_preview = ?, updated_ms = ? WHERE id = ?',
    now, preview(type, body), now, conv.id);
  return db.first(`${MESSAGE_SELECT} WHERE m.id = ?`, row.id);
}

const STATUS_RANK = { failed: 0, pending: 1, sent: 2, delivered: 3, read: 4 };

export async function updateStatus(db, workspaceId, waMessageId, status, error) {
  const msg = await db.first('SELECT id, status, conversation_id FROM messages WHERE wa_message_id = ? AND workspace_id = ?',
    waMessageId, workspaceId);
  if (!msg) return;
  // Webhooks can arrive out of order; never downgrade read -> delivered (failed always wins).
  if (status !== 'failed' && (STATUS_RANK[msg.status] ?? 0) >= (STATUS_RANK[status] ?? 0)) return;
  const now = Date.now();
  await db.batch([
    db.prep('UPDATE messages SET status = ?, error = ?, updated_ms = ? WHERE id = ?', status, error ?? null, now, msg.id),
    db.prep('UPDATE conversations SET updated_ms = ? WHERE id = ?', now, msg.conversation_id),
  ]);
}
