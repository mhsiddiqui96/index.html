'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-saas-'));
process.env.DATA_DIR = dataDir;
process.env.SECRET_KEY = 'test-secret';
process.env.WEBHOOK_VERIFY_TOKEN = 'verify-me';
process.env.META_APP_SECRET = 'app-secret';

// Fake the Graph API; pass everything else to the real fetch.
const realFetch = global.fetch;
const graphCalls = [];
global.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://graph.facebook.com/')) {
    graphCalls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    if (String(url).includes('/messages')) return Response.json({ messages: [{ id: `wamid.out${graphCalls.length}` }] });
    if (String(url).includes('message_templates')) {
      return Response.json({ data: [{ name: 'hello', language: 'bn', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}' }] }] });
    }
    return Response.json({ display_phone_number: '+880 1700', verified_name: 'Test Biz' });
  }
  return realFetch(url, opts);
};

const { createApp } = require('../server');
let server, base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (method, p, body, headers = {}) => {
    const res = await realFetch(base + p, {
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
let agentId, adminId;

function signedWebhook(payload) {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(raw).digest('hex');
  return realFetch(base + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
}

test('signup creates owner and workspace', async () => {
  const r = await owner('POST', '/api/signup', { workspaceName: 'Demo Biz', name: 'Owner', email: 'owner@x.com', password: 'password1' });
  assert.equal(r.status, 201);
  const me = await owner('GET', '/api/me');
  assert.equal(me.data.user.role, 'owner');
  assert.equal(me.data.workspace.connected, false);
});

test('unauthenticated access is rejected; form posts are rejected', async () => {
  assert.equal((await client()('GET', '/api/conversations')).status, 401);
  assert.equal((await owner('POST', '/api/users', 'name=x', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
});

test('owner adds admin; admin adds agent but not admin', async () => {
  let r = await owner('POST', '/api/users', { name: 'Admin', email: 'admin@x.com', role: 'admin', password: 'password1' });
  assert.equal(r.status, 201); adminId = r.data.id;
  assert.equal((await admin('POST', '/api/login', { email: 'admin@x.com', password: 'password1' })).status, 200);
  r = await admin('POST', '/api/users', { name: 'Agent', email: 'agent@x.com', role: 'agent', password: 'password1' });
  assert.equal(r.status, 201); agentId = r.data.id;
  r = await admin('POST', '/api/users', { name: 'Admin2', email: 'admin2@x.com', role: 'admin', password: 'password1' });
  assert.equal(r.status, 403);
  assert.equal((await admin('PATCH', `/api/users/${adminId}`, { role: 'agent' })).status, 400); // self
  assert.equal((await agent('POST', '/api/login', { email: 'agent@x.com', password: 'password1' })).status, 200);
  assert.equal((await agent('POST', '/api/users', { name: 'X', email: 'x@x.com', role: 'agent', password: 'password1' })).status, 403);
  assert.equal((await agent('GET', '/api/settings')).status, 403);
});

test('settings store encrypted token and never return it', async () => {
  let r = await owner('PUT', '/api/settings', { name: 'Demo Biz', wa_phone_number_id: '111222', wa_business_account_id: '999', wa_access_token: 'EAAGsecrettoken1234' });
  assert.equal(r.status, 200);
  r = await owner('GET', '/api/settings');
  assert.equal(r.data.token_set, true);
  assert.equal(r.data.token_hint, '••••1234');
  assert.ok(!JSON.stringify(r.data).includes('EAAGsecret'));
  r = await owner('POST', '/api/settings/test', {});
  assert.equal(r.data.verified_name, 'Test Biz');
});

test('webhook verify handshake and signature check', async () => {
  let r = await realFetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
  assert.equal(await r.text(), '42');
  r = await realFetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`);
  assert.equal(r.status, 403);
  r = await realFetch(base + '/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
});

let convId;
test('inbound message creates conversation; duplicates ignored; agents see unassigned', async () => {
  const payload = { entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '111222' },
    contacts: [{ wa_id: '8801711111111', profile: { name: 'Rahim' } }],
    messages: [{ from: '8801711111111', id: 'wamid.in1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'হ্যালো' } }],
  } }] }] };
  assert.equal((await signedWebhook(payload)).status, 200);
  await signedWebhook(payload);
  await new Promise((r) => setTimeout(r, 50));
  const r = await owner('GET', '/api/conversations');
  assert.equal(r.data.length, 1);
  convId = r.data[0].id;
  assert.equal(r.data[0].contact_name, 'Rahim');
  assert.equal(r.data[0].unread, 1);
  assert.equal(r.data[0].window_open, true);
  const msgs = await owner('GET', `/api/conversations/${convId}/messages`);
  assert.equal(msgs.data.messages.length, 1);
  assert.equal((await agent('GET', '/api/conversations')).data.length, 1);
});

test('sending a reply calls Graph API and status webhooks update ticks', async () => {
  const r = await agent('POST', `/api/conversations/${convId}/messages`, { text: 'ওয়ালাইকুম সালাম' });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'sent');
  const call = graphCalls.find((c) => c.body?.type === 'text');
  assert.equal(call.body.to, '8801711111111');
  // agent auto-assigned
  const conv = (await owner('GET', `/api/conversations/${convId}/messages`)).data.conversation;
  assert.equal(conv.assigned_to, agentId);
  const status = (s) => ({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '111222' }, statuses: [{ id: r.data.wa_message_id, status: s }] } }] }] });
  await signedWebhook(status('read'));
  await signedWebhook(status('delivered')); // out of order — must not downgrade
  await new Promise((res) => setTimeout(res, 50));
  const msgs = (await owner('GET', `/api/conversations/${convId}/messages`)).data.messages;
  assert.equal(msgs.at(-1).status, 'read');
});

test('agent cannot see chats assigned to someone else', async () => {
  await owner('PATCH', `/api/conversations/${convId}`, { assigned_to: adminId });
  assert.equal((await agent('GET', '/api/conversations')).data.length, 0);
  assert.equal((await agent('GET', `/api/conversations/${convId}/messages`)).status, 403);
  assert.equal((await agent('POST', `/api/conversations/${convId}/messages`, { text: 'x' })).status, 403);
});

test('new chat outside 24h window requires template', async () => {
  let r = await owner('POST', '/api/conversations', { phone: '+880 1822-222222', name: 'Karim' });
  assert.equal(r.status, 201);
  assert.equal(r.data.window_open, false);
  const id = r.data.id;
  assert.equal((await owner('POST', `/api/conversations/${id}/messages`, { text: 'hi' })).status, 400);
  const tpls = await owner('GET', '/api/templates');
  assert.equal(tpls.data[0].name, 'hello');
  r = await owner('POST', `/api/conversations/${id}/template`, { name: 'hello', language: 'bn', params: ['Karim'], preview: 'Hi Karim' });
  assert.equal(r.status, 201);
  const call = graphCalls.find((c) => c.body?.type === 'template');
  assert.deepEqual(call.body.template.components[0].parameters, [{ type: 'text', text: 'Karim' }]);
});

test('deactivated user is logged out', async () => {
  assert.equal((await admin('PATCH', `/api/users/${agentId}`, { active: false })).status, 200);
  assert.equal((await agent('GET', '/api/me')).status, 401);
  assert.equal((await agent('POST', '/api/login', { email: 'agent@x.com', password: 'password1' })).status, 403);
});

test('workspaces are isolated', async () => {
  const other = client();
  await other('POST', '/api/signup', { workspaceName: 'Other', name: 'O', email: 'o@x.com', password: 'password1' });
  assert.equal((await other('GET', '/api/conversations')).data.length, 0);
  assert.equal((await other('GET', `/api/conversations/${convId}/messages`)).status, 404);
  assert.equal((await other('PATCH', `/api/users/${agentId}`, { active: true })).status, 404);
  assert.equal((await other('PUT', '/api/settings', { wa_phone_number_id: '111222' })).status, 400);
});
