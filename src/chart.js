'use strict';

// Chart engine: turns state + a chart day into a published snapshot.
// Exactly-once: a day that already has a snapshot is never regenerated, so
// repeated or concurrent calls never double-count sales.

const { getCatalogue, bandIdFor, GENRES } = require('./catalogue');
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
    bandId: sub.bandId || bandIdFor(sub.artist),
    genre: sub.genre || 'Pop',
    superBand: true,
    releasedDay: day,
    mojo: makeMojo(rng, 'user', true),
    weeksOnChart: 0,
    peak: null,
    lifetimeSales: 0,
    lastWeekRank: null,
    retired: false,
  };
}

function createRivalRelease(state, day, rng) {
  const catalogue = getCatalogue();
  const free = catalogue.filter(s => !s.legacy && !state.activeSongIds.includes(s.song_id));
  if (free.length === 0) return null; // catalogue exhausted; wait for retirements
  const song = free[Math.floor(rng() * free.length)];
  state.activeSongIds.push(song.song_id);
  return {
    releaseId: newReleaseId(state, 'rival'),
    kind: 'rival',
    songId: song.song_id,
    title: song.title,
    artist: song.artist,
    bandId: song.bandId,
    genre: song.genre,
    superBand: song.superBand,
    releasedDay: day,
    mojo: makeMojo(rng, 'rival', song.superBand),
    weeksOnChart: 0,
    peak: null,
    lifetimeSales: 0,
    lastWeekRank: null,
    retired: false,
  };
}

function releaseMetadata(release) {
  const catalogueSong = release.songId && getCatalogue().find((song) => song.song_id === release.songId);
  return {
    bandId: catalogueSong?.bandId || release.bandId || bandIdFor(release.artist || catalogueSong?.artist || ''),
    bandName: release.artist || catalogueSong?.artist || '',
    genre: catalogueSong?.genre || (GENRES.includes(release.genre) ? release.genre : 'Pop'),
    superBand: catalogueSong ? Boolean(catalogueSong.superBand) : Boolean(release.superBand),
  };
}

// Generate (or return the existing) snapshot for one chart day.
// Mutates state; caller persists via the store lock.
function generateForDay(state, day, { rivalCount = state.snapshots.length === 0 ? 40 : 1 } = {}) {
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

  // 2. Rival releases. Launch day seeds a full 40-entry chart from the
  //    catalogue; every later chart day adds exactly one rival (skipping when
  //    the catalogue is genuinely exhausted), so a new release can displace
  //    an existing chart entry through the normal retire lifecycle.
  const launch = state.snapshots.length === 0;
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
    const metadata = releaseMetadata(rel);
    // Count chart appearances, not calendar age: after an off-chart gap the
    // number must not include the missed weeks.
    rel.weeksOnChart += 1;
    rel.peak = rel.peak === null ? rank : Math.min(rel.peak, rank);
    rel.lifetimeSales += sales;
    snapshot.entries.push({
      rank,
      releaseId: rel.releaseId,
      songId: rel.songId,
      title: rel.title,
      artist: rel.artist,
      bandId: metadata.bandId,
      bandName: metadata.bandName,
      genre: metadata.genre,
      superBand: metadata.superBand,
      weeklySales: sales,
      cumulativeSales: rel.lifetimeSales,
      weeksOnChart: rel.weeksOnChart,
      peak: rel.peak,
      // Launch entries pre-fill lastWeekRank with their debut rank so the
      // first chart shows no NEW badges; movement next week compares honestly.
      lastWeekRank: launch ? rank : rel.lastWeekRank,
      reentry: !launch && rel.lastWeekRank !== null && !prevRanks.has(rel.releaseId),
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

// Explicit one-off upgrade, called only by the offline migration script.
// Old releases remain in all-time totals and every published snapshot survives.
function transitionCatalogue(state, now = new Date()) {
  if (state.catalogueTransition) return { created: false };
  const catalogue = getCatalogue();
  const legacyIds = new Set(catalogue.filter(song => song.legacy).map(song => song.song_id));
  const retiring = state.releases.filter(release => release.kind === 'rival' && !release.retired && legacyIds.has(release.songId));
  if (!retiring.length) {
    state.catalogueTransition = { day: state.lastGeneratedDay, retiredReleaseIds: [] };
    return { created: false };
  }
  if (catalogue.filter(song => !song.legacy && !state.activeSongIds.includes(song.song_id)).length < 40) {
    throw new Error('Catalogue transition needs 40 available current songs');
  }
  const latest = [state.lastGeneratedDay, ...state.snapshots.map(snapshot => snapshot.day)].filter(Boolean).sort().at(-1);
  const day = latest ? addDays(latest, 1) : state.originDay;
  for (const release of retiring) release.retired = true;
  state.activeSongIds = state.activeSongIds.filter(id => !legacyIds.has(id));
  const result = generateForDay(state, day, { rivalCount: 40 });
  state.catalogueTransition = { day, retiredReleaseIds: retiring.map(release => release.releaseId) };
  state.lastScheduledDay = currentChartDay(now);
  return result;
}

// The wall-clock scheduling cursor is independent of the simulated chart day.
// For old speed-up states, anchor today once; their past real-day offset is unknown.
function catchUp(state, now = new Date()) {
  const today = currentChartDay(now);
  const results = [];
  if (!state.lastScheduledDay) {
    state.lastScheduledDay = state.lastGeneratedDay
      ? (state.lastGeneratedDay > today ? today : state.lastGeneratedDay)
      : addDays(state.originDay, -1);
  }
  let scheduledDay = addDays(state.lastScheduledDay, 1);
  let day = state.lastGeneratedDay ? addDays(state.lastGeneratedDay, 1) : state.originDay;
  let guard = 0;
  while (scheduledDay <= today && guard < 4000) {
    results.push(generateForDay(state, day));
    state.lastGeneratedDay = day; // also advance past an already-published day
    state.lastScheduledDay = scheduledDay;
    day = addDays(day, 1);
    scheduledDay = addDays(scheduledDay, 1);
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
    .map(r => {
      const metadata = releaseMetadata(r);
      return {
        releaseId: r.releaseId,
        songId: r.songId,
        title: r.title,
        artist: r.artist,
        bandId: metadata.bandId,
        bandName: metadata.bandName,
        genre: metadata.genre,
        superBand: metadata.superBand,
        kind: r.kind,
        lifetimeSales: r.lifetimeSales,
        peak: r.peak,
        weeksOnChart: r.weeksOnChart,
      };
    });
}

function publicSnapshot(state, snapshot, { liveOnly = false } = {}) {
  if (!snapshot) return null;
  const releases = new Map(state.releases.map((release) => [release.releaseId, release]));
  const liveIds = liveOnly ? new Set(releases.keys()) : null;
  return {
    ...snapshot,
    entries: snapshot.entries
      .filter((entry) => !liveIds || liveIds.has(entry.releaseId))
      .map((entry, index) => {
        const release = releases.get(entry.releaseId);
        const metadata = releaseMetadata(release || entry);
        return {
          ...entry,
          rank: liveOnly ? index + 1 : entry.rank,
          bandId: release ? metadata.bandId : (entry.bandId || metadata.bandId),
          bandName: entry.bandName || metadata.bandName || entry.artist,
          genre: release ? metadata.genre : (GENRES.includes(entry.genre) ? entry.genre : metadata.genre),
          superBand: release ? metadata.superBand : (entry.superBand ?? metadata.superBand),
        };
      }),
  };
}

function currentSnapshot(state) {
  const snapshot = state.snapshots[state.snapshots.length - 1] || null;
  return publicSnapshot(state, snapshot, { liveOnly: true });
}

function bandLeaderboard(state, limit = 100) {
  const groups = new Map();
  for (const release of state.releases) {
    const metadata = releaseMetadata(release);
    const bandId = metadata.bandId;
    if (!bandId) continue;
    const row = groups.get(bandId) || {
      bandId,
      bandName: metadata.bandName.trim() || bandId,
      genres: new Set(),
      releaseCount: 0,
      lifetimeSales: 0,
      totalWeeks: 0,
      bestPeak: null,
      superBand: false,
    };
    row.genres.add(metadata.genre);
    row.releaseCount += 1;
    row.lifetimeSales += Number(release.lifetimeSales) || 0;
    row.totalWeeks += Number(release.weeksOnChart) || 0;
    if (release.peak !== null && release.peak !== undefined) row.bestPeak = row.bestPeak === null ? release.peak : Math.min(row.bestPeak, release.peak);
    row.superBand = row.superBand || Boolean(release.superBand);
    groups.set(bandId, row);
  }
  return [...groups.values()]
    .map((row) => ({
      ...row,
      genres: [...row.genres],
      earnings: Number((row.lifetimeSales * 0.99).toFixed(2)),
    }))
    .sort((a, b) => b.earnings - a.earnings || (a.bandId < b.bandId ? -1 : 1))
    .slice(0, limit);
}

function genreTopTen(state) {
  const groups = Object.fromEntries(GENRES.map((genre) => [genre, []]));
  const snapshot = currentSnapshot(state);
  if (!snapshot) return groups;
  const releases = new Map(state.releases.map((release) => [release.releaseId, release]));
  for (const entry of snapshot.entries) {
    const release = releases.get(entry.releaseId);
    const genre = GENRES.includes(entry.genre) ? entry.genre : (GENRES.includes(release?.genre) ? release.genre : 'Pop');
    groups[genre].push({
      ...entry,
      genre,
      bandId: entry.bandId || release?.bandId || bandIdFor(entry.artist || release?.artist || ''),
      bandName: entry.bandName || release?.artist || entry.artist,
      superBand: entry.superBand ?? Boolean(release?.superBand),
    });
  }
  for (const genre of GENRES) groups[genre] = groups[genre].slice(0, 10);
  return groups;
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

module.exports = { generateForDay, transitionCatalogue, catchUp, allTime, bandLeaderboard, genreTopTen, publicSnapshot, currentSnapshot, previewNext, RETIRE_SALES };
