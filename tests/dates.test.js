'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { currentChartHour, nextBoundary, addHours, hourDiff } = require('../src/dates');
test('UTC hourly buckets have exact next boundaries in winter, summer and across DST', () => {
  for (const instant of ['2026-01-15T19:59:59.999Z', '2026-06-15T18:59:59Z', '2026-03-29T00:59:59Z', '2026-03-29T01:00:00Z', '2026-10-25T00:59:59Z', '2026-10-25T01:00:00Z', '2026-12-31T23:59:59Z']) {
    const now = new Date(instant);
    const bucket = currentChartHour(now);
    assert.equal(bucket, instant.slice(0, 13) + ':00:00.000Z');
    assert.equal(nextBoundary(now).getTime(), Date.parse(bucket) + 3600000);
    assert.equal(addHours(bucket, 1), nextBoundary(now).toISOString());
    assert.equal(hourDiff(bucket, addHours(bucket, 3)), 3);
    assert.ok(Date.parse(bucket) <= now.getTime());
  }
});
test('invalid or non-hour chart keys fail loudly', () => {
  for (const bad of ['2026-10-03', '2026-10-03T12:01:00.000Z', 'invalid']) {
    assert.throws(() => addHours(bad, 1), /hour/i);
  }
});
