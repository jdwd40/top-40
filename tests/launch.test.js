'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshState } = require('../src/state');
const { generateForHour, catchUp } = require('../src/chart');
const { addHours } = require('../src/dates');
const START = '2026-06-15T00:00:00.000Z';
function freshGame() { const s = freshState(new Date(START)); s.seed = 42; return s; }

test('launch publishes four unique rivals, not a fresh seeded 40', () => {
  const s = freshGame();
  const { snapshot, created } = generateForHour(s, START);
  assert.equal(created, true);
  assert.equal(snapshot.entries.length, 4);
  assert.equal(new Set(snapshot.entries.map(e => e.songId)).size, 4);
  assert.ok(snapshot.entries.every(e => e.lastHourRank === null && e.hoursOnChart === 1));
  assert.equal(s.releases.length, 4);
});

test('four rivals arrive per elapsed hour until chart fills, then one forever', () => {
  const s = freshGame();
  let filled = false;
  for (let i = 0; i < 80; i++) {
    const hour = addHours(START, i);
    const oldCount = s.releases.length;
    const { snapshot } = generateForHour(s, hour);
    assert.equal(s.releases.length - oldCount, filled ? 1 : 4, hour);
    assert.ok(snapshot.entries.length <= 40);
    if (snapshot.entries.length === 40) filled = true;
  }
  assert.ok(filled);
  assert.equal(s.chartFilled, true);
  // Deletion doesn't return an established game to the four-per-hour launch phase.
  s.releases.splice(0, 10);
  const before = s.releases.length;
  generateForHour(s, addHours(START, 80));
  assert.equal(s.releases.length - before, 1);
});

test('hourly arrivals displace and retire prior chart entries through the lifecycle', () => {
  const s = freshGame();
  let previous = new Set(), departed = 0;
  for (let i = 0; i < 100; i++) {
    const snap = generateForHour(s, addHours(START, i)).snapshot;
    const ids = new Set(snap.entries.map(e => e.releaseId));
    departed += [...previous].filter(id => !ids.has(id)).length;
    previous = ids;
  }
  assert.ok(departed > 0);
  assert.ok(s.releases.some(r => r.retired));
  const liveIds = s.releases.filter(r => !r.retired && r.songId).map(r => r.songId);
  assert.equal(new Set(liveIds).size, liveIds.length);
  assert.deepEqual([...s.activeSongIds].sort(), liveIds.sort());
});

test('future publication and invalid buckets fail without mutation; previews are separate', () => {
  const s = freshGame();
  const before = structuredClone(s);
  assert.throws(() => generateForHour(s, addHours(START, 1), { now: new Date(START) }), /future/i);
  assert.deepEqual(s, before);
  assert.throws(() => generateForHour(s, '2026-06-15'), /Invalid UTC/);
  assert.deepEqual(s, before);
  catchUp(s, new Date(START));
  assert.equal(s.snapshots.length, 1);
});
