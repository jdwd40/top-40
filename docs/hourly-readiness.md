# Hourly simulation — local readiness

Base: production `34a4b9a8dca6362a114b25ef2f8430f06fde7a2a`.
Worktree: `/home/jd/workspace/top-40-hourly-wt`.
Branch: `hourly/20261003-realtime`. No push, merge, deployment or production reset.

## Files expected to change

- `src/dates.js`, `src/chart.js`, `src/state.js`: UTC hours, four-to-one arrivals,
  explicit v2 contract, immutable snapshots and retryable atomic persistence.
- `server.js`: periodic tick under the Store lock; next-real-hour submissions;
  authenticated speed-up 409 and elapsed-hour-only admin catch-up.
- `public/{app,admin}.js`, `public/{index,admin}.html`, `public/style.css`: London
  dates/HH:mm/BST/GMT, date-grouped history, hourly labels, disabled speed-up.
- Catalogue and parser: preserve archive rows/IDs; enlarge the static generation
  pool, including IDs above 999.
- Reset script, existing converted tests, new hourly/UI tests, package description
  and README: explicit offline reset and local verification.

## Architectural changes

Retain dependency-free Node HTTP + atomic JSON Store and its existing
single-process lock. Hours replace lifecycle ticks; there is no alternate
simulated-date cursor. A persisted `chartFilled` flag keeps the one-per-hour phase
stable across deletions/restarts. Preview catches up only a structured clone.
Failed Store writes restore the prior in-memory state so a timer can retry an
hour without lost/doubled sales. v1 never automatically migrates or resets.

The explicit reset script backs up exact prior bytes outside public serving
paths, verifies SHA256, rejects changed state, initializes v2 at the real hour
with four songs, and reads the result back. The old daily transition command is
now a fail-loud pointer to the reset procedure. All old active data/totals are
cleared only by that explicit, acknowledged offline command; its private backup
is retained. Published snapshots remain immutable within each game.

## Verification

- TDD red/green runs covered the schema/version barrier, hourly engine, catalogue
  expansion, timer/admin/submission flows, actual client rendering, stale
  previews, failed-write retries and malformed-state rejection. Existing daily
  suites were converted, not removed; obsolete transition/speed-up assertions
  now exercise the explicit reset and disabled-control contracts.
- `npm test`: **70 passed, 0 failed, 0 skipped**.
- `npm run check`: **23 JavaScript files syntax OK**.
- `git diff --check`: passed.
- Catalogue extraction: **2,640 unique song IDs**, 2,540 current songs,
  **308 current bands**, 100 archived songs; future generation excludes archive.
- Actual `server.js` child-process smoke on isolated temporary files passed at
  **2026-10-03T17:06:34.306Z**: health/current hour
  `2026-10-03T17:00:00.000Z`, four initial entries, five additional public
  endpoints without mojo, protected admin 401, and Indie submission expected
  `2026-10-03T18:00:00.000Z`. Restart plus same-hour public read was byte-preserving.
  Booting the same main entrypoint on v1 exited **1** and left the old file intact.
- Automated tests cover no-traffic periodic advancement, concurrent reads/ticks,
  missed-hour catch-up, restart, clock rollback, both DST changes, four-to-one
  fill, lifecycle retirement, deletion/history preservation, auth/rate limits,
  hidden mojo, genre-aware submissions, long-lived super-band curves, pure
  previews, catalogue exhaustion, private exact-byte backups, hash/target
  guards, reset retries and fail-loud v1/malformed state.
- Native Node VM tests execute the actual public/admin client rendering with a
  minimal DOM/network harness: current/song-history/submission/preview dates,
  London HH:mm/date groups and repeated 01:00 BST versus 01:00 GMT. These are
  rendering logic checks, **not** a full browser/visual acceptance pass.

## Blockers / technical debt

- Browser screenshots remain unverified: the prior attempt reported headless
  Chrome timeout and browser_exec private-URL failure. Per the resumed task's
  instructions, browser setup/screenshots were not retried. Manual visual
  acceptance remains for the parent/deployment operator; no screenshot evidence
  is fabricated.
- Store lock is process-local: stop the sole writer before offline reset; never
  run multiple service instances against the same JSON file. Full state is
  cloned/serialized under this lock; a database is the upgrade path if history
  size or multiple writers becomes material.
- Production is unchanged. The parent must stop/back up/rehearse/reset only this
  game's confirmed configured store, pin/restart the new revision, read back
  real production behavior and check one real traffic-free hourly boundary.
  Detailed reset and paired code/data rollback instructions are in README.

## Resume status

Implementation complete locally, tests/checks and main-process smoke verified.
The task requests a local branch commit only; no independent delegation/review or
production action was performed. Inline review checked all changed engine/API/UI
contracts and archive exclusion. Commit SHA is reported by the final git command
rather than written into this file before it exists.
