// D1 schema (created automatically on first request, so deploying needs no migration step) and query helpers.
// All timestamps are epoch milliseconds.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    wa_phone_number_id TEXT UNIQUE,
    wa_business_account_id TEXT,
    wa_access_token TEXT,
    wa_app_secret TEXT,
    wa_verify_token TEXT NOT NULL,
    wa_display_phone TEXT,
    created_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','admin','agent')),
    active INTEGER NOT NULL DEFAULT 1,
    last_login_ms INTEGER,
    created_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    wa_id TEXT NOT NULL,
    name TEXT,
    created_ms INTEGER NOT NULL,
    UNIQUE (workspace_id, wa_id)
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    unread INTEGER NOT NULL DEFAULT 0,
    last_message_ms INTEGER,
    last_message_preview TEXT,
    last_inbound_ms INTEGER,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conv_ws ON conversations(workspace_id, last_message_ms DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(workspace_id, updated_ms)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    type TEXT NOT NULL DEFAULT 'text',
    body TEXT,
    media_id TEXT,
    wa_message_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'received',
    error TEXT,
    sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_msg_updated ON messages(conversation_id, updated_ms)`,
  `CREATE TABLE IF NOT EXISTS quick_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    detail TEXT,
    created_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_activity_ws ON activity(workspace_id, id DESC)`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_ms INTEGER NOT NULL
  )`,
];

// v2: several WhatsApp numbers per workspace (with per-number team access), labels and notes.
// conversations.contact_id was UNIQUE, so conversations (and messages, which reference them) are rebuilt.
// Order matters: with foreign keys on, dropping a parent table cascades into its children, so the child
// (messages) is copied and dropped first; renames then repoint the new tables' references.
const MIGRATION_V2 = [
  `CREATE TABLE numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    wa_phone_number_id TEXT UNIQUE,
    wa_business_account_id TEXT,
    wa_access_token TEXT,
    wa_app_secret TEXT,
    wa_display_phone TEXT,
    created_ms INTEGER NOT NULL
  )`,
  `INSERT INTO numbers (workspace_id, label, wa_phone_number_id, wa_business_account_id, wa_access_token, wa_app_secret, wa_display_phone, created_ms)
   SELECT id, 'প্রধান নাম্বার', wa_phone_number_id, wa_business_account_id, wa_access_token, wa_app_secret, wa_display_phone, created_ms FROM workspaces`,
  `UPDATE workspaces SET wa_phone_number_id = NULL, wa_business_account_id = NULL, wa_access_token = NULL, wa_app_secret = NULL, wa_display_phone = NULL`,
  `CREATE TABLE number_access (
    number_id INTEGER NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (number_id, user_id)
  )`,
  `INSERT INTO number_access (number_id, user_id) SELECT n.id, u.id FROM numbers n JOIN users u ON u.workspace_id = n.workspace_id`,
  `CREATE TABLE conversations_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    number_id INTEGER NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    unread INTEGER NOT NULL DEFAULT 0,
    last_message_ms INTEGER,
    last_message_preview TEXT,
    last_inbound_ms INTEGER,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL,
    UNIQUE (number_id, contact_id)
  )`,
  `INSERT INTO conversations_v2 (id, workspace_id, number_id, contact_id, assigned_to, status, unread, last_message_ms,
     last_message_preview, last_inbound_ms, created_ms, updated_ms)
   SELECT c.id, c.workspace_id, (SELECT MIN(n.id) FROM numbers n WHERE n.workspace_id = c.workspace_id), c.contact_id,
     c.assigned_to, c.status, c.unread, c.last_message_ms, c.last_message_preview, c.last_inbound_ms, c.created_ms, c.updated_ms
   FROM conversations c`,
  `CREATE TABLE messages_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations_v2(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    type TEXT NOT NULL DEFAULT 'text',
    body TEXT,
    media_id TEXT,
    wa_message_id TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'received',
    error TEXT,
    sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
  )`,
  `INSERT INTO messages_v2 (id, workspace_id, conversation_id, direction, type, body, media_id, wa_message_id, status, error, sent_by, created_ms, updated_ms)
   SELECT id, workspace_id, conversation_id, direction, type, body, media_id, wa_message_id, status, error, sent_by, created_ms, updated_ms FROM messages`,
  `DROP TABLE messages`,
  `DROP TABLE conversations`,
  `ALTER TABLE conversations_v2 RENAME TO conversations`,
  `ALTER TABLE messages_v2 RENAME TO messages`,
  `CREATE INDEX idx_conv_ws ON conversations(workspace_id, last_message_ms DESC)`,
  `CREATE INDEX idx_conv_updated ON conversations(workspace_id, updated_ms)`,
  `CREATE INDEX idx_conv_number ON conversations(number_id)`,
  `CREATE INDEX idx_msg_conv ON messages(conversation_id, id)`,
  `CREATE INDEX idx_msg_updated ON messages(conversation_id, updated_ms)`,
  `CREATE TABLE labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    UNIQUE (workspace_id, name)
  )`,
  `CREATE TABLE conversation_labels (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, label_id)
  )`,
  `CREATE INDEX idx_conv_labels_label ON conversation_labels(label_id)`,
  `CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX idx_notes_conv ON notes(conversation_id, id)`,
  `INSERT INTO labels (workspace_id, name, color, created_ms)
   SELECT w.id, l.name, l.color, w.created_ms FROM workspaces w
   CROSS JOIN (SELECT 'নতুন লিড' AS name, '#2563eb' AS color UNION ALL SELECT 'ফলো-আপ', '#ea580c'
               UNION ALL SELECT 'ভর্তি হয়েছে', '#16a34a' UNION ALL SELECT 'পেমেন্ট বাকি', '#dc2626') l`,
];

export const DEFAULT_LABELS = [['নতুন লিড', '#2563eb'], ['ফলো-আপ', '#ea580c'], ['ভর্তি হয়েছে', '#16a34a'], ['পেমেন্ট বাকি', '#dc2626']];
// v3: broadcasts (mass messages to labelled contacts) and broadcast opt-out.
const MIGRATION_V3 = [
  `ALTER TABLE contacts ADD COLUMN opted_out INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE broadcasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    number_id INTEGER NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('template','text')),
    template_name TEXT,
    template_language TEXT,
    template_category TEXT,
    body TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '[]',
    header TEXT,
    name_fallback TEXT,
    audience TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('scheduled','sending','done','cancelled')),
    scheduled_ms INTEGER NOT NULL,
    started_ms INTEGER,
    finished_ms INTEGER,
    created_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX idx_broadcasts_due ON broadcasts(status, scheduled_ms)`,
  `CREATE TABLE broadcast_recipients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    broadcast_id INTEGER NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    wa_id TEXT NOT NULL,
    name TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed','skipped')),
    wa_message_id TEXT,
    error TEXT,
    claimed_ms INTEGER,
    sent_ms INTEGER
  )`,
  `CREATE INDEX idx_bc_recipients ON broadcast_recipients(broadcast_id, status)`,
];

const MIGRATIONS = [[2, MIGRATION_V2], [3, MIGRATION_V3]];

async function schemaVersion(env) {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = 'schema_version'").first();
  return row ? Number(row.value) : 1;
}

async function migrate(env) {
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  for (const [version, statements] of MIGRATIONS) {
    if ((await schemaVersion(env)) >= version) continue;
    try {
      // One batch = one transaction: a migration either fully applies or not at all.
      await env.DB.batch([
        ...statements.map((sql) => env.DB.prepare(sql)),
        env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").bind(String(version)),
      ]);
    } catch (err) {
      // Another request may have migrated concurrently; that is fine.
      if ((await schemaVersion(env)) < version) throw err;
    }
  }
}

let ready = null;
export function ensureSchema(env) {
  if (!ready) {
    ready = migrate(env).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

// D1 rejects `undefined` bindings; normalise them to NULL.
const clean = (params) => params.map((p) => (p === undefined ? null : p));

export function makeDb(env) {
  const prep = (sql, params) => env.DB.prepare(sql).bind(...clean(params));
  return {
    first: (sql, ...params) => prep(sql, params).first(),
    all: async (sql, ...params) => (await prep(sql, params).all()).results,
    run: (sql, ...params) => prep(sql, params).run(),
    prep: (sql, ...params) => prep(sql, params),
    batch: (stmts) => env.DB.batch(stmts),
    log: (workspaceId, userId, action, detail) =>
      prep('INSERT INTO activity (workspace_id, user_id, action, detail, created_ms) VALUES (?, ?, ?, ?, ?)',
        [workspaceId, userId ?? null, action, detail ?? null, Date.now()]).run(),
  };
}
