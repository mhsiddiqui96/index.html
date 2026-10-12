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
];

let ready = null;
export function ensureSchema(env) {
  if (!ready) {
    ready = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => {
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
