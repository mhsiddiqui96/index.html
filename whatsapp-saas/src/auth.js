'use strict';
const { get, run } = require('./db');
const { sha256, randomToken } = require('./security');

const SESSION_DAYS = 14;
const COOKIE = 'sid';

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(res, userId) {
  const token = randomToken();
  const expires = Date.now() + SESSION_DAYS * 864e5;
  run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, expires);
  run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", userId);
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const user = get(`
      SELECT u.id, u.workspace_id, u.name, u.email, u.role, u.active, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`, sha256(token));
    if (user && user.active && user.expires_at > Date.now()) {
      delete user.expires_at;
      req.user = user;
      return next();
    }
  }
  res.status(401).json({ error: 'লগইন করুন' });
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'এই কাজের অনুমতি আপনার নেই' });

// Tiny in-memory limiter for login/signup brute force protection.
const attempts = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = `${req.path}:${req.ip}`;
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry || entry.reset < now) {
      attempts.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    if (++entry.count > max) {
      return res.status(429).json({ error: 'অনেকবার চেষ্টা করা হয়েছে, কিছুক্ষণ পর আবার চেষ্টা করুন' });
    }
    next();
  };
}

setInterval(() => run('DELETE FROM sessions WHERE expires_at < ?', Date.now()), 36e5).unref();

module.exports = { createSession, destroySession, requireAuth, requireRole, rateLimit };
