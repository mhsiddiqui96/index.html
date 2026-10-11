'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./db');

// --- Encryption key for secrets at rest (WhatsApp access tokens) ---
function loadKey() {
  if (process.env.SECRET_KEY) {
    return crypto.createHash('sha256').update(process.env.SECRET_KEY).digest();
  }
  const keyFile = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(keyFile)) {
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    console.warn(`[security] SECRET_KEY not set; generated ${keyFile}. Back it up or set SECRET_KEY.`);
  }
  return crypto.createHash('sha256').update(fs.readFileSync(keyFile, 'utf8').trim()).digest();
}
const KEY = loadKey();

function encrypt(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

function decrypt(stored) {
  if (!stored) return null;
  const [version, iv, tag, data] = stored.split(':');
  if (version !== 'v1') return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// --- Password hashing (scrypt) ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

// --- Meta webhook signature (X-Hub-Signature-256) ---
function verifyMetaSignature(rawBody, header, appSecret) {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const given = header.slice(7);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

module.exports = { encrypt, decrypt, hashPassword, verifyPassword, sha256, randomToken, verifyMetaSignature };
