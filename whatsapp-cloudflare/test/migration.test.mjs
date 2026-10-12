// Upgrading a live v1 database (one number per workspace) to v2 (numbers, labels, notes) must keep every chat and message.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

let worker, base, stateDir;
const env = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', WRANGLER_SEND_METRICS: 'false', CI: '1' };
const pbkdf2 = (pw) => {
  const salt = crypto.randomBytes(16);
  return `pbkdf2:100000:${salt.toString('hex')}:${crypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('hex')}`;
};

// The schema exactly as v1 (the version first deployed) created it.
const V1 = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, wa_phone_number_id TEXT UNIQUE, wa_business_account_id TEXT,
  wa_access_token TEXT, wa_app_secret TEXT, wa_verify_token TEXT NOT NULL, wa_display_phone TEXT, created_ms INTEGER NOT NULL);
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','agent')), active INTEGER NOT NULL DEFAULT 1, last_login_ms INTEGER, created_ms INTEGER NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_ms INTEGER NOT NULL);
CREATE TABLE login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_ms INTEGER NOT NULL);
CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wa_id TEXT NOT NULL, name TEXT, created_ms INTEGER NOT NULL, UNIQUE (workspace_id, wa_id));
CREATE TABLE conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE, assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')), unread INTEGER NOT NULL DEFAULT 0, last_message_ms INTEGER,
  last_message_preview TEXT, last_inbound_ms INTEGER, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL);
CREATE INDEX idx_conv_ws ON conversations(workspace_id, last_message_ms DESC);
CREATE INDEX idx_conv_updated ON conversations(workspace_id, updated_ms);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  type TEXT NOT NULL DEFAULT 'text', body TEXT, media_id TEXT, wa_message_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'received', error TEXT,
  sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL);
CREATE INDEX idx_msg_conv ON messages(conversation_id, id);
CREATE INDEX idx_msg_updated ON messages(conversation_id, updated_ms);
CREATE TABLE quick_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL, created_ms INTEGER NOT NULL);
CREATE TABLE activity (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL, detail TEXT, created_ms INTEGER NOT NULL);
CREATE INDEX idx_activity_ws ON activity(workspace_id, id DESC);
`;

before(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mig-'));
  const now = Date.now();
  const seed = `${V1}
INSERT INTO workspaces (id, name, wa_phone_number_id, wa_verify_token, created_ms) VALUES (1, 'পুরনো একাডেমি', '555666', 'old-verify-token', ${now});
INSERT INTO users (id, workspace_id, name, email, password_hash, role, created_ms) VALUES
  (1, 1, 'Owner', 'o@old.com', '${pbkdf2('password1')}', 'owner', ${now}),
  (2, 1, 'Agent', 'a@old.com', '${pbkdf2('password1')}', 'agent', ${now});
INSERT INTO contacts (id, workspace_id, wa_id, name, created_ms) VALUES (1, 1, '8801711000001', 'করিম', ${now}), (2, 1, '8801711000002', 'রহিম', ${now});
INSERT INTO conversations (id, workspace_id, contact_id, assigned_to, status, unread, last_message_ms, last_message_preview, last_inbound_ms, created_ms, updated_ms)
  VALUES (7, 1, 1, 2, 'open', 1, ${now}, 'আসসালামু আলাইকুম', ${now}, ${now}, ${now}), (8, 1, 2, NULL, 'closed', 0, ${now - 1000}, 'ধন্যবাদ', ${now - 2000}, ${now}, ${now});
INSERT INTO messages (workspace_id, conversation_id, direction, type, body, wa_message_id, status, sent_by, created_ms, updated_ms) VALUES
  (1, 7, 'in', 'text', 'আসসালামু আলাইকুম', 'wamid.old1', 'received', NULL, ${now - 5000}, ${now - 5000}),
  (1, 7, 'out', 'text', 'ওয়ালাইকুম সালাম', 'wamid.old2', 'read', 2, ${now - 4000}, ${now - 4000}),
  (1, 8, 'in', 'text', 'ধন্যবাদ', 'wamid.old3', 'received', NULL, ${now - 2000}, ${now - 2000});
INSERT INTO quick_replies (workspace_id, title, body, created_ms) VALUES (1, 'ফি', '২০০০ টাকা', ${now});
`;
  const sqlFile = path.join(stateDir, 'seed.sql');
  fs.writeFileSync(sqlFile, seed);
  execFileSync('node_modules/.bin/wrangler', ['d1', 'execute', 'DB', '--local', '--persist-to', stateDir, '--file', sqlFile, '--yes'], { env, stdio: 'pipe' });

  const port = 8900 + Math.floor(Math.random() * 90);
  base = `http://127.0.0.1:${port}`;
  worker = spawn('node_modules/.bin/wrangler', ['dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', stateDir], { env, stdio: 'ignore', detached: true });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/config')).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start');
});

after(() => {
  try { process.kill(-worker.pid, 'SIGTERM'); } catch { /* gone */ }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function login(email) {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'password1' }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (p) => (await fetch(base + p, { headers: { Cookie: cookie } })).json();
}

test('v1 data survives the upgrade to numbers, labels and notes', async () => {
  const owner = await login('o@old.com');
  const me = await owner('/api/me');
  assert.equal(me.numbers.length, 1);
  assert.equal(me.numbers[0].label, 'প্রধান নাম্বার');
  const numberId = me.numbers[0].id;

  const convs = await owner('/api/conversations?status=');
  assert.deepEqual(convs.map((c) => c.id).sort(), [7, 8]);
  assert.ok(convs.every((c) => c.number_id === numberId));
  const c7 = convs.find((c) => c.id === 7);
  assert.equal(c7.contact_name, 'করিম');
  assert.equal(c7.assigned_name, 'Agent');
  assert.equal(c7.unread, 1);
  assert.deepEqual(c7.label_ids, []);

  const m7 = await owner('/api/conversations/7/messages');
  assert.deepEqual(m7.messages.map((m) => m.body), ['আসসালামু আলাইকুম', 'ওয়ালাইকুম সালাম']);
  assert.equal(m7.messages[1].sent_by_name, 'Agent');
  assert.equal((await owner('/api/conversations/8/messages')).messages.length, 1);

  // WhatsApp settings moved onto the number; the webhook verify token is unchanged.
  const settings = await owner(`/api/numbers/${numberId}`);
  assert.equal(settings.wa_phone_number_id, '555666');
  assert.equal(settings.verify_token, 'old-verify-token');
  const verify = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=old-verify-token&hub.challenge=ok`);
  assert.equal(await verify.text(), 'ok');

  // Existing team members keep access; starter labels and quick replies are there.
  const agent = await login('a@old.com');
  assert.deepEqual((await agent('/api/conversations?status=')).map((c) => c.id).sort(), [7, 8]);
  assert.equal((await owner('/api/labels')).length, 4);
  assert.equal((await owner('/api/quick-replies'))[0].title, 'ফি');

  // A new inbound message for the old phone number id lands in the existing chat (foreign keys intact).
  await fetch(base + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '555666' }, contacts: [{ wa_id: '8801711000001', profile: { name: 'করিম' } }],
    messages: [{ from: '8801711000001', id: 'wamid.new1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'নতুন মেসেজ' } }],
  } }] }] }) });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await owner('/api/conversations/7/messages')).messages.at(-1).body, 'নতুন মেসেজ');
});
