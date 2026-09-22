'use strict';

// Chart-day utilities for Europe/London.
//
// Documented daily boundary: a new chart day begins at 20:00 Europe/London
// local time. During the window [20:00 London day D, 20:00 London day D+1)
// the current chart day is D, so visitors can browse chart D before the next
// reveal at 20:00. All boundary math goes through Intl.DateTimeFormat with
// timeZone 'Europe/London', so GMT/BST and the spring-forward/autumn-back
// transitions are handled without hand-maintained offset tables.

const TZ = 'Europe/London';
const BOUNDARY_HOUR = 20;

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

function londonParts(date) {
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}

function pad(n) { return String(n).padStart(2, '0'); }

function dayStr(parts) { return `${parts.y}-${pad(parts.m)}-${pad(parts.d)}`; }

// Convert a Europe/London wall-clock time to a UTC instant (ms since epoch).
// One correction iteration is enough: London offsets are whole hours and only
// change at 01:00 UTC, so the guess is never near a transition by more than
// the offset itself. We only ever convert noon/20:00 wall times, which are
// never ambiguous on transition days.
function londonWallToUtcMs(y, m, d, h = 0, min = 0, s = 0) {
  const guess = Date.parse(`${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:${pad(s)}Z`);
  const lp = londonParts(new Date(guess));
  const wallMs = Date.parse(`${lp.y}-${pad(lp.m)}-${pad(lp.d)}T${pad(lp.h)}:${pad(lp.min)}:${pad(lp.s)}Z`);
  return guess - (wallMs - guess);
}

// The chart day for a moment in time: the London date of the most recent
// 20:00 boundary. At or after 20:00 London it is today, otherwise yesterday.
function currentChartDay(date = new Date()) {
  const p = londonParts(date);
  if (p.h >= BOUNDARY_HOUR) return dayStr(p);
  // Previous London date, anchored at London noon so a 23h/25h DST day can
  // never push the result across a midnight.
  const prev = new Date(londonWallToUtcMs(p.y, p.m, p.d, 12) - 86400000);
  return dayStr(londonParts(prev));
}

// The next boundary (UTC Date) at which a new chart day is revealed.
function nextBoundary(date = new Date()) {
  const day = currentChartDay(date);
  const [y, m, d] = day.split('-').map(Number);
  const approx = new Date(londonWallToUtcMs(y, m, d, BOUNDARY_HOUR) + 86400000);
  const q = londonParts(approx);
  return new Date(londonWallToUtcMs(q.y, q.m, q.d, BOUNDARY_HOUR));
}

// The reveal instant (UTC Date) for a given chart day 'YYYY-MM-DD'.
function chartDayStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(londonWallToUtcMs(y, m, d, BOUNDARY_HOUR));
}

// Calendar arithmetic on chart-day strings (pure wall-calendar math).
function addDays(day, n) {
  const dt = new Date(day + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function dayDiff(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

module.exports = { currentChartDay, nextBoundary, chartDayStart, addDays, dayDiff, BOUNDARY_HOUR, TZ };
