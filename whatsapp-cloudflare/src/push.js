// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291), using only WebCrypto.
// The VAPID key pair is generated once and kept in the `meta` table, so deploying needs no secrets.
import { canAccess } from './inbox.js';

const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// --- VAPID keys ---
let vapidPromise = null;
export function vapidKeys(db) {
  if (!vapidPromise) {
    vapidPromise = (async () => {
      let row = await db.first("SELECT value FROM meta WHERE key = 'vapid'");
      if (!row) {
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
        const publicKey = b64u(await crypto.subtle.exportKey('raw', pair.publicKey));
        await db.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('vapid', ?)", JSON.stringify({ jwk, publicKey }));
        row = await db.first("SELECT value FROM meta WHERE key = 'vapid'"); // another request may have won the race
      }
      const { jwk, publicKey } = JSON.parse(row.value);
      const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      return { privateKey, publicKey };
    })().catch((err) => { vapidPromise = null; throw err; });
  }
  return vapidPromise;
}

async function vapidAuthorization(endpoint, keys, subject) {
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

// --- RFC 8291 aes128gcm encryption of one record ---
export async function encryptPayload(p256dh, authSecret, plaintext) {
  const uaPublic = fromB64u(p256dh);
  const auth = fromB64u(authSecret);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const prkKey = await hmac(auth, shared);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = concat(enc.encode(plaintext), new Uint8Array([2])); // 0x02 = last record
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, record));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

async function sendOne(db, sub, payload, subject) {
  const keys = await vapidKeys(db);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(sub.endpoint, keys, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    },
    body: await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(payload)),
  });
  // Gone or unknown subscription (app uninstalled, permission revoked): forget it.
  if (res.status === 404 || res.status === 410) await db.run('DELETE FROM push_subscriptions WHERE id = ?', sub.id);
  else if (!res.ok) console.warn(`push ${res.status} for subscription ${sub.id}: ${await res.text().catch(() => '')}`);
}

const subjectFor = (origin) => (origin.startsWith('https:') ? origin : 'mailto:noreply@example.com');

// Send to every device of one user (used by the "test notification" button). Returns the device count.
export async function notifyUser(db, userId, payload, origin) {
  const subs = await db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', userId);
  await Promise.allSettled(subs.map((s) => sendOne(db, s, payload, subjectFor(origin))));
  return subs.length;
}

// Notify every team member who turned on notifications and may see this chat (owners/admins: all chats).
export async function notifyInbound(db, conv, text, origin) {
  const subs = await db.all(`
    SELECT s.*, u.role,
      (SELECT json_group_array(na.number_id) FROM number_access na WHERE na.user_id = u.id) AS number_ids
    FROM push_subscriptions s JOIN users u ON u.id = s.user_id
    WHERE s.workspace_id = ? AND u.active = 1`, conv.workspace_id);
  const targets = subs.filter((s) => canAccess({ id: s.user_id, role: s.role, numberIds: JSON.parse(s.number_ids || '[]') }, conv));
  if (!targets.length) return;
  const name = conv.contact_name || `+${conv.wa_id}`;
  const payload = {
    title: name,
    body: (text || 'নতুন মেসেজ').slice(0, 180),
    url: `/#/inbox/${conv.id}`,
    tag: `conv-${conv.id}`,
    unread: conv.unread,
    number: conv.number_label,
  };
  await Promise.allSettled(targets.map((s) => sendOne(db, s, payload, subjectFor(origin))));
}
