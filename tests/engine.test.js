'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, freshState, dataFile } = require('../src/state');
const { generateForHour, catchUp, allTime, bandLeaderboard, genreTopTen, publicSnapshot, currentSnapshot } = require('../src/chart');
const { getCatalogue } = require('../src/catalogue');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'top40-')), 'state.json');
}

async function makeStore(file, seed = 42) {
  const store = new Store(file);
  await store.init();
  await store.update((s) => { s.seed = seed; s.originHour = '2026-06-15T00:00:00.000Z'; s.lastGeneratedHour = null; });
  return store;
}

function totals(state) {
  return {
    snapshots: state.snapshots.length,
    lifetime: state.releases.reduce((n, r) => n + r.lifetimeSales, 0),
    hourly: state.snapshots.reduce((n, s) => n + s.entries.reduce((m, e) => m + e.hourlySales, 0), 0),
    releases: state.releases.length,
  };
}

const NOW_HOUR_2 = new Date('2026-06-15T02:37:00Z'); // third real UTC bucket, partway through the hour

test('repeated and direct generation is exactly-once', async () => {
  const store = await makeStore(tmpFile());
  await store.update((s) => catchUp(s, NOW_HOUR_2));
  const first = totals(store.state);
  assert.equal(first.snapshots, 3); // UTC 00:00, 01:00, 02:00

  await store.update((s) => catchUp(s, NOW_HOUR_2)); // whole catch-up again
  await store.update((s) => catchUp(s, NOW_HOUR_2));
  await store.update((s) => generateForHour(s, '2026-06-15T01:00:00.000Z')); // direct repeat
  const after = totals(store.state);
  assert.deepEqual(after, first, 'no duplicate sales/snapshots');
  assert.equal(store.state.snapshots.filter(s => s.hour === '2026-06-15T01:00:00.000Z').length, 1);
});

test('concurrent catch-up calls behave like a single run', async () => {
  const file = tmpFile();
  const single = await makeStore(tmpFile());
  await single.update((s) => catchUp(s, NOW_HOUR_2));
  const expected = totals(single.state);

  const store = await makeStore(file);
  await Promise.all(Array.from({ length: 6 }, () => store.update((s) => catchUp(s, NOW_HOUR_2))));
  assert.deepEqual(totals(store.state), expected, 'serialized idempotent generation');
});

test('missed-hour catch-up fills hours in order and preserves published snapshots', async () => {
  const store = await makeStore(tmpFile());
  // Simulate a published 01:00 snapshot ahead of the generator cursor.
  await store.update((s) => {
    s.snapshots.push({
      hour: '2026-06-15T01:00:00.000Z', hourIndex: 1, publishedAt: 'PRESERVED',
      entries: [{ rank: 1, releaseId: 'REL-0001', songId: 'SONG-001', title: 'T', artist: 'A', hourlySales: 1, hoursOnChart: 1, peak: 1, lastHourRank: null }],
    });
    s.lastGeneratedHour = '2026-06-15T00:00:00.000Z';
  });
  const results = await store.update((s) => catchUp(s, NOW_HOUR_2));
  const created = results.filter(r => r.created).map(r => r.snapshot.hour);
  assert.deepEqual(created, ['2026-06-15T02:00:00.000Z'], 'existing day skipped, missing day generated');
  assert.deepEqual(store.state.snapshots.map(s => s.hour), ['2026-06-15T01:00:00.000Z', '2026-06-15T02:00:00.000Z']);
  assert.equal(store.state.snapshots[0].publishedAt, 'PRESERVED', 'published snapshot untouched');
});

test('state survives restart from the same file', async () => {
  const file = tmpFile();
  const a = await makeStore(file);
  await a.update((s) => catchUp(s, NOW_HOUR_2));

  const b = new Store(file);
  await b.init();
  assert.deepEqual(b.state, a.state);
  // And it is still idempotent after restart.
  await b.update((s) => catchUp(s, NOW_HOUR_2));
  assert.deepEqual(totals(b.state), totals(a.state));
});

test('no catalogue song appears twice in any chart', async () => {
  const store = await makeStore(tmpFile());
  await store.update((s) => catchUp(s, new Date('2026-06-16T06:00:00Z'))); // 31 hourly buckets
  const catalogueIds = new Set(getCatalogue().map(s => s.song_id));
  for (const snap of store.state.snapshots) {
    const ids = snap.entries.map(e => e.songId).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, `day ${snap.hour} has no duplicate catalogue songs`);
    for (const id of ids) assert.ok(catalogueIds.has(id), 'song id from catalogue');
  }
});

test('hoursOnChart counts chart appearances, not elapsed age after a gap', () => {
  const s = freshState();
  s.seed = 42;
  s.originHour = '2026-06-15T00:00:00.000Z';
  const rel = {
    releaseId: 'REL-0001', kind: 'rival', songId: 'SONG-001', title: 'T', artist: 'A',
    releasedHour: '2026-06-15T00:00:00.000Z',
    mojo: { potential: 0.9, debut: 1, climb: 0, plateau: 0, decline: 0, variation: 0, variant: 'steady', noise: Array.from({ length: 80 }, () => 1) },
    hoursOnChart: 0, peak: null, lifetimeSales: 0, lastHourRank: null, retired: false,
  };
  s.releases.push(rel);
  s.activeSongIds.push('SONG-001');
  generateForHour(s, '2026-06-15T00:00:00.000Z');
  assert.equal(rel.hoursOnChart, 1);
  // Simulate a missed hour: a day-2 snapshot exists without the release.
  s.snapshots.push({ hour: '2026-06-15T01:00:00.000Z', hourIndex: 1, publishedAt: 'x', entries: [] });
  s.lastGeneratedHour = '2026-06-15T01:00:00.000Z';
  generateForHour(s, '2026-06-15T02:00:00.000Z');
  assert.ok(rel.lastHourRank !== null, 'release re-entered the chart');
  assert.equal(rel.hoursOnChart, 2, 'the off-chart gap hour is not counted');
});

test('TOP40_DATA_FILE env override picks the data file', () => {
  const prev = process.env.TOP40_DATA_FILE;
  process.env.TOP40_DATA_FILE = '/tmp/top40-env-override.json';
  try {
    assert.equal(dataFile(), '/tmp/top40-env-override.json');
  } finally {
    if (prev === undefined) delete process.env.TOP40_DATA_FILE; else process.env.TOP40_DATA_FILE = prev;
  }
});

test('generated catalogue releases and snapshots carry band metadata', () => {
  const state = freshState();
  state.originHour = '2026-06-15T00:00:00.000Z';
  generateForHour(state, state.originHour);
  assert.ok(state.releases.every((release) => release.bandId && release.genre));
  assert.ok(state.snapshots[0].entries.every((entry) => 'genre' in entry && 'bandId' in entry));
});

test('legacy persisted chart data is enriched without rewriting its snapshot', () => {
  const state = freshState();
  state.releases = [{
    releaseId: 'REL-OLD', kind: 'rival', songId: 'SONG-001', title: 'All Men Are on Mute', artist: 'Velvet Avenue',
    lifetimeSales: 100, hoursOnChart: 1, peak: 1,
  }];
  state.snapshots = [{
    hour: '2026-06-15T00:00:00.000Z', entries: [{
      rank: 1, releaseId: 'REL-OLD', songId: 'SONG-001', title: 'All Men Are on Mute', artist: 'Velvet Avenue',
      bandId: 'legacy-velvet', genre: 'Pop', superBand: true,
      hourlySales: 100, cumulativeSales: 100, hoursOnChart: 1, peak: 1,
    }],
  }];

  const current = currentSnapshot(state);
  assert.equal(current.entries[0].genre, 'R&B');
  assert.equal(current.entries[0].bandId, 'velvet-avenue');
  assert.equal(current.entries[0].superBand, false);
  assert.equal(bandLeaderboard(state)[0].genres[0], 'R&B');
  assert.equal(allTime(state)[0].genre, 'R&B');
  assert.equal(publicSnapshot(state, state.snapshots[0]).entries[0].genre, 'R&B');
  assert.equal(state.snapshots[0].entries[0].genre, 'Pop', 'stored history remains immutable');
});

test('band leaderboard aggregates normalized bands and calculates earnings', () => {
  const state = freshState();
  state.releases = [
    { releaseId: 'USR-1', artist: 'Harbor Lights', bandId: 'harbor-lights', genre: 'Rock', lifetimeSales: 100, hoursOnChart: 2, peak: 1, superBand: true },
    { releaseId: 'USR-2', artist: ' harbor lights ', bandId: 'harbor-lights', genre: 'Rock', lifetimeSales: 50, hoursOnChart: 1, peak: 3, superBand: true },
  ];
  const [row] = bandLeaderboard(state);
  assert.equal(row.bandId, 'harbor-lights');
  assert.equal(row.lifetimeSales, 150);
  assert.equal(row.earnings, 148.5);
  assert.equal(row.releaseCount, 2);
});

test('genre leaderboard returns every canonical genre with at most ten entries', () => {
  const state = freshState();
  state.releases = [{ releaseId: 'REL-1', bandId: 'harbor-lights', artist: 'Harbor Lights', genre: 'Rock', superBand: true }];
  state.snapshots = [{ hour: '2026-06-15T00:00:00.000Z', entries: [{ releaseId: 'REL-1', rank: 1, title: 'Signal', artist: 'Harbor Lights', genre: 'Rock', bandId: 'harbor-lights' }] }];
  const genres = genreTopTen(state);
  assert.equal(Object.keys(genres).length, 10);
  assert.equal(genres.Rock.length, 1);
  for (const rows of Object.values(genres)) assert.ok(rows.length <= 10);
});
