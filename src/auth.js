'use strict';

// Signed self-contained session cookies (HMAC-SHA256). HttpOnly + SameSite=Lax
// are set by the server when the cookie is issued. Secret comes from
// TOP40_SESSION_SECRET; a random per-boot secret is used when unset, which
// simply invalidates admin sessions on restart.

const crypto = require('crypto');

const COOKIE_NAME = 'top40_session';

function secret() {
  return process.env.TOP40_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
}

function sign(s, payload) {
  return crypto.createHmac('sha256', s).update(payload).digest('base64url');
}

function issue(s, username, maxAgeSec = 12 * 3600) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + maxAgeSec * 1000 })).toString('base64url');
  return `${payload}.${sign(s, payload)}`;
}

function verify(s, token) {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expect = sign(s, payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || !data.exp || Date.now() > data.exp || typeof data.u !== 'string') return null;
  return data.u;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function adminCredentials() {
  return {
    username: process.env.TOP40_ADMIN_USER || 'admin',
    password: process.env.TOP40_ADMIN_PASSWORD || '', // unset = admin login disabled
  };
}

module.exports = { COOKIE_NAME, secret, issue, verify, parseCookies, adminCredentials };
