// End-to-end tests against `wrangler dev` (real Workers runtime + local D1) with a fake Meta Graph API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const graphCalls = [];
let graph, worker, base, stateDir;

before(async () => {
  graph = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      graphCalls.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.includes('/messages')) return res.end(JSON.stringify({ messages: [{ id: `wamid.out${graphCalls.length}` }] }));
      if (req.url.includes('message_templates')) {
        return res.end(JSON.stringify({ data: [{ name: 'hello', language: 'bn', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}' }] }] }));
      }
      res.end(JSON.stringify({ display_phone_number: '+880 1700', verified_name: 'Test Biz' }));
    });
  }).listen(0);
  await new Promise((r) => graph.once('listening', r));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cf-'));
  const port = 8800 + Math.floor(Math.random() * 100);
  base = `http://127.0.0.1:${port}`;
  worker = spawn('node_modules/.bin/wrangler', ['dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', stateDir,
    '--var', `GRAPH_BASE_URL:http://127.0.0.1:${graph.address().port}`], {
    env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', WRANGLER_SEND_METRICS: 'false', CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let log = '';
  worker.stdout.on('data', (d) => (log += d));
  worker.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(base + '/api/config')).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start:\n' + log);
});

after(() => {
  try { process.kill(-worker.pid, 'SIGTERM'); } catch { /* already gone */ }
  graph?.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  return async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}

const owner = client();
const admin = client();
const agent = client();
let agentId, adminId, verifyToken, convId;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function signedWebhook(payload, secret = 'app-secret') {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return fetch(base + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
}
const inbound = (id, text, from = '8801711111111') => ({ entry: [{ changes: [{ field: 'messages', value: {
  metadata: { phone_number_id: '111222' },
  contacts: [{ wa_id: from, profile: { name: 'Rahim' } }],
  messages: [{ from, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
} }] }] });

test('static UI is served', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /WA Business Desk/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('first signup creates owner; further signups are closed', async () => {
  assert.equal((await client()('GET', '/api/config')).data.signupAllowed, true);
  const r = await owner('POST', '/api/signup', { workspaceName: 'Demo Biz', name: 'Owner', email: 'owner@x.com', password: 'password1' });
  assert.equal(r.status, 201);
  assert.equal((await owner('GET', '/api/me')).data.user.role, 'owner');
  assert.equal((await client()('GET', '/api/config')).data.signupAllowed, false);
  assert.equal((await client()('POST', '/api/signup', { workspaceName: 'X', name: 'X', email: 'x2@x.com', password: 'password1' })).status, 403);
});

test('auth required; form posts rejected; wrong password rejected', async () => {
  assert.equal((await client()('GET', '/api/conversations')).status, 401);
  assert.equal((await owner('POST', '/api/users', 'name=x', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await client()('POST', '/api/login', { email: 'owner@x.com', password: 'wrong-pass' })).status, 401);
});

test('owner adds admin; admin adds agent but not admin', async () => {
  let r = await owner('POST', '/api/users', { name: 'Admin', email: 'admin@x.com', role: 'admin', password: 'password1' });
  assert.equal(r.status, 201); adminId = r.data.id;
  assert.equal((await admin('POST', '/api/login', { email: 'admin@x.com', password: 'password1' })).status, 200);
  r = await admin('POST', '/api/users', { name: 'Agent', email: 'agent@x.com', role: 'agent', password: 'password1' });
  assert.equal(r.status, 201); agentId = r.data.id;
  assert.equal((await admin('POST', '/api/users', { name: 'A2', email: 'a2@x.com', role: 'admin', password: 'password1' })).status, 403);
  assert.equal((await agent('POST', '/api/login', { email: 'agent@x.com', password: 'password1' })).status, 200);
  assert.equal((await agent('GET', '/api/settings')).status, 403);
});

test('settings encrypt secrets and expose webhook details', async () => {
  let r = await owner('PUT', '/api/settings', { name: 'Demo Biz', wa_phone_number_id: '111222', wa_business_account_id: '999', wa_access_token: 'EAAGsecrettoken1234', wa_app_secret: 'app-secret' });
  assert.equal(r.status, 200);
  r = await owner('GET', '/api/settings');
  assert.equal(r.data.token_hint, '••••1234');
  assert.equal(r.data.app_secret_set, true);
  assert.equal(r.data.webhook_url, base + '/webhook');
  assert.ok(r.data.verify_token.length > 10);
  assert.ok(!JSON.stringify(r.data).includes('EAAGsecret'));
  verifyToken = r.data.verify_token;
  r = await owner('POST', '/api/settings/test', {});
  assert.equal(r.data.verified_name, 'Test Biz');
  assert.equal((await owner('GET', '/api/me')).data.workspace.connected, true);
});

test('webhook verify handshake', async () => {
  let res = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=42`);
  assert.equal(await res.text(), '42');
  res = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`);
  assert.equal(res.status, 403);
});

test('inbound messages: bad signature dropped, duplicates ignored, live updates delivered', async () => {
  const first = await owner('GET', '/api/updates');
  assert.deepEqual(first.data.conversations, []);
  const since = first.data.now - 1;
  await signedWebhook(inbound('wamid.forged', 'fake'), 'wrong-secret');
  assert.equal((await signedWebhook(inbound('wamid.in1', 'হ্যালো'))).status, 200);
  await signedWebhook(inbound('wamid.in1', 'হ্যালো'));
  await wait(300);
  const r = await owner('GET', '/api/conversations');
  assert.equal(r.data.length, 1);
  convId = r.data[0].id;
  assert.equal(r.data[0].contact_name, 'Rahim');
  assert.equal(r.data[0].unread, 1);
  assert.equal(r.data[0].window_open, true);
  const msgs = await owner('GET', `/api/conversations/${convId}/messages`);
  assert.deepEqual(msgs.data.messages.map((m) => m.body), ['হ্যালো']);
  const upd = await owner('GET', `/api/updates?since=${since}&conv=${convId}`);
  assert.equal(upd.data.conversations[0].id, convId);
  assert.equal(upd.data.messages.length, 1);
  assert.equal((await agent('GET', '/api/conversations')).data.length, 1);
});

test('reply goes to WhatsApp; status ticks never downgrade', async () => {
  const r = await agent('POST', `/api/conversations/${convId}/messages`, { text: 'ওয়ালাইকুম সালাম' });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'sent');
  assert.equal(graphCalls.find((c) => c.body?.type === 'text').body.to, '8801711111111');
  assert.equal((await owner('GET', `/api/conversations/${convId}/messages`)).data.conversation.assigned_to, agentId);
  const status = (s) => ({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111222' }, statuses: [{ id: r.data.wa_message_id, status: s }] } }] }] });
  await signedWebhook(status('read'));
  await wait(200);
  await signedWebhook(status('delivered'));
  await wait(300);
  const msgs = (await owner('GET', `/api/conversations/${convId}/messages`)).data.messages;
  assert.equal(msgs.at(-1).status, 'read');
});

test('read marks unread zero and sends blue ticks', async () => {
  assert.equal((await owner('POST', `/api/conversations/${convId}/read`, {})).status, 200);
  await wait(300);
  assert.equal((await owner('GET', '/api/conversations')).data[0].unread, 0);
  assert.ok(graphCalls.some((c) => c.body?.status === 'read' && c.body.message_id === 'wamid.in1'));
});

test('agents lose access to chats assigned to someone else', async () => {
  const before = (await agent('GET', '/api/updates')).data.now - 1;
  await owner('PATCH', `/api/conversations/${convId}`, { assigned_to: adminId });
  assert.equal((await agent('GET', '/api/conversations')).data.length, 0);
  assert.equal((await agent('GET', `/api/conversations/${convId}/messages`)).status, 403);
  assert.deepEqual((await agent('GET', `/api/updates?since=${before}`)).data.hidden, [convId]);
});

test('new chat outside 24h window needs a template', async () => {
  let r = await owner('POST', '/api/conversations', { phone: '+880 1822-222222', name: 'Karim' });
  assert.equal(r.status, 201);
  assert.equal(r.data.window_open, false);
  const id = r.data.id;
  assert.equal((await owner('POST', `/api/conversations/${id}/messages`, { text: 'hi' })).status, 400);
  assert.equal((await owner('GET', '/api/templates')).data[0].name, 'hello');
  r = await owner('POST', `/api/conversations/${id}/template`, { name: 'hello', language: 'bn', params: ['Karim'], preview: 'Hi Karim' });
  assert.equal(r.status, 201);
  assert.deepEqual(graphCalls.find((c) => c.body?.type === 'template').body.template.components[0].parameters, [{ type: 'text', text: 'Karim' }]);
});

test('simulated message, quick replies, stats, activity', async () => {
  assert.equal((await owner('POST', '/api/simulate-inbound', { phone: '8801700000000', name: 'T', text: 'test' })).status, 201);
  assert.equal((await owner('POST', '/api/quick-replies', { title: 'ফি', body: '২০০০ টাকা' })).status, 201);
  assert.equal((await agent('GET', '/api/quick-replies')).data[0].title, 'ফি');
  const s = (await owner('GET', `/api/stats?dayStart=${Date.now() - 3600e3}`)).data;
  assert.equal(s.contacts, 3);
  assert.ok(s.inbound_today >= 2);
  assert.ok((await owner('GET', '/api/activity')).data.some((a) => a.action === 'user.added'));
});

test('deactivated user is logged out', async () => {
  assert.equal((await admin('PATCH', `/api/users/${agentId}`, { active: false })).status, 200);
  assert.equal((await agent('GET', '/api/me')).status, 401);
  assert.equal((await agent('POST', '/api/login', { email: 'agent@x.com', password: 'password1' })).status, 403);
});
