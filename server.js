'use strict';

// HTTP API + static file skeleton for the Top 40 sim.
// Public endpoints never expose hidden mojo. Admin endpoints sit behind a
// signed HttpOnly SameSite session cookie.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./src/state');
const { catchUp, allTime } = require('./src/chart');
const { currentChartDay, nextBoundary } = require('./src/dates');
const auth = require('./src/auth');

const PUBLIC_DIR = path.join(__dirname, 'public');
const BODY_LIMIT = 64 * 1024;
const SUBMIT_MAX = 10;          // submissions per IP per window
const SUBMIT_WINDOW_MS = 3600 * 1000;
const TITLE_MAX = 80;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let data = '';
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 });
  }
}

// ponytail: single global in-memory limiter map; prune lazily. Fine for one
// process — move to a shared store if we ever run multiple processes.
const rateHits = new Map();
function rateLimit(key, max, windowMs) {
  if (rateHits.size > 10000) rateHits.clear();
  const now = Date.now();
  const hit = rateHits.get(key);
  if (!hit || now > hit.reset) {
    rateHits.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  hit.n += 1;
  return hit.n <= max;
}

function publicState(state) {
  return {
    currentDay: currentChartDay(),
    nextBoundary: nextBoundary().toISOString(),
    originDay: state.originDay,
    lastGeneratedDay: state.lastGeneratedDay,
    releaseCount: state.releases.length,
    activeCatalogueSongs: state.activeSongIds.length,
    submissionCount: state.submissions.length,
  };
}

function validateSubmission(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const artist = typeof body.artist === 'string' ? body.artist.trim() : '';
  if (!title || title.length > TITLE_MAX) return { error: `title must be a string of 1-${TITLE_MAX} characters` };
  if (!artist || artist.length > TITLE_MAX) return { error: `artist must be a string of 1-${TITLE_MAX} characters` };
  return { title, artist };
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function createServer({ store, sessionSecret, autoCatchUp = true } = {}) {
  const adminCreds = auth.adminCredentials();
  const revoked = new Set(); // logout denylist, in-memory per process

  async function ensureFresh(state) {
    if (autoCatchUp) catchUp(state);
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    try {
      // ---- public API ----
      if (req.method === 'GET' && p === '/health') {
        return json(res, 200, { ok: true, day: currentChartDay() });
      }
      if (req.method === 'GET' && p === '/api/state') {
        return await store.update(async (state) => {
          await ensureFresh(state);
          return json(res, 200, publicState(state));
        });
      }
      if (req.method === 'GET' && p === '/api/chart/current') {
        return await store.update(async (state) => {
          await ensureFresh(state);
          const snap = state.snapshots[state.snapshots.length - 1] || null;
          return json(res, 200, { chart: snap });
        });
      }
      if (req.method === 'GET' && p === '/api/chart/history') {
        return await store.update(async (state) => json(res, 200, { snapshots: state.snapshots }));
      }
      if (req.method === 'GET' && p === '/api/chart/all-time') {
        return await store.update(async (state) => json(res, 200, { allTime: allTime(state) }));
      }
      if (req.method === 'POST' && p === '/api/submit') {
        const ip = req.socket.remoteAddress || 'unknown';
        if (!rateLimit(`submit:${ip}`, SUBMIT_MAX, SUBMIT_WINDOW_MS)) {
          return json(res, 429, { error: 'too many submissions, try again later' });
        }
        const body = await readJson(req);
        const v = validateSubmission(body);
        if (v.error) return json(res, 400, { error: v.error });
        const sub = await store.update((state) => {
          state.counters.submission += 1;
          const entry = { id: state.counters.submission, title: v.title, artist: v.artist, submittedAt: new Date().toISOString(), status: 'pending', releaseId: null };
          state.submissions.push(entry);
          return entry;
        });
        return json(res, 201, { ok: true, submission: { id: sub.id, status: sub.status } });
      }

      // ---- admin API (session boundary) ----
      if (p === '/api/admin/login' && req.method === 'POST') {
        if (!adminCreds.password) return json(res, 503, { error: 'admin login not configured' });
        const body = await readJson(req);
        const ok = body.username === adminCreds.username && typeof body.password === 'string' &&
          body.password.length === adminCreds.password.length &&
          crypto.timingSafeEqual(Buffer.from(body.password), Buffer.from(adminCreds.password));
        if (!ok) return json(res, 401, { error: 'invalid credentials' });
        const token = auth.issue(sessionSecret, adminCreds.username);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `${auth.COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12 * 3600}`,
        });
        return res.end(JSON.stringify({ ok: true }));
      }

      const cookies = auth.parseCookies(req.headers.cookie);
      const rawToken = cookies[auth.COOKIE_NAME];
      const adminUser = revoked.has(rawToken) ? null : auth.verify(sessionSecret, rawToken);

      if (p.startsWith('/api/admin/')) {
        if (!adminUser) return json(res, 401, { error: 'admin session required' });
        if (req.method === 'POST' && p === '/api/admin/logout') {
          if (rawToken) revoked.add(rawToken);
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': `${auth.COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
          });
          return res.end(JSON.stringify({ ok: true }));
        }
        if (req.method === 'POST' && p === '/api/admin/generate') {
          const results = await store.update(async (state) => catchUp(state));
          return json(res, 200, { ok: true, generated: results.filter(r => r.created).length });
        }
        if (req.method === 'GET' && p === '/api/admin/state') {
          return await store.update(async (state) => json(res, 200, { state }));
        }
        return json(res, 404, { error: 'not found' });
      }

      // ---- static files ----
      if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(req, res, p);
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      return json(res, err.status || 500, { error: err.message || 'internal error' });
    }
  });
  return server;
}

async function main() {
  const store = new Store();
  await store.init();
  await store.update((state) => catchUp(state)); // missed-day catch-up on boot
  const port = Number(process.env.TOP40_PORT || 3000);
  const sessionSecret = auth.secret();
  const server = createServer({ store, sessionSecret });
  server.listen(port, () => {
    console.log(`Top 40 sim listening on http://localhost:${port} (data: ${store.file})`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createServer };
