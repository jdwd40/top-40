'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { freshState, Store } = require('../src/state');
const NOW = new Date('2026-10-03T16:37:42Z');
test('fresh v2 state starts at the actual UTC hour and old state fails without mutation', async t => {
  const state = freshState(NOW);
  assert.equal(state.version, 2);
  assert.equal(state.originHour, '2026-10-03T16:00:00.000Z');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'top40-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const old = JSON.stringify({ ...state, version: 1, originHour: '2026-10-01', lastGeneratedHour: '2026-10-17' });
  fs.writeFileSync(file, old);
  await assert.rejects(new Store(file).init(), /reset-hourly.*stopped/i);
  assert.equal(fs.readFileSync(file, 'utf8'), old);
  fs.writeFileSync(file, '');
  await assert.rejects(new Store(file).init(), /empty/i);
  assert.equal(fs.readFileSync(file, 'utf8'), '');
});

const { catchUp, previewNext, generateForHour } = require('../src/chart');
const { addHours } = require('../src/dates');

test('DST catch-up publishes each UTC hour once despite repeated or skipped London hours and clock rollback', () => {
  for (const start of ['2026-03-29T00:00:00.000Z', '2026-10-25T00:00:00.000Z']) {
    const state = freshState(new Date(start)); state.seed = 42;
    const end = new Date(addHours(start, 3));
    assert.equal(catchUp(state, end).length, 4);
    assert.deepEqual(state.snapshots.map(s => s.hour), [0, 1, 2, 3].map(n => addHours(start, n)));
    const before = structuredClone(state);
    assert.equal(catchUp(state, end).length, 0);
    assert.equal(catchUp(state, new Date(start)).length, 0);
    assert.deepEqual(state, before);
  }
});

test('preview catches up only its clone before scoring the next real hour', () => {
  const state = freshState(new Date('2026-10-03T12:00:00Z')); state.seed = 42;
  const now = new Date('2026-10-03T15:37:00Z');
  const before = structuredClone(state);
  const expected = structuredClone(state);
  catchUp(expected, now);
  const hour = '2026-10-03T16:00:00.000Z';
  const snapshot = generateForHour(expected, hour, { now: new Date(hour) }).snapshot;
  const preview = previewNext(state, now);
  assert.equal(preview.hour, hour);
  assert.deepEqual(preview.snapshot.entries, snapshot.entries);
  assert.deepEqual(state, before);
});

test('failed writes roll back in-memory hourly sales so retries cannot lose or double-count a bucket', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'top40-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, 'state.json')); await store.init();
  const before = structuredClone(store.state), bytes = fs.readFileSync(store.file, 'utf8');
  const persist = store._persist.bind(store);
  store._persist = async () => { throw new Error('disk write unavailable'); };
  await assert.rejects(store.update(s => catchUp(s)), /disk write/);
  assert.deepEqual(store.state, before);
  assert.equal(fs.readFileSync(store.file, 'utf8'), bytes);
  store._persist = persist;
  assert.equal((await store.update(s => catchUp(s))).filter(r => r.created).length, 1);
  const restart = new Store(store.file); await restart.init();
  assert.deepEqual(restart.state, store.state);
});

test('malformed v2 timestamps and duplicate snapshots fail loudly without automatic repair', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'top40-malformed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  const state = freshState(NOW);
  const variants = [
    { ...state, originHour: '2026-10-03' },
    { ...state, lastGeneratedHour: '2026-10-03T16:30:00.000Z' },
    { ...state, snapshots: [{ hour: state.originHour, entries: [] }, { hour: state.originHour, entries: [] }] },
    { ...state, submissions: null },
    { ...state, counters: { release: -1, submission: 0 } },
    { ...state, releases: [{ releasedHour: '2026-10-03' }] },
  ];
  for (const value of variants) {
    const bytes = JSON.stringify(value); fs.writeFileSync(file, bytes);
    await assert.rejects(new Store(file).init(), /Invalid|metadata/);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
});
