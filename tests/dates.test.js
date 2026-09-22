'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { currentChartDay, nextBoundary, chartDayStart, addDays, dayDiff } = require('../src/dates');

// Hand-computed expectations. London offsets: GMT (winter) = UTC+0,
// BST (summer) = UTC+1. 2026 transitions: 2026-03-29 01:00 UTC (spring
// forward) and 2026-10-25 01:00 UTC (autumn back).

test('GMT winter: boundary at 20:00 London', () => {
  assert.equal(currentChartDay(new Date('2026-01-15T20:00:00Z')), '2026-01-15');
  assert.equal(currentChartDay(new Date('2026-01-15T19:59:59Z')), '2026-01-14');
  assert.equal(nextBoundary(new Date('2026-01-15T20:00:00Z')).toISOString(), '2026-01-16T20:00:00.000Z');
  assert.equal(nextBoundary(new Date('2026-01-15T19:59:59Z')).toISOString(), '2026-01-15T20:00:00.000Z');
});

test('BST summer: boundary at 20:00 London (19:00 UTC)', () => {
  assert.equal(currentChartDay(new Date('2026-06-15T19:00:00Z')), '2026-06-15');
  assert.equal(currentChartDay(new Date('2026-06-15T18:59:59Z')), '2026-06-14');
  assert.equal(nextBoundary(new Date('2026-06-15T19:00:00Z')).toISOString(), '2026-06-16T19:00:00.000Z');
  assert.equal(nextBoundary(new Date('2026-06-15T18:59:59Z')).toISOString(), '2026-06-15T19:00:00.000Z');
});

test('spring forward: 23-hour absolute window', () => {
  assert.equal(currentChartDay(new Date('2026-03-28T20:00:00Z')), '2026-03-28');
  assert.equal(nextBoundary(new Date('2026-03-28T20:00:00Z')).toISOString(), '2026-03-29T19:00:00.000Z');
});

test('autumn back: 25-hour absolute window', () => {
  assert.equal(currentChartDay(new Date('2026-10-24T19:00:00Z')), '2026-10-24');
  // 20:00 local on Oct 25 falls after the 01:00 UTC transition, so it is 20:00 UTC.
  assert.equal(nextBoundary(new Date('2026-10-24T19:00:00Z')).toISOString(), '2026-10-25T20:00:00.000Z');
  assert.equal(currentChartDay(new Date('2026-10-25T18:59:59Z')), '2026-10-24');
  assert.equal(nextBoundary(new Date('2026-10-25T18:59:59Z')).toISOString(), '2026-10-25T20:00:00.000Z');
});

test('chartDayStart maps a chart day to its 20:00 London reveal instant', () => {
  assert.equal(chartDayStart('2026-01-15').toISOString(), '2026-01-15T20:00:00.000Z');
  assert.equal(chartDayStart('2026-06-15').toISOString(), '2026-06-15T19:00:00.000Z');
  assert.equal(chartDayStart('2026-03-29').toISOString(), '2026-03-29T19:00:00.000Z');
});

test('calendar helpers', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(dayDiff('2026-01-15', '2026-01-20'), 5);
  assert.equal(dayDiff('2026-06-14', '2026-06-15'), 1);
});
