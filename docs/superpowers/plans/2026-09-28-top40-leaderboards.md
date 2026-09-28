# Tripper City Top 40 Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the Tripper City Top 40 catalogue and simulation with realistic genres, durable super bands, band earnings and genre leaderboards, admin-only deletion with replacement releases, and documented admin access.

**Architecture:** Keep the existing standard-library Node.js server, JSON state store, markdown catalogue, deterministic chart engine, and plain browser UI. Add metadata to catalogue/release/snapshot records, compute leaderboards from existing state, and reuse the existing admin session and next-day release path. Published snapshots remain immutable; live reads filter deleted releases.

**Tech Stack:** Node.js CommonJS, built-in `node:test`, built-in `http`, browser HTML/CSS/JavaScript, markdown catalogue, JSON-file persistence.

**Spec:** `docs/superpowers/specs/2026-09-28-top40-leaderboards-design.md`

## Global Constraints

- Keep the app dependency-light and modular; add no runtime dependencies.
- Preserve the existing 100 catalogue songs and all published chart snapshots.
- Keep hidden mojo private to admin endpoints.
- Admin deletion requires a 3–300 character reason and writes a correction-log record.
- Use `npm test` for the required test suite and `npm run check` for syntax checks.
- Use canonical genres: Hip-Hop, Dance/EDM, Rock, Pop, R&B, Country, Indie, Soul, Alternative, Electronic.
- Simulated earnings are `lifetimeSales * 0.99` in pounds and are ranking/display data only.

## Review Focus

- A legacy four-column catalogue row must still parse and remain eligible as a fallback after the expanded catalogue is exhausted; test parser compatibility and legacy retention.
- A deleted release can still appear in an immutable stored snapshot; test that current/leaderboard reads hide it while history remains unchanged.
- A submission with a missing or unknown genre must be rejected before state mutation; test both validation paths.
- Repeated generation after deletion must not publish duplicate snapshots or count sales twice; test exactly-once replacement generation.
- A user-submitted artist with different casing/spaces must aggregate under one band key; test normalized band aggregation.

---

### Task 1: Extend the catalogue with realistic metadata and songs

**Files:**
- Modify: `ridiculous-top-40-song-catalogue.md`
- Modify: `src/catalogue.js`
- Test: `tests/catalogue.test.js`

**Interfaces:**
- Consumes: existing markdown rows with `song_id | artist | genre | title`.
- Produces: `parseCatalogue(markdown)` rows with `song_id`, `artist`, `genre`, `title`, `bandId`, `superBand`, and `legacy`; `getCatalogue()` keeps its cached array contract.

- [ ] **Step 1: Write the failing parser and catalogue tests**

Add tests that assert the 100 original rows remain, at least 400 rows exist after expansion, exactly 100 rows are `legacy`, every song ID is unique, every genre belongs to the canonical set, and an extended row parses metadata:

```js
test('keeps legacy songs and parses expanded realistic catalogue metadata', () => {
  const songs = parseCatalogue(fs.readFileSync(CATALOGUE_FILE, 'utf8'));
  assert.ok(songs.length >= 400);
  assert.equal(songs.filter((song) => song.legacy).length, 100);
  assert.ok(songs.some((song) => song.bandId && song.superBand === true));
  assert.ok(songs.some((song) => song.artist === 'Harbor Lights' && song.genre === 'Rock'));
  assert.equal(new Set(songs.map((song) => song.song_id)).size, songs.length);
  for (const song of songs) assert.ok(GENRES.includes(song.genre));
});

test('legacy four-column rows default to preserved legacy metadata', () => {
  const [song] = parseCatalogue('| SONG-001 | Old Act | Pop | Old Song |\n');
  assert.equal(song.bandId, 'old-act');
  assert.equal(song.superBand, false);
  assert.equal(song.legacy, true);
});
```

Export `GENRES` from `src/catalogue.js` so tests and later modules use one list.

- [ ] **Step 2: Run the focused tests and verify the expected failure**

Run:

```sh
node --test tests/catalogue.test.js
```

Expected: FAIL because the current parser returns 100 four-field rows and does not export `GENRES`.

- [ ] **Step 3: Implement the smallest parser change**

Parse optional cells after the first four fields. Normalize band IDs from artist text when absent. Map preserved legacy labels such as `R&B group`, `Boy band`, and `Dance producer` to the canonical genre list while keeping the original songs and display names. Treat old four-column rows as legacy and parse `1`, `true`, or `super` as `superBand` for extended rows:

```js
const bandId = cells[4] || artist.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const superBand = ['1', 'true', 'super'].includes((cells[5] || '').toLowerCase());
const legacy = cells[6] === undefined ? true : !['0', 'false', 'current'].includes(cells[6].toLowerCase());
```

Add the canonical `GENRES` array, a small legacy-genre mapping used only for chart grouping, and return all metadata fields.

- [ ] **Step 4: Append the expanded catalogue data**

Keep `SONG-001` through `SONG-100` unchanged. Append at least `SONG-101` through `SONG-400` as extended rows, using realistic fictional band names and song titles across all ten canonical genres. Include several `superBand` rows, mark all new rows `current`, and ensure no real performer is used.

- [ ] **Step 5: Run the focused tests and verify they pass**

Run:

```sh
node --test tests/catalogue.test.js
```

Expected: PASS with at least 400 unique songs, 100 legacy songs, and all genres canonical.

- [ ] **Step 6: Commit the catalogue slice**

```sh
git add ridiculous-top-40-song-catalogue.md src/catalogue.js tests/catalogue.test.js
git commit -m "feat: expand Top 40 catalogue with genres and bands"
```

### Task 2: Add super-band simulation and release metadata

**Files:**
- Modify: `src/sim.js`
- Modify: `src/chart.js`
- Modify: `tests/engine.test.js`
- Modify: `tests/sim.test.js`

**Interfaces:**
- Consumes: catalogue metadata from Task 1 and existing `makeMojo(rng, kind)` callers.
- Produces: `makeMojo(rng, kind, superBand = false)`, releases with `bandId`, `genre`, and `superBand`, and snapshot entries with the same safe metadata.

- [ ] **Step 1: Write failing super-band tests**

Add tests for a super-band release's strong profile and metadata propagation:

```js
test('super-band mojo stays strong and retains longer than ordinary mojo', () => {
  const superMojo = makeMojo(mulberry32(1), 'rival', true);
  const ordinaryMojo = makeMojo(mulberry32(1), 'rival', false);
  assert.equal(superMojo.variant, 'super band');
  assert.ok(superMojo.potential >= 0.9);
  assert.ok(weeklySales({ mojo: superMojo }, 8) > weeklySales({ mojo: ordinaryMojo }, 8));
});

test('generated catalogue releases and snapshots carry band metadata', () => {
  const state = freshState();
  state.originDay = '2026-06-15';
  generateForDay(state, state.originDay);
  assert.ok(state.releases.every((release) => release.bandId && release.genre));
  assert.ok(state.snapshots[0].entries.every((entry) => 'genre' in entry && 'bandId' in entry));
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```sh
node --test tests/sim.test.js tests/engine.test.js
```

Expected: FAIL because `makeMojo` has no super-band profile and generated records have no genre/band metadata.

- [ ] **Step 3: Implement the super-band curve**

Extend `makeMojo` without changing ordinary callers. Use a deterministic `super band` variant with potential in `0.90..1.00`, a long retention range, and lower noise variation. Add a `super band` case in `weeklySales` with a long plateau and high retention. Keep tie-breaking and deterministic seed behavior unchanged.

- [ ] **Step 4: Propagate catalogue metadata through chart generation**

In `createRivalRelease`, prefer current catalogue entries and copy `bandId`, `genre`, and `superBand`. In `createUserRelease`, copy the submission genre, derive a normalized band ID from the submitted artist, set `superBand: true`, and call `makeMojo(rng, 'user', true)`. Add `bandId`, `genre`, and `superBand` to snapshot entries.

- [ ] **Step 5: Run focused and full tests**

Run:

```sh
node --test tests/sim.test.js tests/engine.test.js
npm test
```

Expected: PASS; existing exactly-once, ranking, and determinism tests remain green.

- [ ] **Step 6: Commit the simulation slice**

```sh
git add src/sim.js src/chart.js tests/sim.test.js tests/engine.test.js
git commit -m "feat: model super bands and release genres"
```

### Task 3: Add leaderboard calculations and public API payloads

**Files:**
- Modify: `src/chart.js`
- Modify: `server.js`
- Test: `tests/api.test.js`
- Test: `tests/engine.test.js`

**Interfaces:**
- Consumes: release/snapshot metadata from Task 2.
- Produces: `bandLeaderboard(state, limit = 100)`, `genreTopTen(state)`, `GET /api/chart/bands`, and `GET /api/chart/genres`.

- [ ] **Step 1: Write failing calculation and endpoint tests**

Add a calculation test with two releases whose artist casing differs and an API test for both endpoints:

```js
test('band leaderboard aggregates normalized bands and calculates earnings', () => {
  const state = freshState();
  state.releases = [
    { releaseId: 'USR-1', artist: 'Harbor Lights', bandId: 'harbor-lights', genre: 'Rock', lifetimeSales: 100, weeksOnChart: 2, peak: 1, superBand: true },
    { releaseId: 'USR-2', artist: ' harbor lights ', bandId: 'harbor-lights', genre: 'Rock', lifetimeSales: 50, weeksOnChart: 1, peak: 3, superBand: true },
  ];
  const [row] = bandLeaderboard(state);
  assert.equal(row.bandId, 'harbor-lights');
  assert.equal(row.lifetimeSales, 150);
  assert.equal(row.earnings, 148.5);
  assert.equal(row.releaseCount, 2);
});
```

The endpoint test must assert `/api/chart/bands` returns sorted earnings, `/api/chart/genres` returns every canonical genre key with no more than ten entries, and public payloads contain no `mojo`.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```sh
node --test tests/api.test.js tests/engine.test.js
```

Expected: FAIL because the leaderboard functions and routes do not exist.

- [ ] **Step 3: Implement pure leaderboard functions**

Add `bandLeaderboard` to `src/chart.js`. Ignore releases removed from state, group by `bandId`, sum lifetime sales and chart weeks, choose the best peak, collect unique genres, and calculate rounded earnings:

```js
const earnings = Number((lifetimeSales * 0.99).toFixed(2));
```

Add `genreTopTen` that reads the newest snapshot, filters entries whose release still exists, resolves missing legacy genres to Pop, and returns every canonical genre with entries sliced to ten.

- [ ] **Step 4: Add public routes and safe metadata**

Import both functions in `server.js`. Add routes that call `ensureFresh(state)` and return `{ bands }` or `{ genres }`. Add `genre`, `bandId`, `bandName`, and `superBand` to public chart/all-time payloads, never `mojo`. Make current-chart reads use a live filtered view so deleted releases are not returned before the next chart.

- [ ] **Step 5: Run focused and full tests**

Run:

```sh
node --test tests/api.test.js tests/engine.test.js
npm test
```

Expected: PASS with sorted band earnings, ten-or-fewer genre entries, and no public mojo leak.

- [ ] **Step 6: Commit the leaderboard slice**

```sh
git add src/chart.js server.js tests/api.test.js tests/engine.test.js
git commit -m "feat: add band and genre leaderboards"
```

### Task 4: Make submissions genre-aware and always super bands

**Files:**
- Modify: `server.js`
- Modify: `public/index.html`
- Modify: `public/app.js`
- Test: `tests/api.test.js`

**Interfaces:**
- Consumes: `GENRES` from `src/catalogue.js` and user-release metadata from Task 2.
- Produces: validated `POST /api/submit` with required `genre`, and form submission payload `{ title, artist, genre }`.

- [ ] **Step 1: Write failing submission tests**

Add tests that reject an omitted/unknown genre without adding a submission and accept a canonical genre with `superBand: true` after the next chart:

```js
test('submissions require a canonical genre and become super bands', async (t) => {
  const { server, store } = await boot();
  t.after(() => server.close());
  const bad = await request(server, 'POST', '/api/submit', { body: { title: 'A', artist: 'B', genre: 'Opera' } });
  assert.equal(bad.status, 400);
  const good = await request(server, 'POST', '/api/submit', { body: { title: 'A', artist: 'B', genre: 'Rock' } });
  assert.equal(good.status, 201);
  const cookie = await login(server);
  await request(server, 'POST', '/api/admin/speedup', { cookie, body: {} });
  const release = store.state.releases.find((row) => row.kind === 'user');
  assert.equal(release.genre, 'Rock');
  assert.equal(release.superBand, true);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```sh
node --test tests/api.test.js
```

Expected: FAIL because the current endpoint ignores `genre` and user releases have no genre/super-band metadata.

- [ ] **Step 3: Implement validation and persistence**

Validate `body.genre` against `GENRES`, store it on the submission, include it in the 201 response, and default missing legacy persisted submissions to Pop when releasing. Keep title/artist limits and rate limiting unchanged.

- [ ] **Step 4: Add the native genre select**

Add a required `<select id="f-genre" name="genre">` populated with the canonical genres in `public/index.html`. Include it in the browser validation and JSON payload in `public/app.js`. Update the hint to state that submissions are automatically treated as super bands.

- [ ] **Step 5: Run focused and full tests**

Run:

```sh
node --test tests/api.test.js
npm test
npm run check
```

Expected: PASS; invalid genres return 400 and valid submissions carry genre and super-band status.

- [ ] **Step 6: Commit the submission slice**

```sh
git add server.js public/index.html public/app.js tests/api.test.js
 git commit -m "feat: add submission genres and super-band status"
```

### Task 5: Harden deletion and replacement behavior

**Files:**
- Modify: `server.js`
- Modify: `src/chart.js`
- Modify: `public/admin.js`
- Test: `tests/admin.test.js`
- Test: `tests/engine.test.js`

**Interfaces:**
- Consumes: existing authenticated delete route and leaderboard/live-view filtering from Task 3.
- Produces: deletion that removes the release from live state, frees the song ID, logs the reason, and causes a replacement on the next generated day.

- [ ] **Step 1: Write failing deletion regression tests**

Add tests that delete a live rival after warm-up, assert the current endpoint and leaderboards hide it, assert the stored prior snapshot is unchanged, then generate one day and assert a different rival release appears:

```js
test('admin deletion hides a release and next chart replaces it', async (t) => {
  const { server, store } = await boot();
  t.after(() => server.close());
  const cookie = await login(server);
  const current = JSON.parse((await request(server, 'GET', '/api/chart/current')).text).chart;
  const target = current.entries[0];
  const before = JSON.stringify(store.state.snapshots[store.state.snapshots.length - 1]);
  const deleted = await request(server, 'POST', `/api/admin/release/${target.releaseId}/delete`, { cookie, body: { reason: 'remove test release' } });
  assert.equal(deleted.status, 200);
  const live = JSON.parse((await request(server, 'GET', '/api/chart/current')).text).chart;
  assert.ok(!live.entries.some((entry) => entry.releaseId === target.releaseId));
  assert.equal(JSON.stringify(store.state.snapshots[store.state.snapshots.length - 1]), before);
  await request(server, 'POST', '/api/admin/speedup', { cookie, body: {} });
  assert.ok(store.state.releases.some((release) => release.kind === 'rival' && release.releaseId !== target.releaseId));
});
```

Also assert the route still returns 401 without a session and rejects a reason shorter than three characters.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```sh
node --test tests/admin.test.js tests/engine.test.js
```

Expected: FAIL because current reads still expose the old snapshot entry and the deletion response has no replacement semantics.

- [ ] **Step 3: Implement live filtering and deletion response**

Keep stored snapshots untouched. Add a small current-snapshot filter in `src/chart.js` or `server.js` that removes entries whose release ID is no longer in `state.releases` and reassigns display ranks. Keep the existing correction record and freed `activeSongIds`. Return `{ ok: true, replacementScheduled: true }` from deletion.

- [ ] **Step 4: Update admin copy**

Change the delete success message to state that the release was removed from live lists and a replacement will arrive on the next generated chart. Do not add a second release-generation path.

- [ ] **Step 5: Run focused and full tests**

Run:

```sh
node --test tests/admin.test.js tests/engine.test.js
npm test
```

Expected: PASS with immutable history, hidden deleted release, freed catalogue ID, and one replacement on the next generated day.

- [ ] **Step 6: Commit the deletion slice**

```sh
git add server.js src/chart.js public/admin.js tests/admin.test.js tests/engine.test.js
 git commit -m "feat: remove releases from live charts with replacement flow"
```

### Task 6: Add public genre and band leaderboard views

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/style.css`
- Test: `tests/api.test.js`

**Interfaces:**
- Consumes: `/api/chart/genres` and `/api/chart/bands` from Task 3.
- Produces: accessible public tabs and rendered tables with escaped values and retry states.

- [ ] **Step 1: Add the failing static asset assertions**

Extend the browser-facing route test to assert the public HTML contains `Genre Top 10s` and `Band leaderboard`. The genre select is covered by Task 4; these tab labels fail before this task's markup exists.

- [ ] **Step 2: Run the static test and verify failure**

Run:

```sh
node --test tests/api.test.js
```

Expected: FAIL because the new leaderboard tab labels are absent.

- [ ] **Step 3: Add public markup**

Add `Genres` and `Band Leaderboard` tabs, corresponding sections, loading hosts, offline messages, and retry buttons. Keep the existing tab ARIA pattern and mobile-first structure.

- [ ] **Step 4: Render the two leaderboards**

Add `loadGenres()` and `loadBands()` in `public/app.js`. `loadGenres()` renders one table per canonical genre with at most ten rows; `loadBands()` renders earnings, sales, releases, best peak, weeks, and a Super Band badge. Reuse `esc`, `fmt`, `getJson`, announce, and retry patterns. Wire both loaders from `switchView` and escape every server value.

- [ ] **Step 5: Add only the needed responsive styles**

Reuse `table.data`, `.panel`, `.badge`, and existing color variables. Add the small responsive rules `.leaderboard-grid { display: grid; gap: 1rem; }` and `@media (min-width: 40rem) { .leaderboard-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }`; do not introduce a CSS framework or new layout abstraction.

- [ ] **Step 6: Run tests and syntax checks**

Run:

```sh
npm test
npm run check
```

Expected: PASS with all routes and browser assets served and all JavaScript syntax checks clean.

- [ ] **Step 7: Commit the public UI slice**

```sh
git add public/index.html public/app.js public/style.css tests/api.test.js
 git commit -m "feat: show genre and band leaderboards"
```

### Task 7: Document admin access and update project state

**Files:**
- Modify: `README.md`
- Modify: `docs/project-state.md`
- Modify: `public/admin.html`
- Test: `tests/api.test.js`

**Interfaces:**
- Consumes: the existing `/admin.html` route and environment names in `src/auth.js`.
- Produces: clear local/production access instructions without credentials or secrets.

- [ ] **Step 1: Write the documentation route assertion**

Add an assertion that `README.md` contains `/top40/admin.html`, `TOP40_ADMIN_USER`, and `TOP40_ADMIN_PASSWORD`:

```js
test('README documents admin access without credentials', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /\/top40\/admin\.html/);
  assert.match(readme, /TOP40_ADMIN_USER/);
  assert.match(readme, /TOP40_ADMIN_PASSWORD/);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```sh
node --test tests/api.test.js
```

Expected: FAIL because the current README only describes the project and does not document admin access.

- [ ] **Step 3: Document login steps**

Add a short README section:

```md
## Admin access

Open `https://jdwd40.com/top40/admin.html` in production, or
`http://localhost:<TOP40_PORT>/admin.html` locally. Sign in with the values
configured in `TOP40_ADMIN_USER` and `TOP40_ADMIN_PASSWORD`. Credentials are
server environment variables and must not be committed. Login is disabled when
the password is unset.
```

Update `docs/project-state.md` with the new catalogue size, leaderboard endpoints, deletion behavior, and submission super-band rule. Add a short admin-page hint pointing back to the README without exposing credentials.

- [ ] **Step 4: Run tests and syntax checks**

Run:

```sh
npm test
npm run check
```

Expected: PASS with documentation assertions and no syntax errors.

- [ ] **Step 5: Commit the documentation slice**

```sh
git add README.md docs/project-state.md public/admin.html tests/api.test.js
 git commit -m "docs: document Top 40 admin access and leaderboards"
```

### Task 8: Final verification and branch handoff

**Files:**
- Verify: all changed files in Tasks 1–7.
- Create: `runs/20260928-top40-leaderboards/tests.txt`
- Create: `runs/20260928-top40-leaderboards/STATUS.md`

**Interfaces:**
- Consumes: all implementation commits and the repository scripts.
- Produces: reproducible verification evidence and a clean isolated branch.

- [ ] **Step 1: Run the complete required checks**

Run:

```sh
npm test
npm run check
git diff --check
git status --short
```

Expected: all tests pass, syntax checks pass, whitespace check is clean, and only intended source/docs/test files are changed.

- [ ] **Step 2: Exercise the public API against a fresh temporary state**

Run this temporary-state smoke script from the repository root; it must exit 0 and must not create runtime state in the repository:

```sh
node <<'NODE'
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Store } = require('./src/state');
const { createServer } = require('./server');
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'top40-smoke-')), 'state.json');
const request = (port, method, url, body) => new Promise((resolve, reject) => {
  const payload = body ? JSON.stringify(body) : null;
  const req = http.request({ port, path: url, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, (res) => {
    res.resume();
    res.on('end', () => resolve(res.statusCode));
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});
(async () => {
  const store = new Store(file);
  await store.init();
  const server = createServer({ store, sessionSecret: 'smoke-secret' });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const codes = [
    await request(port, 'GET', '/api/chart/current'),
    await request(port, 'GET', '/api/chart/genres'),
    await request(port, 'GET', '/api/chart/bands'),
    await request(port, 'POST', '/api/submit', { title: 'Smoke Song', artist: 'Smoke Band', genre: 'Rock' }),
  ];
  server.close();
  if (codes.join(',') !== '200,200,200,201') throw new Error(codes.join(','));
})().catch((error) => { console.error(error); process.exitCode = 1; });
NODE
```

- [ ] **Step 3: Record evidence**

Write `runs/20260928-top40-leaderboards/tests.txt` with the exact commands and their observed exit codes. Write `STATUS.md` with the final branch name, commit IDs, changed-file summary, and any remaining deployment note. Do not include credentials or runtime state.

- [ ] **Step 4: Perform the final diff review**

Run:

```sh
git diff fc6d905..HEAD --stat
git diff fc6d905..HEAD --name-only
git log --oneline --decorate -10
```

Confirm the diff contains no secrets, generated runtime data, unrelated refactors, or dependency changes.

- [ ] **Step 5: Commit verification evidence**

```sh
git add runs/20260928-top40-leaderboards/tests.txt runs/20260928-top40-leaderboards/STATUS.md
git commit -m "test: record Top 40 enhancement verification"
```

Report the isolated branch, final commit, test commands/results, and the admin URL/env-var login instructions. Do not merge or deploy without explicit approval.
