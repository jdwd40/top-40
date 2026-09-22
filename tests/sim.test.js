'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshState } = require('../src/state');
const { generateForDay } = require('../src/chart');
const { weeklySales } = require('../src/sim');
const { addDays } = require('../src/dates');

function makeState(seed, originDay = '2026-06-15') {
  const s = freshState();
  s.seed = seed;
  s.originDay = originDay;
  return s;
}

const DAY = '2026-06-15';

test('simulation is deterministic for a given seed', () => {
  const a = generateForDay(makeState(42), DAY).snapshot;
  const b = generateForDay(makeState(42), DAY).snapshot;
  assert.deepEqual(a.entries, b.entries);
  assert.ok(a.entries.length >= 2 && a.entries.length <= 3, 'day one charts only the debuting rivals');
});

test('chart fills to 40 entries as releases accumulate', () => {
  const s = makeState(42);
  let snap;
  for (let i = 0; i < 25; i++) {
    snap = generateForDay(s, addDays(DAY, i)).snapshot;
  }
  assert.equal(snap.entries.length, 40);
});

test('multi-day replay is identical across identical states', () => {
  const days = [DAY, '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19'];
  const run = (seed) => {
    const s = makeState(seed);
    return days.map(d => generateForDay(s, d).snapshot.entries);
  };
  assert.deepEqual(run(7), run(7));
});

test('different seeds produce different charts', () => {
  const a = generateForDay(makeState(1), DAY).snapshot.entries;
  const b = generateForDay(makeState(2), DAY).snapshot.entries;
  assert.notDeepEqual(a.map(e => e.weeklySales), b.map(e => e.weeklySales));
});

test('hidden mojo stays server-side: snapshots carry no mojo, state keeps it', () => {
  const s = makeState(42);
  const snap = generateForDay(s, DAY).snapshot;
  for (const e of snap.entries) assert.ok(!('mojo' in e));
  assert.ok(s.releases.length > 0);
  const m = s.releases[0].mojo;
  for (const k of ['potential', 'debut', 'climb', 'plateau', 'decline', 'variation']) {
    assert.equal(typeof m[k], 'number');
  }
  assert.ok(Array.isArray(m.noise));
  assert.equal(typeof m.variant, 'string');
});

test('ranking tie-break is deterministic: equal sales order by releaseId asc', () => {
  const s = makeState(9);
  const mojo = {
    potential: 0.8, debut: 0.5, climb: 0.5, plateau: 0.5, decline: 0.5, variation: 0.5,
    variant: 'steady', noise: Array.from({ length: 80 }, () => 0.5),
  };
  s.releases.push(
    { releaseId: 'REL-0002', kind: 'rival', songId: 'SONG-002', title: 'B', artist: 'Y', releasedDay: DAY, mojo: { ...mojo }, weeksOnChart: 0, peak: null, lifetimeSales: 0, lastWeekRank: null, retired: false },
    { releaseId: 'REL-0001', kind: 'rival', songId: 'SONG-001', title: 'A', artist: 'X', releasedDay: DAY, mojo: { ...mojo }, weeksOnChart: 0, peak: null, lifetimeSales: 0, lastWeekRank: null, retired: false },
  );
  s.activeSongIds.push('SONG-001', 'SONG-002');
  const snap = generateForDay(s, DAY).snapshot;
  const i1 = snap.entries.findIndex(e => e.releaseId === 'REL-0001');
  const i2 = snap.entries.findIndex(e => e.releaseId === 'REL-0002');
  assert.ok(i1 >= 0 && i2 >= 0, 'both crafted releases charted');
  assert.equal(snap.entries[i1].weeklySales, snap.entries[i2].weeklySales, 'identical mojo gives identical sales');
  assert.ok(i1 < i2, 'tie broken by releaseId ascending');
});

test('sales curves peak and decline', () => {
  const s = makeState(42);
  generateForDay(s, DAY);
  const rel = s.releases.find(r => !r.retired);
  const weeks = Array.from({ length: 40 }, (_, w) => weeklySales(rel, w));
  const peak = Math.max(...weeks);
  const peakWeek = weeks.indexOf(peak);
  assert.ok(peak > 0);
  assert.ok(weeklySales(rel, 39) < peak, 'sales decline after the peak');
  assert.ok(peakWeek < 20, 'peak arrives in the first half of the run');
});

test('user mojo band gives strong (not certain) potential', () => {
  const s = makeState(42);
  s.submissions.push({ id: 1, title: 'Kid Song', artist: 'A Class', submittedAt: '', status: 'pending', releaseId: null });
  generateForDay(s, DAY);
  const user = s.releases.find(r => r.kind === 'user');
  assert.ok(user, 'pending submission debuts as a release');
  assert.ok(user.mojo.potential >= 0.25, 'user potential sampled from a band overlapping rivals');
  assert.ok(user.mojo.potential <= 0.95);
});
