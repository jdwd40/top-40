'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshState } = require('../src/state');
const { generateForHour } = require('../src/chart');
const { makeMojo, mulberry32, hourlySales } = require('../src/sim');
const { addHours } = require('../src/dates');

function makeState(seed, originHour = '2026-06-15T00:00:00.000Z') {
  const s = freshState();
  s.seed = seed;
  s.originHour = originHour;
  return s;
}

const HOUR = '2026-06-15T00:00:00.000Z';

test('simulation is deterministic for a given seed', () => {
  const a = generateForHour(makeState(42), HOUR).snapshot;
  const b = generateForHour(makeState(42), HOUR).snapshot;
  assert.deepEqual(a.entries, b.entries);
  assert.equal(a.entries.length, 4, 'first hour starts with four songs');
});

test('chart fills to 40 entries as releases accumulate', () => {
  const s = makeState(42);
  let snap;
  for (let i = 0; i < 25; i++) {
    snap = generateForHour(s, addHours(HOUR, i)).snapshot;
  }
  assert.equal(snap.entries.length, 40);
});

test('multi-hour replay is identical across identical states', () => {
  const days = [HOUR, '2026-06-15T01:00:00.000Z', '2026-06-15T02:00:00.000Z', '2026-06-15T03:00:00.000Z', '2026-06-15T04:00:00.000Z'];
  const run = (seed) => {
    const s = makeState(seed);
    return days.map(d => generateForHour(s, d).snapshot.entries);
  };
  assert.deepEqual(run(7), run(7));
});

test('different seeds produce different charts', () => {
  const a = generateForHour(makeState(1), HOUR).snapshot.entries;
  const b = generateForHour(makeState(2), HOUR).snapshot.entries;
  assert.notDeepEqual(a.map(e => e.hourlySales), b.map(e => e.hourlySales));
});

test('hidden mojo stays server-side: snapshots carry no mojo, state keeps it', () => {
  const s = makeState(42);
  const snap = generateForHour(s, HOUR).snapshot;
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
  generateForHour(s, HOUR); // launch hour starts with four rivals
  const day2 = addHours(HOUR, 1);
  const mojo = {
    potential: 0.95, debut: 1, climb: 0, plateau: 0, decline: 0, variation: 0,
    variant: 'spike', noise: Array.from({ length: 80 }, () => 1),
  };
  s.releases.push(
    { releaseId: 'REL-9002', kind: 'rival', songId: null, title: 'B', artist: 'Y', releasedHour: day2, mojo: { ...mojo }, hoursOnChart: 0, peak: null, lifetimeSales: 0, lastHourRank: null, retired: false },
    { releaseId: 'REL-9001', kind: 'rival', songId: null, title: 'A', artist: 'X', releasedHour: day2, mojo: { ...mojo }, hoursOnChart: 0, peak: null, lifetimeSales: 0, lastHourRank: null, retired: false },
  );
  const snap = generateForHour(s, day2).snapshot;
  const i1 = snap.entries.findIndex(e => e.releaseId === 'REL-9001');
  const i2 = snap.entries.findIndex(e => e.releaseId === 'REL-9002');
  assert.ok(i1 >= 0 && i2 >= 0, 'both crafted releases charted');
  assert.equal(snap.entries[i1].hourlySales, snap.entries[i2].hourlySales, 'identical mojo gives identical sales');
  assert.ok(i1 < i2, 'tie broken by releaseId ascending');
});

test('sales curves peak and decline', () => {
  const s = makeState(42);
  generateForHour(s, HOUR);
  const rel = s.releases.find(r => !r.retired);
  const hours = Array.from({ length: 40 }, (_, w) => hourlySales(rel, w));
  const peak = Math.max(...hours);
  const peakWeek = hours.indexOf(peak);
  assert.ok(peak > 0);
  assert.ok(hourlySales(rel, 39) < peak, 'sales decline after the peak');
  assert.ok(peakWeek < 20, 'peak arrives in the first half of the run');
});

test('user mojo band gives strong (not certain) potential', () => {
  const s = makeState(42);
  s.submissions.push({ id: 1, title: 'Kid Song', artist: 'A Class', submittedAt: '', status: 'pending', releaseId: null });
  generateForHour(s, HOUR);
  const user = s.releases.find(r => r.kind === 'user');
  assert.ok(user, 'pending submission debuts as a release');
  assert.equal(user.superBand, true);
  assert.equal(user.mojo.variant, 'super band');
  assert.ok(user.mojo.potential >= 0.9, 'user submissions use super-band potential');
  assert.ok(user.mojo.potential <= 1);
});

test('super-band mojo stays strong and retains longer than ordinary mojo', () => {
  const superMojo = makeMojo(mulberry32(1), 'rival', true);
  const ordinaryMojo = makeMojo(mulberry32(1), 'rival', false);
  assert.equal(superMojo.variant, 'super band');
  assert.ok(superMojo.potential >= 0.9);
  assert.ok(hourlySales({ mojo: superMojo }, 8) > hourlySales({ mojo: ordinaryMojo }, 8));
});
