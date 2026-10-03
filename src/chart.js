'use strict';

// Chart engine: turns state + a chart hour into a published snapshot.
// Exactly-once: an hour that already has a snapshot is never regenerated, so
// repeated or concurrent calls never double-count sales.

const { getCatalogue, bandIdFor, GENRES } = require('./catalogue');
const { currentChartHour, addHours, hourDiff } = require('./dates');
const { hashSeed, mulberry32, makeMojo, hourlySales } = require('./sim');

const RETIRE_SALES = 300;

function newReleaseId(state, kind) {
  state.counters.release += 1;
  return `${kind === 'user' ? 'USR' : 'REL'}-${String(state.counters.release).padStart(4, '0')}`;
}

function createUserRelease(state, sub, hour, rng) {
  return {
    releaseId: newReleaseId(state, 'user'),
    kind: 'user',
    songId: null,
    title: sub.title,
    artist: sub.artist,
    bandId: sub.bandId || bandIdFor(sub.artist),
    genre: sub.genre || 'Pop',
    superBand: true,
    releasedHour: hour,
    mojo: makeMojo(rng, 'user', true),
    hoursOnChart: 0,
    peak: null,
    lifetimeSales: 0,
    lastHourRank: null,
    retired: false,
  };
}

function createRivalRelease(state, hour, rng) {
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
    releasedHour: hour,
    mojo: makeMojo(rng, 'rival', song.superBand),
    hoursOnChart: 0,
    peak: null,
    lifetimeSales: 0,
    lastHourRank: null,
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

// Generate (or return the existing) snapshot for one chart hour.
// Mutates state; caller persists via the store lock.
function generateForHour(state, hour, { now = new Date(), preview = false } = {}) {
  hourDiff(state.originHour, hour);
  if (!preview && hour > currentChartHour(now)) throw new Error('Cannot publish a future chart hour');
  const existing = state.snapshots.find(s => s.hour === hour);
  if (existing) return { snapshot: existing, created: false };

  const rng = mulberry32(hashSeed(`${state.seed}|${hour}`));

  // Only submissions due at this real hour debut; catch-up cannot backdate them.
  const pending = state.submissions.filter(s => s.status === 'pending' && (!s.expectedChartHour || s.expectedChartHour <= hour)).sort((a, b) => a.id - b.id);
  for (const sub of pending) {
    const rel = createUserRelease(state, sub, hour, rng);
    sub.status = 'released';
    sub.releaseId = rel.releaseId;
    state.releases.push(rel);
  }

  // Four arrivals while filling the chart, then one each hour permanently.
  const rivalCount = state.chartFilled ? 1 : 4;
  for (let i = 0; i < rivalCount; i++) {
    const rel = createRivalRelease(state, hour, rng);
    if (rel) state.releases.push(rel);
  }

  // 3. Score every live release for this hour and rank.
  const prevSnapshot = state.snapshots.length ? state.snapshots[state.snapshots.length - 1] : null;
  const prevRanks = new Map(prevSnapshot ? prevSnapshot.entries.map(e => [e.releaseId, e.rank]) : []);
  const rows = [];
  for (const rel of state.releases) {
    if (rel.retired) continue;
    const w = hourDiff(rel.releasedHour, hour);
    if (w < 0) continue;
    const sales = hourlySales(rel, w);
    if (sales > 0) rows.push({ rel, sales, w });
  }
  // Deterministic tie-break: hourly sales desc, then releaseId asc.
  rows.sort((a, b) => b.sales - a.sales || (a.rel.releaseId < b.rel.releaseId ? -1 : 1));
  const top = rows.slice(0, 40);

  const snapshot = {
    hour,
    hourIndex: hourDiff(state.originHour, hour),
    publishedAt: new Date().toISOString(),
    entries: [],
  };
  top.forEach((row, i) => {
    const rank = i + 1;
    const { rel, sales, w } = row;
    const metadata = releaseMetadata(rel);
    // Count chart appearances, not elapsed age: after an off-chart gap the
    // number must not include the missed hours.
    rel.hoursOnChart += 1;
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
      hourlySales: sales,
      cumulativeSales: rel.lifetimeSales,
      hoursOnChart: rel.hoursOnChart,
      peak: rel.peak,
      lastHourRank: rel.lastHourRank,
      reentry: rel.lastHourRank !== null && !prevRanks.has(rel.releaseId),
    });
    rel.lastHourRank = rank;
  });

  // 4. Retire releases that missed the chart with negligible sales; frees the
  //    catalogue song id for a future rival.
  const inChart = new Set(top.map(r => r.rel));
  for (const rel of state.releases) {
    if (rel.retired || rel.releasedHour > hour) continue;
    const w = hourDiff(rel.releasedHour, hour);
    if (w < 0) continue;
    if (!inChart.has(rel) && hourlySales(rel, w) < RETIRE_SALES) {
      rel.retired = true;
      if (rel.songId) state.activeSongIds = state.activeSongIds.filter(id => id !== rel.songId);
    }
  }

  if (top.length === 40) state.chartFilled = true;
  state.snapshots.push(snapshot);
  state.snapshots.sort((a, b) => (a.hour < b.hour ? -1 : 1));
  state.lastGeneratedHour = hour;
  return { snapshot, created: true };
}

// Replay elapsed UTC buckets under the Store lock, never shift into the future.
function catchUp(state, now = new Date()) {
  const current = currentChartHour(now);
  const results = [];
  let hour = state.lastGeneratedHour ? addHours(state.lastGeneratedHour, 1) : state.originHour;
  while (hour <= current) {
    results.push(generateForHour(state, hour, { now }));
    state.lastGeneratedHour = hour; // existing snapshots also advance a stale cursor
    hour = addHours(hour, 1);
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
        hoursOnChart: r.hoursOnChart,
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
      totalHours: 0,
      bestPeak: null,
      superBand: false,
    };
    row.genres.add(metadata.genre);
    row.releaseCount += 1;
    row.lifetimeSales += Number(release.lifetimeSales) || 0;
    row.totalHours += Number(release.hoursOnChart) || 0;
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

// Hypothetical snapshot for the NEXT chart hour. Pure with respect to the
// caller's state: works on a structured clone, so no sales are counted, no
// submissions consumed, no snapshot persisted. Cannot publish.
function previewNext(state, now = new Date()) {
  const hour = addHours(currentChartHour(now), 1);
  const clone = structuredClone(state);
  catchUp(clone, now);
  const { snapshot } = generateForHour(clone, hour, { now, preview: true });
  return { hour, preview: true, snapshot };
}

module.exports = { generateForHour, catchUp, allTime, bandLeaderboard, genreTopTen, publicSnapshot, currentSnapshot, previewNext, RETIRE_SALES };
