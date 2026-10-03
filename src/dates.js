'use strict';
// UTC buckets never drift or repeat across London daylight-saving transitions.
const HOUR_MS = 3600000;
const TZ = 'Europe/London';
function currentChartHour(now = new Date()) {
  return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS).toISOString();
}
function hourMs(hour) {
  const ms = Date.parse(hour);
  if (!Number.isFinite(ms) || ms % HOUR_MS || new Date(ms).toISOString() !== hour) {
    throw new Error(`Invalid UTC chart hour: ${hour}`);
  }
  return ms;
}
function addHours(hour, n) { return new Date(hourMs(hour) + n * HOUR_MS).toISOString(); }
function hourDiff(a, b) { return (hourMs(b) - hourMs(a)) / HOUR_MS; }
function nextBoundary(now = new Date()) { return new Date(addHours(currentChartHour(now), 1)); }
module.exports = { currentChartHour, nextBoundary, addHours, hourDiff, TZ };
