'use strict';

// HTTP API + static file skeleton for the Top 40 sim.
// Public endpoints never expose hidden mojo. Admin endpoints sit behind a
// signed HttpOnly SameSite session cookie.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./src/state');
const { catchUp, allTime, bandLeaderboard, genreTopTen, publicSnapshot, currentSnapshot, previewNext } = require('./src/chart');
const { currentChartHour, nextBoundary } = require('./src/dates');
const { GENRES } = require('./src/catalogue');
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

function publicState(state, now) {
  return {
    currentHour: currentChartHour(now),
    nextBoundary: nextBoundary(now).toISOString(),
    originHour: state.originHour,
    lastGeneratedHour: state.lastGeneratedHour,
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
  const genre = typeof body.genre === 'string' ? body.genre.trim() : '';
  if (!GENRES.includes(genre)) return { error: `genre must be one of: ${GENRES.join(', ')}` };
  return { title, artist, genre };
}

// ---- admin field validation (every field validated, nothing trusted) ----
const MOJO_FIELDS = ['potential', 'debut', 'climb', 'plateau', 'decline', 'variation'];

function validReason(body) {
  return typeof body.reason === 'string' && body.reason.trim().length >= 3 && body.reason.length <= 300;
}

function validateReleasePatch(body) {
  const patch = {};
  if (body.title !== undefined) {
    const t = typeof body.title === 'string' ? body.title.trim() : '';
    if (!t || t.length > TITLE_MAX) return { error: `title must be a string of 1-${TITLE_MAX} characters` };
    patch.title = t;
  }
  if (body.artist !== undefined) {
    const a = typeof body.artist === 'string' ? body.artist.trim() : '';
    if (!a || a.length > TITLE_MAX) return { error: `artist must be a string of 1-${TITLE_MAX} characters` };
    patch.artist = a;
  }
  if (body.mojo !== undefined) {
    if (typeof body.mojo !== 'object' || body.mojo === null || Array.isArray(body.mojo)) {
      return { error: 'mojo must be an object of numeric fields 0..1' };
    }
    patch.mojo = {};
    for (const [k, v] of Object.entries(body.mojo)) {
      if (!MOJO_FIELDS.includes(k)) return { error: `unknown mojo field: ${k}` };
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
        return { error: `mojo.${k} must be a number between 0 and 1` };
      }
      patch.mojo[k] = v;
    }
    if (!Object.keys(patch.mojo).length) delete patch.mojo;
  }
  if (!Object.keys(patch).length) return { error: 'nothing to update' };
  if (!validReason(body)) return { error: 'reason (3-300 chars) is required and is recorded in the correction log' };
  return { patch };
}

function logCorrection(state, admin, type, refId, reason, before, after) {
  state.counters.correction = (state.counters.correction || 0) + 1;
  state.corrections.push({
    id: state.counters.correction,
    at: new Date().toISOString(),
    admin, type, refId,
    reason: reason.trim(),
    before, after,
  });
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function createServer({ store, sessionSecret, autoCatchUp = true, clock = () => new Date(), tickMs = 1000 } = {}) {
  const adminCreds = auth.adminCredentials();
  const rateScope = crypto.randomUUID();
  const revoked = new Set(); // logout denylist, in-memory per process

  async function ensureFresh(state) {
    if (autoCatchUp) catchUp(state, clock());
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    try {
      // ---- public API ----
      if (req.method === 'GET' && p === '/health') {
        return json(res, 200, { ok: true, hour: currentChartHour(clock()) });
      }
      if (req.method === 'GET' && p === '/api/state') {
        return await store.update(async (state) => {
          await ensureFresh(state);
          return json(res, 200, publicState(state, clock()));
        });
      }
      if (req.method === 'GET' && p === '/api/chart/current') {
        return await store.update(async (state) => {
          await ensureFresh(state);
          return json(res, 200, { chart: currentSnapshot(state) });
        });
      }
      if (req.method === 'GET' && p === '/api/chart/genres') {
        return await store.update(async (state) => {
          await ensureFresh(state);
          return json(res, 200, { genres: genreTopTen(state) });
        });
      }
      if (req.method === 'GET' && p === '/api/chart/bands') {
        return await store.update(async (state) => {
          await ensureFresh(state);
          return json(res, 200, { bands: bandLeaderboard(state) });
        });
      }
      if (req.method === 'GET' && p === '/api/chart/history') {
        return await store.update(async (state) => {
          await ensureFresh(state);
          return json(res, 200, { snapshots: state.snapshots.map((snapshot) => publicSnapshot(state, snapshot)) });
        });
      }
      if (req.method === 'GET' && p === '/api/chart/all-time') {
        return await store.update(async (state) => {
          await ensureFresh(state);
          return json(res, 200, { allTime: allTime(state) });
        });
      }
      if (req.method === 'POST' && p === '/api/submit') {
        const ip = req.socket.remoteAddress || 'unknown';
        if (!rateLimit(`submit:${rateScope}:${ip}`, SUBMIT_MAX, SUBMIT_WINDOW_MS)) {
          return json(res, 429, { error: 'too many submissions, try again later' });
        }
        const body = await readJson(req);
        const v = validateSubmission(body);
        if (v.error) return json(res, 400, { error: v.error });
        const sub = await store.update(async (state) => {
          await ensureFresh(state);
          const now = clock();
          state.counters.submission += 1;
          const entry = { id: state.counters.submission, title: v.title, artist: v.artist, genre: v.genre, superBand: true, submittedAt: now.toISOString(), status: 'pending', releaseId: null };
          state.submissions.push(entry);
          // Always the next real hour, even when the generator is stale.
          entry.expectedChartHour = nextBoundary(now).toISOString();
          return entry;
        });
        return json(res, 201, { ok: true, submission: { id: sub.id, status: sub.status, genre: sub.genre, superBand: true, expectedChartHour: sub.expectedChartHour } });
      }
      if (req.method === 'GET' && p.startsWith('/api/release/') && p.endsWith('/history')) {
        const releaseId = decodeURIComponent(p.slice('/api/release/'.length, -'/history'.length));
        return await store.update(async (state) => {
          await ensureFresh(state);
          const history = [];
          for (const snap of state.snapshots) {
            const e = snap.entries.find(en => en.releaseId === releaseId);
            if (e) history.push({ hour: snap.hour, rank: e.rank, hourlySales: e.hourlySales, cumulativeSales: e.cumulativeSales ?? null, hoursOnChart: e.hoursOnChart, peak: e.peak });
          }
          const rel = state.releases.find(r => r.releaseId === releaseId);
          const meta = rel ? { title: rel.title, artist: rel.artist } :
            (history.length ? (() => { const s = state.snapshots.find(sn => sn.entries.some(en => en.releaseId === releaseId)); const e = s.entries.find(en => en.releaseId === releaseId); return { title: e.title, artist: e.artist }; })() : null);
          if (!meta) return json(res, 404, { error: 'release not found' });
          return json(res, 200, { releaseId, ...meta, history });
        });
      }

      // ---- admin API (session boundary) ----
      if (p === '/api/admin/login' && req.method === 'POST') {
        if (!adminCreds.password) return json(res, 503, { error: 'admin login not configured' });
        const ip = req.socket.remoteAddress || 'unknown';
        if (!rateLimit(`login:${rateScope}:${ip}`, 10, SUBMIT_WINDOW_MS)) {
          return json(res, 429, { error: 'too many login attempts, try again later' });
        }
        const body = await readJson(req);
        const ok = body.username === adminCreds.username && typeof body.password === 'string' &&
          body.password.length === adminCreds.password.length &&
          crypto.timingSafeEqual(Buffer.from(body.password), Buffer.from(adminCreds.password));
        if (!ok) return json(res, 401, { error: 'invalid credentials' });
        const token = auth.issue(sessionSecret, adminCreds.username);
        const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Set-Cookie': `${auth.COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12 * 3600}${secure}`,
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
          const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Set-Cookie': `${auth.COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
          });
          return res.end(JSON.stringify({ ok: true }));
        }
        if (req.method === 'POST' && p === '/api/admin/generate') {
          const results = await store.update(async (state) => catchUp(state, clock()));
          return json(res, 200, { ok: true, generated: results.filter(r => r.created).length });
        }
        if (req.method === 'POST' && p === '/api/admin/speedup') {
          return json(res, 409, { error: 'Speed-up disabled: charts follow real UTC hours only' });
        }
        if (req.method === 'GET' && p === '/api/admin/state') {
          return await store.update(async (state) => json(res, 200, { state }));
        }
        if (req.method === 'GET' && p === '/api/admin/releases') {
          return await store.update(async (state) => json(res, 200, {
            releases: state.releases.map(r => ({
              releaseId: r.releaseId, kind: r.kind, songId: r.songId, title: r.title, artist: r.artist,
              releasedHour: r.releasedHour, hoursOnChart: r.hoursOnChart, peak: r.peak,
              lifetimeSales: r.lifetimeSales, retired: r.retired, mojo: r.mojo,
            })),
          }));
        }
        if (req.method === 'GET' && p === '/api/admin/submissions') {
          return await store.update(async (state) => json(res, 200, { submissions: state.submissions }));
        }
        if (req.method === 'GET' && p === '/api/admin/corrections') {
          return await store.update(async (state) => json(res, 200, { corrections: state.corrections.slice().reverse() }));
        }
        if (req.method === 'POST' && p === '/api/admin/preview') {
          // Pure read: no catch-up, no persist. previewNext structured-clones
          // state, so nothing it computes can publish, consume submissions, or
          // add lifetime sales.
          return json(res, 200, previewNext(store.state, clock()));
        }
        const releaseMatch = p.match(/^\/api\/admin\/release\/([^/]+)(\/delete)?$/);
        if (releaseMatch && (req.method === 'PATCH' || req.method === 'POST')) {
          const releaseId = decodeURIComponent(releaseMatch[1]);
          const isDelete = Boolean(releaseMatch[2]);
          const body = await readJson(req);
          if (!validReason(body)) return json(res, 400, { error: 'reason (3-300 chars) is required and is recorded in the correction log' });
          return await store.update(async (state) => {
            const rel = state.releases.find(r => r.releaseId === releaseId);
            if (!rel) return json(res, 404, { error: 'release not found' });
            if (isDelete) {
              if (rel.songId) state.activeSongIds = state.activeSongIds.filter(id => id !== rel.songId);
              state.releases = state.releases.filter(r => r !== rel);
              logCorrection(state, adminUser, 'delete-release', releaseId, body.reason, { title: rel.title, artist: rel.artist }, null);
              return json(res, 200, { ok: true, replacementScheduled: true });
            }
            const v = validateReleasePatch(body);
            if (v.error) return json(res, 400, { error: v.error });
            const before = {};
            const after = {};
            if (v.patch.title !== undefined) { before.title = rel.title; after.title = v.patch.title; rel.title = v.patch.title; }
            if (v.patch.artist !== undefined) { before.artist = rel.artist; after.artist = v.patch.artist; rel.artist = v.patch.artist; }
            if (v.patch.mojo) {
              before.mojo = {};
              after.mojo = {};
              for (const [k, val] of Object.entries(v.patch.mojo)) { before.mojo[k] = rel.mojo[k]; after.mojo[k] = val; rel.mojo[k] = val; }
            }
            logCorrection(state, adminUser, 'edit-release', releaseId, body.reason, before, after);
            return json(res, 200, { ok: true, release: { releaseId: rel.releaseId, title: rel.title, artist: rel.artist } });
          });
        }
        const subMatch = p.match(/^\/api\/admin\/submission\/(\d+)$/);
        if (subMatch && req.method === 'DELETE') {
          const id = Number(subMatch[1]);
          const body = await readJson(req);
          if (!validReason(body)) return json(res, 400, { error: 'reason (3-300 chars) is required and is recorded in the correction log' });
          return await store.update(async (state) => {
            const sub = state.submissions.find(s => s.id === id);
            if (!sub) return json(res, 404, { error: 'submission not found' });
            if (sub.status !== 'pending') return json(res, 409, { error: 'only pending submissions can be deleted' });
            state.submissions = state.submissions.filter(s => s !== sub);
            logCorrection(state, adminUser, 'delete-submission', String(id), body.reason, { title: sub.title, artist: sub.artist }, null);
            return json(res, 200, { ok: true });
          });
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
  // ponytail: one process owns the JSON file; use a database lock if scaling writers.
  let timer = null;
  let ticking = false;
  async function tick() {
    if (ticking || !autoCatchUp) return;
    const now = clock();
    if (store.state.lastGeneratedHour && store.state.lastGeneratedHour >= currentChartHour(now)) return;
    ticking = true;
    try { await store.update(state => catchUp(state, now)); }
    catch (error) { console.error('Hourly chart tick failed:', error); }
    finally { ticking = false; }
  }
  server.on('listening', () => {
    if (!autoCatchUp) return;
    tick();
    timer = setInterval(tick, tickMs);
    timer.unref();
  });
  server.on('close', () => { clearInterval(timer); timer = null; });
  return server;
}

async function main() {
  const store = new Store();
  await store.init();
  await store.update((state) => catchUp(state)); // missed-hour catch-up on boot
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
