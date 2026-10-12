// WebCrypto helpers: password hashing (PBKDF2), secret encryption at rest (AES-GCM), Meta webhook signatures (HMAC).
const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (s) => Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));

export function randomToken(bytes = 32) {
  return toB64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(value) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(value)));
}

function equalBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(a, b) : a.every((v, i) => v === b[i]);
}

// --- Passwords: PBKDF2-SHA256 (100k iterations is the Workers maximum) ---
const ITERATIONS = 100000;

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2:${ITERATIONS}:${toHex(salt)}:${toHex(await pbkdf2(password, salt, ITERATIONS))}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iter, saltHex, hashHex] = String(stored).split(':');
  if (scheme !== 'pbkdf2' || !hashHex) return false;
  return equalBytes(await pbkdf2(password, fromHex(saltHex), Number(iter)), fromHex(hashHex));
}

// --- Encryption of WhatsApp tokens/secrets. The key is generated once and kept in the `meta` table. ---
let keyPromise = null;
function encryptionKey(db) {
  if (!keyPromise) {
    keyPromise = (async () => {
      await db.run('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)', 'enc_key', toB64(crypto.getRandomValues(new Uint8Array(32))));
      const row = await db.first('SELECT value FROM meta WHERE key = ?', 'enc_key');
      return crypto.subtle.importKey('raw', fromB64(row.value), 'AES-GCM', false, ['encrypt', 'decrypt']);
    })().catch((err) => { keyPromise = null; throw err; });
  }
  return keyPromise;
}

export async function encrypt(db, plain) {
  if (!plain) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(db), enc.encode(plain));
  return `v1:${toB64(iv)}:${toB64(data)}`;
}

export async function decrypt(db, stored) {
  if (!stored) return null;
  const [v, iv, data] = stored.split(':');
  if (v !== 'v1') return null;
  try {
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, await encryptionKey(db), fromB64(data)));
  } catch {
    return null;
  }
}

// --- Meta X-Hub-Signature-256 ---
export async function verifyMetaSignature(rawBody, header, appSecret) {
  if (!header || !header.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(rawBody)));
  return equalBytes(expected, fromHex(header.slice(7).toLowerCase()));
}
