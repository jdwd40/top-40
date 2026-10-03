'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Store, freshState } = require('../src/state');
const { createServer } = require('../server');
const { currentChartDay, chartDayStart, addDays } = require('../src/dates');
const { generateForDay, transitionCatalogue, catchUp, currentSnapshot, allTime, genreTopTen, bandLeaderboard, previewNext } = require('../src/chart');
const { getCatalogue } = require('../src/catalogue');

function legacyGame() {
  const state = freshState();
  state.seed = 42;
  state.originDay = '2026-10-01';
  generateForDay(state, '2026-10-16');
  // Model the old generator's persisted records, not the new catalogue's launch.
  const legacy = getCatalogue().filter(song => song.legacy);
  state.releases.forEach((release, i) => {
    const song = legacy[i];
    Object.assign(release, { songId: song.song_id, title: song.title, artist: song.artist });
    Object.assign(state.snapshots[0].entries.find(entry => entry.releaseId === release.releaseId), {
      songId: song.song_id, title: song.title, artist: song.artist,
    });
  });
  state.releases = state.releases.slice(0, 24);
  state.snapshots[0].entries = state.snapshots[0].entries.filter(entry => state.releases.some(release => release.releaseId === entry.releaseId));
  state.activeSongIds = state.releases.map(release => release.songId);
  return state;
}

test('explicit catalogue transition retires legacy rivals and appends a realistic chart exactly once', () => {
  const state = legacyGame();
  const history = structuredClone(state.snapshots);
  const oldReleases = structuredClone(state.releases);
  const now = new Date('2026-10-03T21:00:00Z');
  const result = transitionCatalogue(state, now);
  assert.equal(result.created, true);
  assert.equal(result.snapshot.day, '2026-10-17');
  assert.equal(result.snapshot.entries.length, 40);
  assert.deepEqual(state.snapshots.slice(0, history.length), history);
  oldReleases.forEach(old => {
    assert.deepEqual(state.releases.find(release => release.releaseId === old.releaseId), { ...old, retired: true });
    assert.ok(allTime(state).some(release => release.releaseId === old.releaseId));
  });
  const currentIds = new Set(getCatalogue().filter(song => !song.legacy).map(song => song.song_id));
  assert.ok(currentSnapshot(state).entries.every(entry => currentIds.has(entry.songId)));
  assert.ok(Object.values(genreTopTen(state)).flat().every(entry => currentIds.has(entry.songId)));
  assert.ok(bandLeaderboard(state).some(band => band.bandName === oldReleases[0].artist));
  assert.equal(new Set(state.activeSongIds).size, 40);
  assert.ok(state.activeSongIds.every(id => currentIds.has(id)));
  const after = structuredClone(state);
  assert.equal(transitionCatalogue(state, now).created, false);
  assert.deepEqual(state, after, 'retry does not advance, count sales or rewrite history');
  previewNext(state);
  assert.deepEqual(state, after, 'preview remains pure');
});

test('wall-clock catch-up advances a future simulated chart once per London day', () => {
  const state = legacyGame();
  const now = new Date('2026-10-03T21:00:00Z');
  const snapshots = structuredClone(state.snapshots);
  assert.deepEqual(catchUp(state, now), [], 'old future cursor is anchored, not replayed');
  assert.equal(state.lastScheduledDay, '2026-10-03');
  assert.equal(catchUp(state, new Date('2026-10-04T18:59:59Z')).length, 0, 'before London 20:00');
  assert.equal(catchUp(state, new Date('2026-10-04T19:00:00Z')).length, 1);
  assert.equal(state.lastGeneratedDay, '2026-10-17');
  assert.equal(catchUp(state, new Date('2026-10-04T21:00:00Z')).length, 0);
  assert.equal(catchUp(state, new Date('2026-10-07T21:00:00Z')).length, 3, 'missed real days replay once');
  assert.equal(state.lastGeneratedDay, '2026-10-20');
  assert.deepEqual(state.snapshots.slice(0, snapshots.length), snapshots);
});

test('offline migration persists, restarts and retries without changing a byte', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'top40-transition-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const state = legacyGame();
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  const script = path.join(__dirname, '../scripts/transition-catalogue.js');
  const run = () => spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).created, true);
  const bytes = fs.readFileSync(file, 'utf8');
  const store = new Store(file);
  await store.init();
  assert.equal(store.state.lastGeneratedDay, '2026-10-17');
  assert.deepEqual(store.state.snapshots[0], state.snapshots[0]);
  const retry = run();
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).created, false);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  const missing = path.join(dir, 'missing.json');
  assert.notEqual(spawnSync(process.execPath, [script, missing]).status, 0);
  assert.equal(fs.existsSync(missing), false, 'migration must not create a new game');
  for (const invalid of ['', 'not JSON', '{"version":2}']) {
    fs.writeFileSync(file, invalid);
    assert.notEqual(run().status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), invalid, 'invalid state remains untouched');
  }
  assert.notEqual(spawnSync(process.execPath, [script], { env: { ...process.env, TOP40_DATA_FILE: missing } }).status, 0);
  assert.equal(fs.existsSync(missing), false, 'no implicit default-file migration');
});

test('upgraded public flows preserve state, history and totals across restart and concurrent daily advancement', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'top40-transition-api-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify(legacyGame()));
  const store = new Store(file);
  await store.init();
  await store.update(state => transitionCatalogue(state));
  const before = structuredClone(store.state);
  const bytes = fs.readFileSync(file, 'utf8');
  const server = createServer({ store, sessionSecret: 'test-only' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async route => {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    const text = await response.text();
    assert.ok(!text.includes('mojo'), route);
    return JSON.parse(text);
  };
  const [current, genres, history, totals, bands, releaseHistory] = await Promise.all([
    '/api/chart/current', '/api/chart/genres', '/api/chart/history', '/api/chart/all-time', '/api/chart/bands',
    `/api/release/${before.releases[0].releaseId}/history`,
  ].map(get));
  // HTTP responses are sent inside Store.update, before its final persist.
  // Finish that writer before inspecting disk or opening a restarted Store.
  await store.queue;
  const legacyIds = new Set(getCatalogue().filter(song => song.legacy).map(song => song.song_id));
  assert.equal(current.chart.entries.length, 40);
  assert.ok(current.chart.entries.every(entry => !legacyIds.has(entry.songId)));
  assert.ok(Object.values(genres.genres).flat().every(entry => !legacyIds.has(entry.songId)));
  assert.ok(history.snapshots[0].entries.some(entry => legacyIds.has(entry.songId)));
  assert.equal(totals.allTime.length, 64);
  assert.ok(bands.bands.length);
  assert.equal(releaseHistory.history.length, 1);
  assert.deepEqual(store.state, before);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'public reads are byte-preserving after upgrade');
  const restart = new Store(file);
  await restart.init();
  const tomorrow = chartDayStart(addDays(currentChartDay(), 1));
  const results = await Promise.all(Array.from({ length: 4 }, () => restart.update(state => catchUp(state, tomorrow))));
  assert.equal(results.flat().filter(result => result.created).length, 1);
  assert.equal(restart.state.lastGeneratedDay, '2026-10-18');
  assert.deepEqual(restart.state.snapshots.slice(0, before.snapshots.length), before.snapshots);
});

test('transition preserves existing user releases and debuts pending submissions normally', () => {
  const state = legacyGame();
  state.releases[0].kind = 'user';
  state.releases[0].songId = null;
  const id = state.releases[0].releaseId;
  state.submissions.push({ id: 1, title: 'A New Day', artist: 'User Band', genre: 'Rock', status: 'pending' });
  const result = transitionCatalogue(state, new Date('2026-10-03T21:00:00Z'));
  assert.equal(result.created, true);
  assert.equal(state.releases.find(release => release.releaseId === id).retired, false);
  assert.equal(state.submissions[0].status, 'released');
  assert.equal(state.releases.find(release => release.releaseId === state.submissions[0].releaseId).kind, 'user');
  assert.equal(state.catalogueTransition.retiredReleaseIds.length, 23);
});

test('current-song exhaustion never resurrects legacy songs and transition preflight is non-mutating', () => {
  const state = legacyGame();
  state.activeSongIds.push(...getCatalogue().filter(song => !song.legacy).map(song => song.song_id));
  const before = structuredClone(state);
  assert.throws(() => transitionCatalogue(state), /40 available current songs/);
  assert.deepEqual(state, before);
  const count = state.releases.length;
  generateForDay(state, '2026-10-17');
  assert.equal(state.releases.length, count, 'no fallback to old joke releases');
});

test('already realistic games need no new chart and repeated transition remains a no-op', () => {
  const state = freshState();
  generateForDay(state, state.originDay);
  const snapshots = structuredClone(state.snapshots);
  assert.equal(transitionCatalogue(state).created, false);
  assert.deepEqual(state.snapshots, snapshots);
  const after = structuredClone(state);
  assert.equal(transitionCatalogue(state).created, false);
  assert.deepEqual(state, after);
});
