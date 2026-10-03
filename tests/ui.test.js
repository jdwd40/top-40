'use strict';
// Native VM exercises actual client rendering without adding a browser dependency.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const HOUR = '2026-10-03T16:00:00.000Z';
const entry = { rank: 1, releaseId: 'REL-0001', title: 'Northern Sky', artist: 'Copper Echo', hourlySales: 123, cumulativeSales: 456, hoursOnChart: 2, peak: 1, lastHourRank: 2 };
function client(file = 'app.js', overrides = {}) {
  const elements = new Map();
  function element(key) {
    if (!elements.has(key)) elements.set(key, { innerHTML: '', textContent: '', hidden: false, dataset: {}, classList: { add() {} }, listeners: {},
      title: { value: 'A Tune' }, artist: { value: 'A Band' }, genre: { value: 'Rock' }, reset() {},
      addEventListener(event, fn) { this.listeners[event] = fn; },
      querySelectorAll(selector) {
        if (selector !== 'button') return [];
        return [...this.innerHTML.matchAll(/data-day="([^"]+)"/g)].map(([_, hour]) => ({ dataset: { day: hour }, addEventListener(event, fn) { this[event] = fn; } }));
      } });
    return elements.get(key);
  }
  const chart = { hour: HOUR, entries: [entry] };
  const responses = {
    'api/state': { nextBoundary: '2026-10-03T17:00:00.000Z' },
    'api/chart/current': { chart },
    'api/chart/history': { snapshots: [chart] },
    'api/release/REL-0001/history': { title: entry.title, artist: entry.artist, genre: 'Rock', history: [{ hour: HOUR, ...entry }] },
    'api/submit': { submission: { expectedChartHour: '2026-10-03T17:00:00.000Z' } },
    'api/admin/state': { state: {} },
    'api/admin/releases': { releases: [] },
    'api/admin/submissions': { submissions: [] },
    'api/admin/corrections': { corrections: [] },
    'api/admin/preview': { hour: '2026-10-03T17:00:00.000Z', snapshot: chart },
    ...overrides,
  };
  const context = vm.createContext({ Intl, Date, console, document: { querySelector: element, getElementById: id => element('#' + id), querySelectorAll: () => [] },
    window: { matchMedia: () => ({ matches: true }) }, localStorage: { getItem: () => null, setItem() {} },
    setInterval: () => 1, clearInterval() {},
    fetch: async route => ({ ok: true, status: 200, json: async () => responses[route] }),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), context);
  return { context, element, run: expression => vm.runInContext(expression, context) };
}

test('public chart and song history show London HH:mm/date context and hourly sales/appearances', async () => {
  const ui = client();
  await ui.run('loadCurrent()');
  const chart = ui.element('#chartlist').innerHTML;
  assert.match(chart, /17:00/);
  assert.match(chart, /BST/);
  assert.match(chart, /123 sold this hour/);
  assert.match(chart, /2 hours on chart/);
  assert.match(ui.element('#chartdate').textContent, /3 Oct 2026.*17:00/);
  await ui.run("showSong('REL-0001')");
  const history = ui.element('#song-body').innerHTML;
  assert.match(history, /3 Oct 2026.*17:00/);
  assert.match(history, /Hourly sales/);
  assert.match(history, /Hours on chart/);
  assert.doesNotMatch(chart + history, /week|Invalid Date/);
});

test('song view shows labelled genre, with and without chart history, escaped', async () => {
  const ui = client();
  await ui.run("showSong('REL-0001')");
  assert.match(ui.element('#song-body').innerHTML, /Genre: Rock/);

  const empty = client('app.js', { 'api/release/REL-0001/history': { title: 'T', artist: 'A', genre: 'Jazz', history: [] } });
  await empty.run("showSong('REL-0001')");
  const emptyHtml = empty.element('#song-body').innerHTML;
  assert.match(emptyHtml, /Genre: Jazz/);
  assert.match(emptyHtml, /not appeared on a published chart/);

  const evil = client('app.js', { 'api/release/REL-0001/history': { title: 'T', artist: 'A', genre: 'Rock<script>', history: [] } });
  await evil.run("showSong('REL-0001')");
  const evilHtml = evil.element('#song-body').innerHTML;
  assert.match(evilHtml, /Rock&lt;script&gt;/);
  assert.doesNotMatch(evilHtml, /<script>/);
});

test('history groups London dates and distinguishes repeated DST hours using BST/GMT', async () => {
  const hours = ['2026-10-24T22:00:00.000Z', '2026-10-24T23:00:00.000Z', '2026-10-25T00:00:00.000Z', '2026-10-25T01:00:00.000Z'];
  const ui = client('app.js', { 'api/chart/history': { snapshots: hours.map(hour => ({ hour, entries: [entry] })) } });
  await ui.run('loadHistory()');
  const html = ui.element('#daylist').innerHTML;
  assert.equal((html.match(/class="history-date"/g) || []).length, 2);
  assert.match(html, /24 Oct 2026/); assert.match(html, /25 Oct 2026/);
  assert.match(html, /23:00 BST/); assert.match(html, /00:00 BST/);
  assert.match(html, /01:00 BST/); assert.match(html, /01:00 GMT/);
  for (const hour of hours) assert.ok(html.includes(`data-day="${hour}"`));
  const winter = ui.run("chartHtml({ hour: '2026-01-15T18:00:00.000Z', entries: [] })");
  assert.match(winter, /18:00 GMT/);
});

test('submission confirmation renders next real hour in London time without invalid date parsing', async () => {
  const ui = client();
  await ui.element('#submit-form').listeners.submit({ preventDefault() {} });
  const status = ui.element('#submit-status').textContent;
  assert.match(status, /3 Oct 2026.*18:00.*BST/);
  assert.doesNotMatch(status, /Invalid Date|undefined/);
});

test('admin preview uses hourly UTC timestamp and London date/time, not daily labels', async () => {
  const ui = client('admin.js');
  await ui.element('#run-preview').listeners.click();
  const html = ui.element('#preview-body').innerHTML;
  assert.match(html, /3 Oct 2026.*18:00.*BST/);
  assert.match(html, /Hourly sales/);
  assert.doesNotMatch(html, /Invalid Date|Weekly/);
  assert.equal(ui.element('#run-speedup').listeners.click, undefined, 'disabled speed-up has no handler');
});

test('history date headings separate hourly groups and disabled controls stay visibly disabled', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');
  assert.match(css, /\.history-date[^}]*flex-basis:\s*100%/);
  assert.match(css, /\.btn:disabled/);
});
