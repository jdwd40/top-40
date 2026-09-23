'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshState } = require('../src/state');
const { generateForDay } = require('../src/chart');
const { addDays } = require('../src/dates');

function freshGame(seed = 42, originDay = '2026-06-15') {
  const s = freshState();
  s.seed = seed;
  s.originDay = originDay;
  return s;
}

test('launch chart seeds exactly 40 rival entries with no NEW badges', () => {
  const s = freshGame();
  const { snapshot, created } = generateForDay(s, s.originDay);
  assert.equal(created, true);
  assert.equal(snapshot.entries.length, 40);
  const songIds = snapshot.entries.map(e => e.songId);
  assert.equal(new Set(songIds).size, 40, '40 distinct catalogue song ids');
  for (const e of snapshot.entries) {
    assert.notEqual(e.lastWeekRank, null, 'launch entries carry no NEW badge');
    assert.equal(e.lastWeekRank, e.rank);
  }
  assert.equal(s.releases.filter(r => r.kind === 'rival').length, 40);
  assert.equal(s.releases.filter(r => r.kind === 'user').length, 0);
});

test('each subsequent chart week adds exactly one rival release', () => {
  const s = freshGame();
  generateForDay(s, s.originDay);
  for (let i = 1; i <= 6; i++) {
    const day = addDays(s.originDay, i);
    generateForDay(s, day);
    const weekRivals = s.releases.filter(r => r.kind === 'rival' && r.releasedDay === day);
    assert.equal(weekRivals.length, 1, `week ${i} adds exactly one rival`);
    assert.equal(s.snapshots[i].entries.length, 40, `week ${i} chart stays full at 40`);
  }
  assert.equal(s.releases.filter(r => r.kind === 'rival').length, 46, '40 launch + 6 weekly rivals');
});

test('weekly arrivals displace prior chart entries through the lifecycle', () => {
  const s = freshGame(42);
  generateForDay(s, s.originDay);
  let prevIds = new Set(s.snapshots[0].entries.map(e => e.releaseId));
  let departedTotal = 0;
  for (let i = 1; i <= 12; i++) {
    const snap = generateForDay(s, addDays(s.originDay, i)).snapshot;
    const nowIds = new Set(snap.entries.map(e => e.releaseId));
    departedTotal += [...prevIds].filter(id => !nowIds.has(id)).length;
    prevIds = nowIds;
  }
  assert.ok(departedTotal >= 1, 'at least one prior entry left the chart within 12 weeks');
  const retired = s.releases.filter(r => r.retired);
  assert.ok(retired.length >= 1, 'off-chart negligible releases retire through the lifecycle');
  const liveSongIds = s.releases.filter(r => !r.retired && r.songId).map(r => r.songId);
  assert.equal(new Set(liveSongIds).size, liveSongIds.length, 'live releases hold distinct song ids after recycling');
  for (const id of s.activeSongIds) {
    assert.ok(liveSongIds.includes(id), 'every reserved song id belongs to a live release');
  }
});
