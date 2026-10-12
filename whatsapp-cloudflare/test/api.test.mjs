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
const pushCalls = [];
let graph, worker, base, stateDir;

before(async () => {
  graph = http.createServer((req, res) => {
    let raw = '';
    const chunks = [];
    let rawBuf;
    req.on('data', (c) => { chunks.push(c); raw += c; });
    req.on('end', () => { rawBuf = Buffer.concat(chunks); });
    req.on('end', () => {
      if (req.url.startsWith('/push/')) {
        pushCalls.push({ url: req.url, headers: req.headers, body: Buffer.from(rawBuf) });
        res.statusCode = req.url.includes('gone') ? 410 : 201;
        return res.end();
      }
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
    '--var', `GRAPH_BASE_URL:http://127.0.0.1:${graph.address().port}`, '--var', 'ALLOW_HTTP_PUSH:true'], {
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
let agentId, adminId, verifyToken, convId, numberId;
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
  assert.match(await res.text(), /WA Business SaaS/);
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
  assert.equal((await agent('PUT', '/api/workspace', { name: 'x' })).status, 403);
});

test('number settings encrypt secrets and expose webhook details', async () => {
  const me = (await owner('GET', '/api/me')).data;
  assert.equal(me.numbers.length, 1);
  assert.equal(me.numbers[0].label, 'প্রধান নাম্বার');
  numberId = me.numbers[0].id;
  let r = await owner('PUT', `/api/numbers/${numberId}`, { label: 'ভর্তি', wa_phone_number_id: '111222', wa_business_account_id: '999', wa_access_token: 'EAAGsecrettoken1234', wa_app_secret: 'app-secret' });
  assert.equal(r.status, 200);
  assert.equal((await agent('GET', `/api/numbers/${numberId}`)).status, 403);
  r = await owner('GET', `/api/numbers/${numberId}`);
  assert.equal(r.data.label, 'ভর্তি');
  assert.equal(r.data.token_hint, '••••1234');
  assert.equal(r.data.app_secret_set, true);
  assert.equal(r.data.webhook_url, base + '/webhook');
  assert.ok(r.data.verify_token.length > 10);
  assert.ok(!JSON.stringify(r.data).includes('EAAGsecret'));
  verifyToken = r.data.verify_token;
  r = await owner('POST', `/api/numbers/${numberId}/test`, {});
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
  assert.equal((await owner('GET', `/api/conversations/${id}/templates`)).data[0].name, 'hello');
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

// --- Web Push: a fake browser subscription whose payloads we decrypt per RFC 8291 ---
function fakeDevice(name) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh, auth,
    sub: { endpoint: `http://127.0.0.1:${graph.address().port}/push/${name}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
  };
}
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
function decryptPush(device, body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = device.ecdh.computeSecret(asPublic);
  const ikm = hmac(hmac(device.auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), device.ecdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2);
  return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}
const pushesTo = (name) => pushCalls.filter((c) => c.url === `/push/${name}`);

test('push: VAPID-signed, encrypted notifications reach every allowed team member', async () => {
  const { publicKey } = (await owner('GET', '/api/push/key')).data;
  assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
  const devices = { owner: fakeDevice('owner'), admin: fakeDevice('admin'), agent: fakeDevice('agent'), gone: fakeDevice('gone') };
  assert.equal((await owner('POST', '/api/push/subscribe', devices.owner.sub)).status, 201);
  assert.equal((await admin('POST', '/api/push/subscribe', devices.admin.sub)).status, 201);
  assert.equal((await agent('POST', '/api/push/subscribe', devices.agent.sub)).status, 201);
  assert.equal((await owner('POST', '/api/push/subscribe', devices.gone.sub)).status, 201);
  assert.equal((await owner('POST', '/api/push/subscribe', { endpoint: 'ftp://x', keys: {} })).status, 400);

  // New unassigned chat: owner, admin and agent are all notified.
  await owner('POST', '/api/simulate-inbound', { phone: '8801999999999', name: 'নতুন লিড', text: 'ভর্তি হতে চাই' });
  await wait(1000);
  for (const who of ['owner', 'admin', 'agent']) {
    const calls = pushesTo(who);
    assert.equal(calls.length, 1, `${who} should get one push`);
    const payload = decryptPush(devices[who], calls[0].body);
    assert.equal(payload.title, 'নতুন লিড');
    assert.equal(payload.body, 'ভর্তি হতে চাই');
    assert.match(payload.url, /^\/#\/inbox\/\d+$/);
    // VAPID JWT is signed by the advertised key and addressed to the push service origin.
    const [, jwt, k] = calls[0].headers.authorization.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.equal(k, publicKey);
    const [h, c, sig] = jwt.split('.');
    const pub = Buffer.from(publicKey, 'base64url');
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
    assert.equal(JSON.parse(Buffer.from(c, 'base64url')).aud, `http://127.0.0.1:${graph.address().port}`);
    assert.equal(calls[0].headers['content-encoding'], 'aes128gcm');
  }
  // The 410 Gone device was forgotten: no second attempt.
  assert.equal(pushesTo('gone').length, 1);

  // A chat assigned to the admin (via the real webhook): owner + admin notified, agent not.
  await signedWebhook(inbound('wamid.in2', 'আবার মেসেজ'));
  await wait(1000);
  assert.equal(pushesTo('owner').length, 2);
  assert.equal(pushesTo('admin').length, 2);
  assert.equal(pushesTo('agent').length, 1);
  assert.equal(pushesTo('gone').length, 1);

  // Test button and unsubscribe.
  assert.equal((await admin('POST', '/api/push/test', {})).data.devices, 1);
  await admin('POST', '/api/push/unsubscribe', { endpoint: devices.admin.sub.endpoint });
  assert.equal((await admin('POST', '/api/push/test', {})).status, 400);
});

test('labels: anyone creates, managers edit/delete; chats can be tagged, filtered and annotated', async () => {
  const defaults = (await owner('GET', '/api/labels')).data;
  assert.deepEqual(defaults.map((l) => l.name), ['নতুন লিড', 'ফলো-আপ', 'ভর্তি হয়েছে', 'পেমেন্ট বাকি']);
  const created = await agent('POST', '/api/labels', { name: 'ক্লাস ৫', color: '#123ABC' });
  assert.equal(created.status, 201);
  assert.equal(created.data.color, '#123abc');
  assert.equal((await agent('POST', '/api/labels', { name: 'ক্লাস ৫' })).status, 400);
  assert.equal((await agent('DELETE', `/api/labels/${created.data.id}`, {})).status, 403);

  const lead = defaults[0].id;
  let r = await owner('PUT', `/api/conversations/${convId}/labels`, { label_ids: [lead, created.data.id, 99999] });
  assert.deepEqual(r.data.label_ids.sort(), [lead, created.data.id].sort());
  assert.deepEqual((await owner('GET', `/api/conversations?label=${lead}&status=`)).data.map((c) => c.id), [convId]);
  assert.equal((await owner('GET', '/api/labels')).data.find((l) => l.id === lead).count, 1);

  assert.equal((await owner('POST', `/api/conversations/${convId}/notes`, { body: 'বাবা ফোন করবেন' })).status, 201);
  const notes = (await admin('GET', `/api/conversations/${convId}/notes`)).data;
  assert.equal(notes[0].body, 'বাবা ফোন করবেন');
  assert.equal(notes[0].user_name, 'Owner');
  assert.equal((await owner('GET', `/api/conversations/${convId}/messages`)).data.conversation.note_count, 1);
  assert.equal((await admin('DELETE', `/api/notes/${notes[0].id}`, {})).status, 200);

  assert.equal((await owner('PATCH', `/api/labels/${lead}`, { name: 'লিড', color: '#000000' })).status, 200);
  assert.equal((await owner('DELETE', `/api/labels/${created.data.id}`, {})).status, 200);
  r = await owner('GET', `/api/conversations/${convId}/messages`);
  assert.deepEqual(r.data.conversation.label_ids, [lead]);
});

test('several numbers, each with its own team', async () => {
  let r = await owner('POST', '/api/numbers', { label: 'হিফজ বিভাগ' });
  assert.equal(r.status, 201);
  const n2 = r.data.id;
  await owner('PUT', `/api/numbers/${n2}`, { wa_phone_number_id: '333444', wa_access_token: 'EAAGsecond5678', wa_app_secret: 'second-secret' });
  assert.equal((await owner('PUT', `/api/numbers/${n2}`, { wa_phone_number_id: '111222' })).status, 400);
  // Admin and agent were created before this number existed: they cannot see it.
  assert.deepEqual((await admin('GET', '/api/numbers')).data.map((n) => n.id), [numberId]);

  const before = pushesTo('owner').length;
  const payload = inbound('wamid.n2.1', 'হিফজে ভর্তি', '8801711111111');
  payload.entry[0].changes[0].value.metadata.phone_number_id = '333444';
  await signedWebhook(payload, 'second-secret');
  await wait(800);
  // Same customer, different number = separate chat.
  const all = (await owner('GET', '/api/conversations?status=')).data;
  const conv2 = all.find((c) => c.number_id === n2);
  assert.equal(conv2.number_label, 'হিফজ বিভাগ');
  assert.notEqual(conv2.id, convId);
  assert.equal(pushesTo('owner').length, before + 1);
  assert.ok(!(await admin('GET', '/api/conversations?status=')).data.some((c) => c.id === conv2.id));
  assert.equal((await admin('GET', `/api/conversations/${conv2.id}/messages`)).status, 403);
  assert.deepEqual((await owner('GET', `/api/conversations?number=${n2}&status=`)).data.map((c) => c.id), [conv2.id]);

  // Reply goes out from the second number.
  r = await owner('POST', `/api/conversations/${conv2.id}/messages`, { text: 'জি' });
  assert.equal(r.status, 201);
  assert.match(graphCalls.at(-1).url, /\/333444\/messages$/);

  // Cannot assign to someone without access to that number; after granting, admin sees it.
  assert.equal((await owner('PATCH', `/api/conversations/${conv2.id}`, { assigned_to: adminId })).status, 400);
  assert.equal((await owner('PATCH', `/api/users/${adminId}`, { number_ids: [numberId, n2] })).status, 200);
  assert.ok((await admin('GET', '/api/conversations?status=')).data.some((c) => c.id === conv2.id));
  assert.equal((await owner('PATCH', `/api/conversations/${conv2.id}`, { assigned_to: adminId })).status, 200);
  // Admin can only grant numbers they have: give the agent n2 too.
  assert.equal((await admin('PATCH', `/api/users/${agentId}`, { number_ids: [n2] })).status, 200);
  const team = (await owner('GET', '/api/users')).data;
  assert.deepEqual(team.find((u) => u.id === agentId).number_ids, [n2]);

  // Only the owner deletes a number; its chats go with it.
  assert.equal((await admin('DELETE', `/api/numbers/${n2}`, {})).status, 403);
  assert.equal((await owner('DELETE', `/api/numbers/${n2}`, {})).status, 200);
  assert.equal((await owner('GET', `/api/conversations/${conv2.id}/messages`)).status, 404);
  assert.equal((await owner('DELETE', `/api/numbers/${numberId}`, {})).status, 400);
  await owner('PATCH', `/api/users/${agentId}`, { number_ids: [numberId] });
});

test('deactivated user is logged out', async () => {
  assert.equal((await admin('PATCH', `/api/users/${agentId}`, { active: false })).status, 200);
  assert.equal((await agent('GET', '/api/me')).status, 401);
  assert.equal((await agent('POST', '/api/login', { email: 'agent@x.com', password: 'password1' })).status, 403);
});
