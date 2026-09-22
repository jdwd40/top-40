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
const { addDays } = require('../src/dates');

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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'top40-admin-')), 'state.json');
  const store = new Store(file);
  await store.init();
  const server = createServer({ store, sessionSecret });
  await new Promise((r) => server.listen(0, r));
  return { store, server, file };
}

async function login(server) {
  const ok = await request(server, 'POST', '/api/admin/login', { body: { username: 'tester', password: 'secret-pass' } });
  assert.equal(ok.status, 200);
  return ok.headers['set-cookie'][0].split(';')[0];
}

test('public chart payload shape and submission confirmation data', async (t) => {
  const { server } = await boot();
  t.after(() => server.close());

  const { status, text } = await request(server, 'GET', '/api/chart/current');
  assert.equal(status, 200);
  assert.ok(!text.includes('mojo'), 'no mojo leak');
  const { chart } = JSON.parse(text);
  assert.ok(chart.entries.length > 0 && chart.entries.length <= 40);
  for (const e of chart.entries) {
    for (const k of ['rank', 'releaseId', 'title', 'artist', 'weeklySales', 'cumulativeSales', 'weeksOnChart', 'peak', 'lastWeekRank']) {
      assert.ok(k in e, `entry has ${k}`);
    }
    assert.equal(typeof e.weeklySales, 'number');
    assert.equal(typeof e.cumulativeSales, 'number');
  }

  const sub = await request(server, 'POST', '/api/submit', { body: { title: 'Test Song', artist: 'Test Artist' } });
  assert.equal(sub.status, 201);
  const subData = JSON.parse(sub.text);
  assert.equal(subData.submission.status, 'pending');
  assert.match(subData.submission.expectedChartDay, /^\d{4}-\d{2}-\d{2}$/, 'confirmation includes expected chart date');

  const hist = await request(server, 'GET', `/api/release/${encodeURIComponent(chart.entries[0].releaseId)}/history`);
  assert.equal(hist.status, 200);
  const h = JSON.parse(hist.text);
  assert.equal(h.releaseId, chart.entries[0].releaseId);
  assert.ok(h.history.length >= 1);
  assert.ok('rank' in h.history[0] && 'weeklySales' in h.history[0]);

  const missing = await request(server, 'GET', '/api/release/NOPE/history');
  assert.equal(missing.status, 404);
});

test('browser-facing route assets', async (t) => {
  const { server } = await boot();
  t.after(() => server.close());
  for (const [p, type] of [['/', 'text/html'], ['/admin.html', 'text/html'], ['/app.js', 'javascript'], ['/admin.js', 'javascript'], ['/style.css', 'text/css']]) {
    const res = await request(server, 'GET', p);
    assert.equal(res.status, 200, `${p} serves`);
    assert.match(res.headers['content-type'], new RegExp(type), `${p} content type`);
  }
});

test('admin access boundary: every admin endpoint requires a session', async (t) => {
  const { server } = await boot();
  t.after(() => server.close());
  for (const [m, p] of [
    ['GET', '/api/admin/releases'], ['GET', '/api/admin/submissions'], ['GET', '/api/admin/corrections'],
    ['POST', '/api/admin/preview'], ['PATCH', '/api/admin/release/REL-0001'], ['POST', '/api/admin/release/REL-0001/delete'],
    ['DELETE', '/api/admin/submission/1'],
  ]) {
    const res = await request(server, m, p, { body: {} });
    assert.equal(res.status, 401, `${m} ${p} without session`);
  }
});

test('admin CRUD: edit release logs correction; snapshots stay immutable', async (t) => {
  const { server, store } = await boot();
  t.after(() => server.close());
  const cookie = await login(server);

  const before = await request(server, 'GET', '/api/chart/current');
  const chart = JSON.parse(before.text).chart;
  const target = chart.entries[0];

  const noReason = await request(server, 'PATCH', `/api/admin/release/${target.releaseId}`, { cookie, body: { title: 'X' } });
  assert.equal(noReason.status, 400, 'reason is required');

  const badMojo = await request(server, 'PATCH', `/api/admin/release/${target.releaseId}`, { cookie, body: { mojo: { potential: 7 }, reason: 'test' } });
  assert.equal(badMojo.status, 400, 'mojo validated 0..1');

  const origTitle = target.title;
  const releasesBefore = JSON.parse((await request(server, 'GET', '/api/admin/releases', { cookie })).text).releases;
  const origPotential = releasesBefore.find(r => r.releaseId === target.releaseId).mojo.potential;

  const ok = await request(server, 'PATCH', `/api/admin/release/${target.releaseId}`, { cookie, body: { title: 'Renamed Track', mojo: { potential: 0.99 }, reason: 'fix typo + boost' } });
  assert.equal(ok.status, 200);

  const releases = await request(server, 'GET', '/api/admin/releases', { cookie });
  const rel = JSON.parse(releases.text).releases.find(r => r.releaseId === target.releaseId);
  assert.equal(rel.title, 'Renamed Track');
  assert.equal(rel.mojo.potential, 0.99);
  assert.ok(Array.isArray(rel.mojo.noise), 'full mojo block intact');

  const corrections = await request(server, 'GET', '/api/admin/corrections', { cookie });
  const log = JSON.parse(corrections.text).corrections;
  assert.equal(log.length, 1);
  assert.equal(log[0].type, 'edit-release');
  assert.equal(log[0].admin, 'tester');
  assert.equal(log[0].reason, 'fix typo + boost');
  assert.deepEqual(log[0].before, { title: origTitle, mojo: { potential: origPotential } });
  assert.deepEqual(log[0].after, { title: 'Renamed Track', mojo: { potential: 0.99 } });
});

test('preview is pure: no publish, no lifetime sales, cannot mutate', async (t) => {
  const { server, store } = await boot();
  t.after(() => server.close());
  const cookie = await login(server);

  // warm up: trigger the automatic catch-up so today's chart exists
  await request(server, 'GET', '/api/chart/current');
  const snapCount = store.state.snapshots.length;
  const lifetime = store.state.releases.reduce((n, r) => n + r.lifetimeSales, 0);
  const subCount = store.state.submissions.length;

  const p1 = await request(server, 'POST', '/api/admin/preview', { cookie, body: {} });
  assert.equal(p1.status, 200);
  const d1 = JSON.parse(p1.text);
  assert.equal(d1.preview, true);
  assert.match(d1.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(d1.snapshot.entries.length > 0, 'preview has a full chart');

  assert.equal(store.state.snapshots.length, snapCount, 'no snapshot persisted');
  assert.equal(store.state.releases.reduce((n, r) => n + r.lifetimeSales, 0), lifetime, 'no lifetime sales added');
  assert.equal(store.state.submissions.length, subCount, 'submissions not consumed');

  const again = await request(server, 'POST', '/api/admin/preview', { cookie, body: {} });
  const d2 = JSON.parse(again.text);
  assert.equal(d2.day, d1.day);
  assert.deepEqual(d2.snapshot.entries, d1.snapshot.entries, 'preview chart content is deterministic');
});

test('preview on a stale generator publishes nothing (regression)', async (t) => {
  const { server, store, file } = await boot();
  t.after(() => server.close());
  const cookie = await login(server);

  // Stale generator: origin two days behind, nothing generated, one pending sub.
  await store.update((s) => {
    s.originDay = addDays(s.originDay, -2);
    s.submissions.push({ id: 1, title: 'Stale Song', artist: 'B', submittedAt: '', status: 'pending', releaseId: null, expectedChartDay: s.originDay });
  });
  const diskBefore = fs.readFileSync(file, 'utf8');
  const snapsBefore = store.state.snapshots.length;
  const lifeBefore = store.state.releases.reduce((n, r) => n + r.lifetimeSales, 0);

  const res = await request(server, 'POST', '/api/admin/preview', { cookie, body: {} });
  assert.equal(res.status, 200);
  const d = JSON.parse(res.text);
  assert.equal(d.preview, true);
  assert.equal(d.day, store.state.originDay, 'preview day is after the stale cursor, not today');

  assert.equal(store.state.snapshots.length, snapsBefore, 'no snapshots published');
  assert.equal(store.state.releases.length, 0, 'no releases created');
  const sub = store.state.submissions[0];
  assert.equal(sub.status, 'pending', 'submission not consumed');
  assert.equal(sub.releaseId, null);
  assert.equal(store.state.releases.reduce((n, r) => n + r.lifetimeSales, 0), lifeBefore, 'no lifetime sales added');
  assert.equal(store.state.lastGeneratedDay, null, 'generator cursor unmoved');
  assert.equal(fs.readFileSync(file, 'utf8'), diskBefore, 'state file on disk untouched');
});

test('generate after edits only affects future charts; published snapshot untouched', async (t) => {
  const { server, store } = await boot();
  t.after(() => server.close());
  const cookie = await login(server);

  const current = JSON.parse((await request(server, 'GET', '/api/chart/current')).text).chart;
  const target = current.entries[0];
  const publishedDay = current.day;

  await request(server, 'PATCH', `/api/admin/release/${target.releaseId}`, { cookie, body: { title: 'Future Name', reason: 'display fix' } });

  const gen = await request(server, 'POST', '/api/admin/generate', { cookie, body: {} });
  assert.equal(gen.status, 200);

  const history = JSON.parse((await request(server, 'GET', '/api/chart/history')).text).snapshots;
  const old = history.find(s => s.day === publishedDay);
  const oldEntry = old.entries.find(e => e.releaseId === target.releaseId);
  assert.equal(oldEntry.title, target.title, 'published snapshot keeps original title');
  const fresh = history[history.length - 1];
  if (fresh.day !== publishedDay) {
    const newEntry = fresh.entries.find(e => e.releaseId === target.releaseId);
    if (newEntry) assert.equal(newEntry.title, 'Future Name', 'future charts use corrected title');
  }
});

test('delete submission and release with reason', async (t) => {
  const { server, store } = await boot();
  t.after(() => server.close());
  const cookie = await login(server);

  await request(server, 'GET', '/api/chart/current'); // warm up: generate today's chart
  const sub = JSON.parse((await request(server, 'POST', '/api/submit', { body: { title: 'Delete Me', artist: 'A' } })).text);
  const del = await request(server, 'DELETE', `/api/admin/submission/${sub.submission.id}`, { cookie, body: { reason: 'spam' } });
  assert.equal(del.status, 200);
  const gone = await request(server, 'DELETE', `/api/admin/submission/${sub.submission.id}`, { cookie, body: { reason: 'spam' } });
  assert.equal(gone.status, 404, 'already deleted');

  const released = JSON.parse((await request(server, 'GET', '/api/admin/releases', { cookie })).text).releases.find(r => r.kind === 'rival');
  const songId = released.songId;
  const delRel = await request(server, 'POST', `/api/admin/release/${released.releaseId}/delete`, { cookie, body: { reason: 'rights issue' } });
  assert.equal(delRel.status, 200);
  assert.ok(!store.state.activeSongIds.includes(songId), 'catalogue song id freed');

  const corrections = JSON.parse((await request(server, 'GET', '/api/admin/corrections', { cookie })).text).corrections;
  assert.ok(corrections.some(c => c.type === 'delete-submission'));
  assert.ok(corrections.some(c => c.type === 'delete-release'));
});
