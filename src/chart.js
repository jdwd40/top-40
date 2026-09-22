'use strict';

// Chart engine: turns state + a chart day into a published snapshot.
// Exactly-once: a day that already has a snapshot is never regenerated, so
// repeated or concurrent calls never double-count sales.

const { getCatalogue } = require('./catalogue');
const { currentChartDay, addDays, dayDiff } = require('./dates');
const { hashSeed, mulberry32, makeMojo, weeklySales } = require('./sim');

const RETIRE_SALES = 300;

function newReleaseId(state, kind) {
  state.counters.release += 1;
  return `${kind === 'user' ? 'USR' : 'REL'}-${String(state.counters.release).padStart(4, '0')}`;
}

function createUserRelease(state, sub, day, rng) {
  return {
    releaseId: newReleaseId(state, 'user'),
    kind: 'user',
    songId: null,
    title: sub.title,
    artist: sub.artist,
    releasedDay: day,
    mojo: makeMojo(rng, 'user'),
    weeksOnChart: 0,
    peak: null,
    lifetimeSales: 0,
    lastWeekRank: null,
    retired: false,
  };
}

function createRivalRelease(state, day, rng) {
  const catalogue = getCatalogue();
  const free = catalogue.filter(s => !state.activeSongIds.includes(s.song_id));
  if (free.length === 0) return null; // catalogue exhausted; wait for retirements
  const song = free[Math.floor(rng() * free.length)];
  state.activeSongIds.push(song.song_id);
  return {
    releaseId: newReleaseId(state, 'rival'),
    kind: 'rival',
    songId: song.song_id,
    title: song.title,
    artist: song.artist,
    releasedDay: day,
    mojo: makeMojo(rng, 'rival'),
    weeksOnChart: 0,
    peak: null,
    lifetimeSales: 0,
    lastWeekRank: null,
    retired: false,
  };
}

// Generate (or return the existing) snapshot for one chart day.
// Mutates state; caller persists via the store lock.
function generateForDay(state, day) {
  const existing = state.snapshots.find(s => s.day === day);
  if (existing) return { snapshot: existing, created: false };

  const rng = mulberry32(hashSeed(`${state.seed}|${day}`));

  // 1. Pending user submissions debut today, in submission order.
  const pending = state.submissions.filter(s => s.status === 'pending').sort((a, b) => a.id - b.id);
  for (const sub of pending) {
    const rel = createUserRelease(state, sub, day, rng);
    sub.status = 'released';
    sub.releaseId = rel.releaseId;
    state.releases.push(rel);
  }

  // 2. New rival releases (2-3 per chart day), never reusing a live song id.
  const rivalCount = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < rivalCount; i++) {
    const rel = createRivalRelease(state, day, rng);
    if (rel) state.releases.push(rel);
  }

  // 3. Score every live release for this week and rank.
  const prevSnapshot = state.snapshots.length ? state.snapshots[state.snapshots.length - 1] : null;
  const prevRanks = new Map(prevSnapshot ? prevSnapshot.entries.map(e => [e.releaseId, e.rank]) : []);
  const rows = [];
  for (const rel of state.releases) {
    if (rel.retired) continue;
    const w = dayDiff(rel.releasedDay, day);
    if (w < 0) continue;
    const sales = weeklySales(rel, w);
    if (sales > 0) rows.push({ rel, sales, w });
  }
  // Deterministic tie-break: weekly sales desc, then releaseId asc.
  rows.sort((a, b) => b.sales - a.sales || (a.rel.releaseId < b.rel.releaseId ? -1 : 1));
  const top = rows.slice(0, 40);

  const snapshot = {
    day,
    weekIndex: dayDiff(state.originDay, day),
    publishedAt: new Date().toISOString(),
    entries: [],
  };
  top.forEach((row, i) => {
    const rank = i + 1;
    const { rel, sales, w } = row;
    rel.weeksOnChart = w + 1;
    rel.peak = rel.peak === null ? rank : Math.min(rel.peak, rank);
    rel.lifetimeSales += sales;
    snapshot.entries.push({
      rank,
      releaseId: rel.releaseId,
      songId: rel.songId,
      title: rel.title,
      artist: rel.artist,
      weeklySales: sales,
      cumulativeSales: rel.lifetimeSales,
      weeksOnChart: rel.weeksOnChart,
      peak: rel.peak,
      lastWeekRank: rel.lastWeekRank,
      reentry: rel.lastWeekRank !== null && !prevRanks.has(rel.releaseId),
    });
    rel.lastWeekRank = rank;
  });

  // 4. Retire releases that missed the chart with negligible sales; frees the
  //    catalogue song id for a future rival.
  const inChart = new Set(top.map(r => r.rel));
  for (const rel of state.releases) {
    if (rel.retired || rel.releasedDay > day) continue;
    const w = dayDiff(rel.releasedDay, day);
    if (w < 0) continue;
    if (!inChart.has(rel) && weeklySales(rel, w) < RETIRE_SALES) {
      rel.retired = true;
      if (rel.songId) state.activeSongIds = state.activeSongIds.filter(id => id !== rel.songId);
    }
  }

  state.snapshots.push(snapshot);
  state.snapshots.sort((a, b) => (a.day < b.day ? -1 : 1));
  state.lastGeneratedDay = day;
  return { snapshot, created: true };
}

// Catch up missed chart days in order, from the day after the last generated
// day through today (Europe/London). Idempotent.
function catchUp(state, now = new Date()) {
  const today = currentChartDay(now);
  const results = [];
  let day = state.lastGeneratedDay ? addDays(state.lastGeneratedDay, 1) : state.originDay;
  let guard = 0;
  while (day <= today && guard < 4000) {
    results.push(generateForDay(state, day));
    day = addDays(day, 1);
    guard += 1;
  }
  return results;
}

// All-time ranking computed on demand from release totals.
function allTime(state, limit = 100) {
  return state.releases
    .slice()
    .sort((a, b) => b.lifetimeSales - a.lifetimeSales || (a.releaseId < b.releaseId ? -1 : 1))
    .slice(0, limit)
    .map(r => ({
      releaseId: r.releaseId,
      songId: r.songId,
      title: r.title,
      artist: r.artist,
      kind: r.kind,
      lifetimeSales: r.lifetimeSales,
      peak: r.peak,
      weeksOnChart: r.weeksOnChart,
    }));
}

// Hypothetical snapshot for the NEXT chart day. Pure with respect to the
// caller's state: works on a structured clone, so no sales are counted, no
// submissions consumed, no snapshot persisted. Cannot publish.
function previewNext(state) {
  const day = state.lastGeneratedDay ? addDays(state.lastGeneratedDay, 1) : state.originDay;
  const clone = structuredClone(state);
  const { snapshot } = generateForDay(clone, day);
  return { day, preview: true, snapshot };
}

module.exports = { generateForDay, catchUp, allTime, previewNext, RETIRE_SALES };
