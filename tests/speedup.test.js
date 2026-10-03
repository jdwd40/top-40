'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.TOP40_ADMIN_USER = 'tester';
process.env.TOP40_ADMIN_PASSWORD = 'secret-pass';
const { Store } = require('../src/state');
const { createServer } = require('../server');
const { addHours } = require('../src/dates');
const { catchUp } = require('../src/chart');
const START = '2026-10-03T12:00:00.000Z';

async function boot(t, { automatic = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'top40-realtime-'));
  const store = new Store(path.join(dir, 'state.json'));
  await store.init();
  await store.update(state => { state.originHour = START; });
  let now = new Date('2026-10-03T12:37:42Z');
  const server = createServer({ store, sessionSecret: 'test-only', clock: () => now, autoCatchUp: automatic, tickMs: 10 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.queue; fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, { method = 'GET', cookie, body } = {}) {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, text: await response.text() };
  }
  async function login() {
    const r = await request('/api/admin/login', { method: 'POST', body: { username: 'tester', password: 'secret-pass' } });
    assert.equal(r.status, 200);
    return r.headers.get('set-cookie').split(';')[0];
  }
  return { store, request, login, setNow: value => { now = new Date(value); } };
}

test('speed up rejects unauthenticated requests', async t => {
  const { request } = await boot(t);
  assert.equal((await request('/api/admin/speedup', { method: 'POST', body: {} })).status, 401);
});

test('speed up returns 409 without changing state or disk, including after restart', async t => {
  const { store, request, login } = await boot(t);
  const cookie = await login();
  const before = fs.readFileSync(store.file, 'utf8');
  for (let i = 0; i < 3; i++) {
    const r = await request('/api/admin/speedup', { method: 'POST', cookie, body: {} });
    assert.equal(r.status, 409);
    assert.match(r.text, /real.*hour/i);
  }
  await store.queue;
  assert.equal(fs.readFileSync(store.file, 'utf8'), before);
  const restarted = new Store(store.file); await restarted.init();
  assert.deepEqual(restarted.state, store.state);
});

test('admin generate catches up elapsed hours only and same-hour retries are no-ops', async t => {
  const { store, request, login, setNow } = await boot(t);
  const cookie = await login();
  const generate = async () => JSON.parse((await request('/api/admin/generate', { method: 'POST', cookie, body: {} })).text);
  assert.equal((await generate()).generated, 1);
  assert.equal(store.state.snapshots[0].entries.length, 4);
  assert.equal((await generate()).generated, 0);
  setNow('2026-10-03T15:59:59Z');
  assert.equal((await generate()).generated, 3);
  assert.equal(store.state.lastGeneratedHour, addHours(START, 3));
  assert.equal((await generate()).generated, 0);
  await store.queue;
  const restart = new Store(store.file); await restart.init();
  assert.equal((await restart.update(s => catchUp(s, new Date(addHours(START, 4))))).length, 1);
});

test('submission debuts next real hour, never backdated during catch-up or released by speed-up', async t => {
  const { store, request, login, setNow } = await boot(t);
  const cookie = await login();
  const r = await request('/api/submit', { method: 'POST', body: { title: 'Northern Sky', artist: 'User Band', genre: 'Rock' } });
  assert.equal(r.status, 201);
  assert.equal(JSON.parse(r.text).submission.expectedChartHour, addHours(START, 1));
  await request('/api/admin/speedup', { method: 'POST', cookie, body: {} });
  assert.equal(store.state.submissions[0].status, 'pending');
  await request('/api/admin/generate', { method: 'POST', cookie, body: {} });
  assert.equal(store.state.submissions[0].status, 'pending');
  setNow(addHours(START, 2));
  await request('/api/admin/generate', { method: 'POST', cookie, body: {} });
  const user = store.state.releases.find(r => r.kind === 'user');
  assert.equal(user.releasedHour, addHours(START, 1));
  assert.equal(user.genre, 'Rock');
  assert.equal(user.superBand, true);
});

test('health reports the real UTC hour, not a simulated future date', async t => {
  const { request, setNow } = await boot(t);
  assert.equal(JSON.parse((await request('/health')).text).hour, START);
  setNow('2026-10-03T13:11:00Z');
  assert.equal(JSON.parse((await request('/health')).text).hour, addHours(START, 1));
});

test('periodic server tick advances without traffic and remains exactly once under concurrent reads', async t => {
  const { store, request, setNow } = await boot(t, { automatic: true });
  async function waitForHour(hour) {
    const deadline = Date.now() + 2000;
    while (store.state.lastGeneratedHour !== hour && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    await store.queue;
    assert.equal(store.state.lastGeneratedHour, hour);
  }
  await waitForHour(START);
  setNow(addHours(START, 1));
  await waitForHour(addHours(START, 1)); // no HTTP request advanced this
  const before = structuredClone(store.state);
  await Promise.all(Array.from({ length: 8 }, () => request('/api/chart/current')));
  await store.queue;
  assert.deepEqual(store.state, before);
  assert.equal(store.state.snapshots.length, 2);
  setNow(addHours(START, 4));
  await waitForHour(addHours(START, 4));
  assert.equal(store.state.snapshots.length, 5);
});

test('branding and controls describe hourly real-time behavior', async t => {
  const { request } = await boot(t);
  for (const route of ['/', '/admin.html']) {
    const r = await request(route);
    assert.equal(r.status, 200);
    assert.match(r.text, /Tripper City Top 40/);
    assert.doesNotMatch(r.text, /8pm|daily|next chart day|Generate next chart now/);
  }
  const admin = (await request('/admin.html')).text;
  assert.match(admin, /id="run-speedup"[^>]*disabled/);
  assert.match(admin, /elapsed hours/);
});
