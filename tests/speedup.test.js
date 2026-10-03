'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

process.env.TOP40_ADMIN_USER = 'tester';
process.env.TOP40_ADMIN_PASSWORD = 'secret-pass';

const { Store } = require('../src/state');
const { createServer } = require('../server');
const { currentChartDay, addDays, chartDayStart } = require('../src/dates');
const { catchUp } = require('../src/chart');

const sessionSecret = 'test-session-secret';

function request(server, method, p, { body, cookie } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ port, path: p, method, headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function boot() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'top40-speedup-')), 'state.json');
  const store = new Store(file);
  await store.init();
  const server = createServer({ store, sessionSecret, autoCatchUp: false });
  await new Promise((r) => server.listen(0, r));
  return { store, server, file };
}

async function login(server) {
  const ok = await request(server, 'POST', '/api/admin/login', { body: { username: 'tester', password: 'secret-pass' } });
  assert.equal(ok.status, 200);
  return ok.headers['set-cookie'][0].split(';')[0];
}

test('speed up rejects unauthenticated requests', async (t) => {
  const { server } = await boot();
  t.after(() => server.close());
  const res = await request(server, 'POST', '/api/admin/speedup', { body: {} });
  assert.equal(res.status, 401);
  assert.match(res.text, /admin session required/);
});

test('speed up advances exactly one chart week per call and persists across restart', async (t) => {
  const { server, store, file } = await boot();
  t.after(() => server.close());
  const cookie = await login(server);
  const originDay = store.state.originDay;

  const r1 = await request(server, 'POST', '/api/admin/speedup', { cookie, body: {} });
  assert.equal(r1.status, 200);
  const d1 = JSON.parse(r1.text);
  assert.equal(d1.ok, true);
  assert.equal(d1.created, true);
  assert.equal(d1.day, originDay, 'first speed-up publishes the launch chart');
  assert.equal(d1.entries, 40);
  assert.equal(d1.added, 40, 'launch seeds 40 rivals');
  assert.equal(d1.released, 0);
  assert.equal(d1.departed, 0);
  assert.equal(store.state.lastScheduledDay, currentChartDay(), 'speed-up establishes the real-day cursor');

  const r2 = await request(server, 'POST', '/api/admin/speedup', { cookie, body: {} });
  assert.equal(r2.status, 200);
  const d2 = JSON.parse(r2.text);
  assert.equal(d2.day, addDays(originDay, 1), 'second call advances exactly one day');
  assert.equal(d2.entries, 40);
  assert.equal(d2.added, 1, 'exactly one new rival release');
  assert.ok(Number.isInteger(d2.departed) && d2.departed >= 0 && d2.departed <= 1);

  // summary departed count matches the actual snapshot diff
  const snaps = store.state.snapshots;
  const prevIds = new Set(snaps[snaps.length - 2].entries.map(e => e.releaseId));
  const nowIds = new Set(snaps[snaps.length - 1].entries.map(e => e.releaseId));
  assert.equal(d2.departed, [...prevIds].filter(id => !nowIds.has(id)).length, 'departed count matches snapshots');

  const r3 = await request(server, 'POST', '/api/admin/speedup', { cookie, body: {} });
  const d3 = JSON.parse(r3.text);
  assert.equal(d3.day, addDays(originDay, 2), 'third call advances one more day');
  assert.equal(store.state.snapshots.length, 3);

  const store2 = new Store(file);
  await store2.init();
  assert.equal(store2.state.snapshots.length, 3, 'snapshots retained on restart');
  assert.equal(store2.state.lastGeneratedDay, addDays(originDay, 2), 'generator cursor retained');
  assert.equal(store2.state.lastScheduledDay, currentChartDay(), 'speed-up leaves the scheduling cursor unchanged');
  const tomorrow = chartDayStart(addDays(currentChartDay(), 1));
  const daily = await store2.update(state => catchUp(state, tomorrow));
  assert.equal(daily.filter(result => result.created).length, 1, 'daily advancement works after speed-up and restart');
  assert.equal(store2.state.lastGeneratedDay, addDays(originDay, 3));
});

test('speed up generates exactly one day even when the generator is behind', async (t) => {
  const { server, store } = await boot();
  t.after(() => server.close());
  const cookie = await login(server);
  await store.update((s) => {
    s.originDay = addDays(currentChartDay(), -5);
    s.lastGeneratedDay = null;
    s.snapshots = [];
    s.releases = [];
    s.activeSongIds = [];
    s.counters.release = 0;
  });
  const res = await request(server, 'POST', '/api/admin/speedup', { cookie, body: {} });
  assert.equal(res.status, 200);
  const d = JSON.parse(res.text);
  assert.equal(d.created, true);
  assert.equal(d.day, addDays(currentChartDay(), -5));
  assert.equal(store.state.snapshots.length, 1, 'no catch-up cascade: exactly one day published');
});

test('speed up releases pending user submissions on the new chart day', async (t) => {
  const { server, store } = await boot();
  t.after(() => server.close());
  const cookie = await login(server);

  const sub = await request(server, 'POST', '/api/submit', { body: { title: 'Speed Tune', artist: 'Fast Act', genre: 'Rock' } });
  assert.equal(sub.status, 201);

  const res = await request(server, 'POST', '/api/admin/speedup', { cookie, body: {} });
  assert.equal(res.status, 200);
  const d = JSON.parse(res.text);
  assert.equal(d.released, 1, 'one pending submission released');
  assert.equal(d.entries, 40, 'chart ranks the top 40 of launch rivals + user debut');
  const released = store.state.submissions.find(s => s.title === 'Speed Tune');
  assert.equal(released.status, 'released');
  assert.ok(released.releaseId, 'submission linked to its release');
});

test('speed up does not move the Europe/London wall clock', async (t) => {
  const { server } = await boot();
  t.after(() => server.close());
  const cookie = await login(server);
  const before = currentChartDay();
  await request(server, 'POST', '/api/admin/speedup', { cookie, body: {} });
  const health = await request(server, 'GET', '/health');
  assert.equal(JSON.parse(health.text).day, before, 'server clock view unchanged');
  assert.equal(currentChartDay(), before);
});

test('branding: public and admin pages say Tripper City Top 40', async (t) => {
  const { server } = await boot();
  t.after(() => server.close());
  for (const p of ['/', '/admin.html']) {
    const res = await request(server, 'GET', p);
    assert.equal(res.status, 200);
    assert.match(res.text, /Tripper City Top 40/, `${p} carries the new brand`);
  }
});
