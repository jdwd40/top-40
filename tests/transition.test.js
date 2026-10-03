'use strict';
// The daily catalogue migration is deliberately replaced by an explicit backed-up hourly reset.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Store, freshState } = require('../src/state');
const { catchUp, allTime, bandLeaderboard, genreTopTen, previewNext } = require('../src/chart');
const { currentChartHour, addHours } = require('../src/dates');
const { getCatalogue } = require('../src/catalogue');
const script = path.join(__dirname, '../scripts/reset-hourly.js');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'top40-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const backup = path.join(dir, 'private', 'old-state.json');
  const old = { version: 1, seed: 42, originDay: '2026-10-01', lastGeneratedDay: '2026-10-17',
    releases: [{ releaseId: 'REL-0001', lifetimeSales: 123, songId: 'SONG-001' }],
    snapshots: [{ day: '2026-10-17', entries: [{ releaseId: 'REL-0001', weeklySales: 123 }] }],
    submissions: [{ id: 1, status: 'pending' }], activeSongIds: ['SONG-001'], corrections: [], counters: { release: 1, submission: 1 } };
  const bytes = JSON.stringify(old, null, 2); fs.writeFileSync(file, bytes);
  const args = [file, backup, hash(bytes), '--service-stopped'];
  const run = (a = args) => spawnSync(process.execPath, [script, ...a], { encoding: 'utf8' });
  return { dir, file, backup, bytes, args, run };
}

test('offline reset backs up exact daily bytes, clears this game and publishes four current songs at the real hour', async t => {
  const { file, backup, bytes, run } = fixture(t);
  const before = currentChartHour();
  const r = run(); assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.created, true);
  assert.equal(fs.readFileSync(backup, 'utf8'), bytes);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.equal(result.sourceSha256, hash(bytes));
  const store = new Store(file); await store.init();
  assert.equal(store.state.version, 2);
  assert.ok([before, currentChartHour()].includes(store.state.originHour));
  assert.equal(store.state.lastGeneratedHour, store.state.originHour);
  assert.equal(store.state.snapshots.length, 1);
  assert.equal(store.state.snapshots[0].entries.length, 4);
  assert.equal(store.state.releases.length, 4);
  assert.equal(store.state.submissions.length, 0);
  assert.equal(store.state.corrections.length, 0);
  assert.equal(allTime(store.state).length, 4);
  assert.ok(bandLeaderboard(store.state).length <= 4);
  assert.equal(Object.values(genreTopTen(store.state)).flat().length, 4);
  const archive = new Set(getCatalogue().filter(s => s.legacy).map(s => s.song_id));
  assert.ok(store.state.releases.every(r => !archive.has(r.songId)));
  const bytesAfter = fs.readFileSync(file, 'utf8');
  const retry = run(); assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).created, false);
  assert.equal(fs.readFileSync(file, 'utf8'), bytesAfter, 'retry cannot reset a second time');
  assert.equal(fs.readFileSync(backup, 'utf8'), bytes);
  await store.update(s => catchUp(s, new Date(addHours(s.lastGeneratedHour, 1))));
  const restart = new Store(file); await restart.init();
  assert.equal(restart.state.snapshots.length, 2);
  assert.equal(restart.state.releases.length, 8);
});

test('reset requires explicit absolute targets, original hash and stopped-writer acknowledgement', t => {
  const { file, backup, bytes, args, run } = fixture(t);
  for (const bad of [[], [file], args.slice(0, 3), [file, backup, '0'.repeat(64), '--service-stopped'], ['state.json', backup, args[2], '--service-stopped'], [file, file, args[2], '--service-stopped']]) {
    const r = run(bad); assert.notEqual(r.status, 0, r.stdout);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal(fs.existsSync(backup), false);
  }
});

test('reset refuses missing, empty, corrupt and unsupported state without changing files', t => {
  const { dir, file, backup, args, run } = fixture(t);
  const missing = path.join(dir, 'missing.json');
  assert.notEqual(run([missing, backup, args[2], '--service-stopped']).status, 0);
  assert.equal(fs.existsSync(missing), false);
  for (const invalid of ['', 'not JSON', '{"version":3}', '{"version":1}', '{"version":2}']) {
    fs.writeFileSync(file, invalid);
    assert.notEqual(run([file, backup, hash(invalid), '--service-stopped']).status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), invalid);
    assert.equal(fs.existsSync(backup), false);
  }
});

test('reset never overwrites a backup or touches unrelated databases; public backups and symlinks are refused', t => {
  const { dir, file, backup, bytes, args, run } = fixture(t);
  const unrelated = path.join(dir, 'other-game.json'); fs.writeFileSync(unrelated, 'KEEP');
  fs.mkdirSync(path.dirname(backup)); fs.writeFileSync(backup, 'EXISTING');
  assert.notEqual(run().status, 0);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'EXISTING');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'KEEP');
  const publicBackup = path.join(__dirname, '../public/reset-test-backup.json');
  assert.notEqual(run([file, publicBackup, args[2], '--service-stopped']).status, 0);
  assert.equal(fs.existsSync(publicBackup), false);
  const linked = path.join(dir, 'linked-state.json'); fs.symlinkSync(file, linked);
  assert.notEqual(run([linked, path.join(dir, 'new-backup.json'), args[2], '--service-stopped']).status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('v2 restarts, concurrent advancement, pure preview and archived metadata preserve published hourly snapshots', async t => {
  const { file } = fixture(t);
  const state = freshState(new Date('2026-10-03T12:00:00Z')); state.seed = 42;
  catchUp(state, new Date('2026-10-03T14:30:00Z'));
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  const store = new Store(file); await store.init();
  const before = structuredClone(store.state);
  previewNext(store.state, new Date('2026-10-03T14:30:00Z'));
  assert.deepEqual(store.state, before);
  const results = await Promise.all(Array.from({ length: 4 }, () => store.update(s => catchUp(s, new Date('2026-10-03T15:00:00Z')))));
  assert.equal(results.flat().filter(r => r.created).length, 1);
  assert.deepEqual(store.state.snapshots.slice(0, 3), before.snapshots);
  const restarted = new Store(file); await restarted.init();
  assert.deepEqual(restarted.state, store.state);
});

test('catalogue exhaustion never resurrects archived songs', () => {
  const state = freshState(new Date('2026-10-03T12:00:00Z'));
  state.activeSongIds = getCatalogue().filter(s => !s.legacy).map(s => s.song_id);
  catchUp(state, new Date('2026-10-03T13:00:00Z'));
  assert.equal(state.releases.length, 0);
  assert.ok(state.snapshots.every(s => s.entries.length === 0));
});

test('obsolete daily transition script refuses any migration instead of introducing future charts', t => {
  const { file, bytes } = fixture(t);
  const oldScript = path.join(__dirname, '../scripts/transition-catalogue.js');
  const r = spawnSync(process.execPath, [oldScript, file], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /reset-hourly/);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});
