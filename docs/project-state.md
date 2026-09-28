# Top 40 — project state

## What exists (chunk 1: core, ~20% of the full build)

A dependency-light Node.js (CommonJS, standard library only) application:

- **Catalogue**: `ridiculous-top-40-song-catalogue.md` is parsed at runtime.
  The preserved legacy entries remain alongside an expanded catalogue of 400
  realistic fictional songs with stable band, genre, and super-band metadata.
- **Chart days**: Europe/London local dates with a documented daily boundary
  at **20:00 Europe/London**. Each chart day is the window
  `[20:00 London day D, 20:00 London day D+1)`, so visitors can browse chart D
  before the next reveal. GMT/BST and both DST transitions are handled through
  `Intl.DateTimeFormat`, with hand-verified boundary tests.
- **Simulation**: fully deterministic from a persisted game seed plus a
  hidden per-release `mojo` block (potential, debut, climb, plateau, decline,
  variation, variant curve, weekly noise). Super bands receive stronger,
  longer-lasting curves while ordinary bands have more variable runs. User
  submissions are always marked as super bands and still use deterministic
  chart competition.
- **Persistence**: JSON state file with atomic temp-file rename + fsync and an
  in-process async write lock. `TOP40_DATA_FILE` overrides the location
  (tests and deployment).
- **Generation**: one idempotent function per chart day plus missed-day
  catch-up in order. Repeated or concurrent calls never duplicate sales or
  snapshots; already-published snapshots are never regenerated.
- **HTTP API**: health, public state/current chart/history/all-time, public band
  earnings (`/api/chart/bands`), canonical genre top tens
  (`/api/chart/genres`), genre-aware release submission (validated,
  length-limited, in-memory rate limit), and admin endpoints behind a signed
  HttpOnly SameSite=Lax session cookie. Hidden mojo is never exposed publicly.
- **Tests**: assert-based `node:test` suites for date boundaries (GMT/BST/DST),
  catalogue parsing, simulation determinism, hidden mojo, ranking tie-breaks,
  exactly-once/repeated/concurrent generation, catch-up, restart persistence,
  submission validation, rate limiting, and the admin session boundary.

The app is deployed under the isolated `/top40` path; see the deployment
record below.

## What exists (chunk 2: public + admin experience, ~60% of the full build)

- **Public UI** (`public/index.html` + `style.css` + `app.js`, no CDN):
  mobile-first chart-night design, live Europe/London countdown to the next
  20:00 boundary, clear chart date, and the full Top 40 table — position,
  NEW / RE-ENTRY badges, movement arrows, artist, title, weekly + cumulative
  sales, weeks on chart, peak. A lively 40→1 reveal plays once per chart day
  per browser (localStorage marker, Skip button, `prefers-reduced-motion`
  bypass). Tabbed views browse dated historical snapshots, per-song chart
  history (`/api/release/:id/history`), and all-time bestsellers. The
  submission form validates length, and the 201 confirmation carries the
  expected debut chart date. Fetch failures show retryable offline panels;
  a polite live region announces changes. No mojo or admin data is exposed.
- **Snapshot entries** now persist `cumulativeSales` and `reentry`, computed
  at publish time, so history stays self-contained.
- **Admin UI** (`public/admin.html` + `admin.js`) behind the existing signed
  HttpOnly SameSite session: releases list with full mojo, inline editors for
  title/artist/mojo (every change needs a reason and appends to the
  correction log with before/after values), release deletion (frees rival
  catalogue ids), pending-submission deletion, correction log, a pure
  next-chart preview (`POST /api/admin/preview` — structured-clones state,
  counts no sales, consumes no submissions, cannot publish), and the explicit
  generate action.
- **Immutability**: admin edits never rewrite published snapshots; the
  published chart for a day keeps the titles/sales it was born with, and
  cumulative published totals are never recomputed.
- **Tests**: 34 assert-based suites covering date boundaries, simulation,
  exactly-once generation, public payload shape, submission confirmation,
  route assets, the admin session boundary, CRUD validation, correction
  logging, preview purity (including the stale-generator regression), snapshot
  immutability, and weeks-on-chart appearance counting.

## Review round (loop 2, ~78% of the full build)

Independent review (Grok 4.6) FAILed the chunk-2 candidate on one MAJOR:
`POST /api/admin/preview` ran live catch-up, so a stale generator could
publish charts, consume submissions, and add lifetime sales as a side effect
of a preview. Fixed and re-verified:

- Preview handler is now a pure read: no `ensureFresh`, no `store.update`;
  the state file on disk is not rewritten. Regression test starts from a
  stale `lastGeneratedDay` plus a pending submission and asserts snapshots,
  submission status/releaseId, lifetime totals, and the state file are all
  unchanged.
- User submission potential band now overlaps rivals (`0.25–0.95`) and
  `short hit` is back in the user variants: 80-seed probe Top 10 = 75/80
  (was 80/80), No. 1 = 27/80 — a meaningful chance, not a guarantee.
- Current-chart mount is a `<div>` (no nested `<ol>` inside `<ol>`).
- Countdown reloads `/api/state` + `/api/chart/current` once at the boundary.
- `/api/chart/history` and `/api/chart/all-time` catch up missed days on
  read, so API-only clients never see an empty history.
- Malformed cookie percent escapes log out (401) instead of 500; admin
  login is rate limited (10/IP/hour) like submissions.
- Static path check requires a path separator after `public/`; session
  cookies gain `Secure` when the request is (forwarded) HTTPS.
- Re-entry badge violet darkened to `#8e44ad` (5.8:1, WCAG AA); empty
  required inputs use `:user-invalid` so forms are not red on first load.
- `weeksOnChart` counts chart appearances, not calendar age after a gap.
- **All strings** stay escaped (text-safe rendering), hidden mojo stays private,
  published snapshots stay immutable.

The implementation and review-fix loop are complete; deployment and browser
smoke verification are recorded below.

## What exists (chunk 3: Tripper City Top 40 speed-up + launch seeding)

- **Branding**: visible public/admin titles and copy read "Tripper City Top
  40". Paths, APIs, and the `/top40/` deployment location are unchanged.
- **Launch seeding**: a fresh game publishes its first chart with exactly 40
  catalogue rival releases holding distinct stable song ids. Launch entries
  pre-fill `lastWeekRank` with their debut rank, so the first chart shows no
  NEW badges; movement the following week compares against the launch rank.
  Existing persisted games are untouched — seeding only runs when the first
  chart day is generated for a snapshot-less state.
- **One rival per week**: every generated chart day after the launch adds
  exactly one rival catalogue release (pending user submissions still debut as
  before), so a strong newcomer displaces a weakening incumbent through the
  existing retire lifecycle (off-chart + negligible weekly sales retires a
  release and recycles its catalogue song id). Snapshots and cumulative totals
  stay immutable and exactly-once.
- **Admin Speed up**: `POST /api/admin/speedup` (session-bound, store-lock
  serialized) advances exactly one simulated chart week per call through the
  same idempotent `generateForDay` path — never a catch-up cascade, never the
  Europe/London wall clock. It persists the snapshot and returns
  `{ ok, created, day, entries, added, released, departed }`. Repeated calls
  step one day at a time and restart retains the result. The admin
  next-chart preview tab carries a **Speed up** button with live summary
  feedback; preview stays pure and real-time catch-up stays exactly-once.
- **Tests**: 43 suites, including fresh 40-entry launch (no NEW badges, stable
  distinct song ids), one-rival-per-week with displacement/retirement/recycling,
  speed-up auth/persistence/repeated calls/no-cascade/wall-clock invariance,
  user-submission release counting, and branding payloads.

Deployment and live smoke verification are complete.

## Current leaderboards and catalogue feature

- The expanded catalogue contains 400 unique songs while preserving the
  original legacy songs. Each row has a canonical genre, normalized band id,
  and super-band flag; super bands chart with stronger and longer curves.
- Public APIs `/api/chart/bands` and `/api/chart/genres` expose the band
  earnings leaderboard and a Top 10 for each of the ten canonical genres.
  Earnings are fictional at £0.99 per simulated sale.
- Public tabs render Genre Top 10s and the Band leaderboard with escaped values,
  mobile-friendly tables, and retryable offline states.
- User submissions require a canonical genre and are persisted with
  `superBand: true`; legacy persisted submissions default to Pop on release.
- Admin release deletion requires a reason, removes the release from live
  charts and leaderboards, frees its catalogue song id, preserves published
  snapshots, records the correction, and schedules the normal one-rival
  replacement on the next generated chart.
- Admin access is documented in `README.md`; credentials come only from
  `TOP40_ADMIN_USER` and `TOP40_ADMIN_PASSWORD`.

## Deployment (verified 2026-09-28)

- **URL**: `https://jdwd40.com/top40/` (the existing site root was left
  unchanged).
- **Revision**: `44b83b4b871eec9836d6d66ce4a19867e78012fc`.
- **Runtime**: `deploy@top-40.service`, bound to `127.0.0.1:4210`, with the
  JSON state file at `/home/jd/autobuild-deploy/data/top-40/state.json`.
- **Proxy**: nginx owns the isolated `/top40/` location and forwards HTTPS
  headers so secure admin cookies work in production.
- **Checks**: 53/53 tests and 18 syntax checks on the deployed checkout;
  public HTML/CSS/JS, current/genre/band APIs, root-site preservation,
  unauthenticated admin rejection, authenticated admin state, service health,
  and deployed revision were verified after restart.

## Runtime state / reuse policy

- The state file is **runtime data**, not source. It lives in `data/`
  (gitignored) or wherever `TOP40_DATA_FILE` points, is never committed, and
  may be deleted at any time.
- Deleting the state file starts a **new game**: a fresh random seed, a new
  origin day (today's Europe/London chart day), and no snapshots. This is the
  supported "start over" operation.
- Catalogue `song_id`s are reserved while their generated release is live on
  the chart and recycled automatically when releases retire; a new game run
  reuses the full catalogue from scratch.
- The JSON store and the in-process lock assume **one app process** and low
  write volume (documented ceiling). If traffic or multi-process deployment
  ever becomes real, move to SQLite with transactional compare-and-swap; the
  engine (`src/chart.js`) does not care where state lives.

## Admin correction policy

- Admin access uses fixed server-side credentials from
  `TOP40_ADMIN_USER` / `TOP40_ADMIN_PASSWORD` (env only, never committed;
  login is disabled when the password is unset) and a signed HttpOnly
  SameSite session cookie.
- Admins may correct display metadata (typos in titles/artists) and record
  corrections in the `corrections` log with a reason and timestamp.
- **Published chart snapshots are immutable.** Corrections never silently
  rewrite a published chart day; anything that would change history is
  appended to the log instead of overwriting snapshots. A snapshot is only
  ever created once per chart day.
- Session logout revokes the token server-side (in-memory denylist); unset
  `TOP40_SESSION_SECRET` falls back to a random per-boot secret, which simply
  invalidates admin sessions on restart.

## Run it

```sh
npm test          # assert-based test suites (temp state files only)
npm run check     # syntax-check every .js file
npm start         # serve on TOP40_PORT (default 3000)
```

Environment (see `.env.example`): `TOP40_DATA_FILE`, `TOP40_PORT`,
`TOP40_ADMIN_USER`, `TOP40_ADMIN_PASSWORD`, `TOP40_SESSION_SECRET`.
