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
const { addHours, currentChartHour } = require('../src/dates');

const sessionSecret = 'test-session-secret';
const TEST_NOW = new Date('2026-10-03T12:37:42Z');

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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'top40-api-')), 'state.json');
  const store = new Store(file);
  await store.init();
  let now = new Date(TEST_NOW);
  await store.update(s => { s.originHour = currentChartHour(now); });
  const server = createServer({ store, sessionSecret, clock: () => now });
  await new Promise((r) => server.listen(0, r));
  return { store, server, file, advanceHour: () => { now = new Date(addHours(currentChartHour(now), 1)); } };
}

test('health, static index, and public chart with no mojo leak', async (t) => {
  const { server } = await boot();
  t.after(() => server.close());

  const health = await request(server, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.text).ok, true);

  const index = await request(server, 'GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /text\/html/);

  const current = await request(server, 'GET', '/api/chart/current');
  assert.equal(current.status, 200);
  const { chart } = JSON.parse(current.text);
  assert.ok(chart && chart.entries.length > 0, 'chart generated on demand');

  for (const p of ['/api/state', '/api/chart/history', '/api/chart/all-time', '/api/chart/current']) {
    const res = await request(server, 'GET', p);
    assert.equal(res.status, 200);
    assert.ok(!res.text.includes('mojo'), `${p} leaks no mojo`);
  }
});

test('README documents admin access without credentials', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /\/top40\/admin\.html/);
  assert.match(readme, /TOP40_ADMIN_USER/);
  assert.match(readme, /TOP40_ADMIN_PASSWORD/);
});

test('submissions require a canonical genre and become super bands', async (t) => {
  const { server, store, advanceHour } = await boot();
  t.after(() => server.close());
  const bad = await request(server, 'POST', '/api/submit', { body: { title: 'A', artist: 'B', genre: 'Opera' } });
  assert.equal(bad.status, 400);
  assert.equal(store.state.submissions.length, 0);
  const good = await request(server, 'POST', '/api/submit', { body: { title: 'A', artist: 'B', genre: 'Rock' } });
  assert.equal(good.status, 201);
  assert.equal(store.state.submissions[0].status, 'pending');
  advanceHour();
  await request(server, 'GET', '/api/chart/current');
  const release = store.state.releases.find((row) => row.kind === 'user');
  assert.equal(release.genre, 'Rock');
  assert.equal(release.superBand, true);
});

test('submission validation and in-memory rate limit', async (t) => {
  const { server } = await boot();
  t.after(() => server.close());

  for (const bad of [{}, { title: '', artist: 'X' }, { title: 'x'.repeat(81), artist: 'X' }, { title: 123, artist: 'X' }]) {
    const res = await request(server, 'POST', '/api/submit', { body: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }

  let last;
  for (let i = 0; i < 6; i++) { // 4 validation failures above + these 6 = 10 allowed
    last = await request(server, 'POST', '/api/submit', { body: { title: `Song ${i}`, artist: 'A', genre: 'Rock' } });
    assert.equal(last.status, 201, `submission ${i + 1} accepted`);
  }
  const blocked = await request(server, 'POST', '/api/submit', { body: { title: 'One more', artist: 'A', genre: 'Rock' } });
  assert.equal(blocked.status, 429, '11th submission within the window is rate limited');
});

test('admin session boundary behind signed HttpOnly SameSite cookie', async (t) => {
  const { server } = await boot();
  t.after(() => server.close());

  const noCookie = await request(server, 'GET', '/api/admin/state');
  assert.equal(noCookie.status, 401);

  const wrong = await request(server, 'POST', '/api/admin/login', { body: { username: 'tester', password: 'nope' } });
  assert.equal(wrong.status, 401);

  const ok = await request(server, 'POST', '/api/admin/login', { body: { username: 'tester', password: 'secret-pass' } });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers['set-cookie'][0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = setCookie.split(';')[0];

  const generate = await request(server, 'POST', '/api/admin/generate', { cookie, body: {} });
  assert.equal(generate.status, 200);
  assert.equal(JSON.parse(generate.text).generated, 0, 'startup tick already caught up; admin cannot advance into the future');

  const adminState = await request(server, 'GET', '/api/admin/state', { cookie });
  assert.equal(adminState.status, 200);
  assert.ok(adminState.text.includes('"mojo"'), 'admin sees hidden mojo');

  const logout = await request(server, 'POST', '/api/admin/logout', { cookie, body: {} });
  assert.equal(logout.status, 200);
  const afterLogout = await request(server, 'GET', '/api/admin/state', { cookie });
  assert.equal(afterLogout.status, 401, 'logged-out session rejected');
});

test('public band and genre leaderboards expose sorted safe payloads', async (t) => {
  const { server } = await boot();
  t.after(() => server.close());

  const bands = await request(server, 'GET', '/api/chart/bands');
  assert.equal(bands.status, 200);
  const bandData = JSON.parse(bands.text);
  assert.ok(bandData.bands.length > 0);
  assert.ok(bandData.bands.every((row, index, rows) => index === 0 || rows[index - 1].earnings >= row.earnings));
  assert.ok(!bands.text.includes('mojo'));

  const genres = await request(server, 'GET', '/api/chart/genres');
  assert.equal(genres.status, 200);
  const genreData = JSON.parse(genres.text);
  assert.equal(Object.keys(genreData.genres).length, 10);
  assert.ok(Object.values(genreData.genres).every((rows) => rows.length <= 10));
  assert.ok(!genres.text.includes('mojo'));
});
