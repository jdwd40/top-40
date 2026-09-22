# Top 40 — project state

## What exists (chunk 1: core, ~20% of the full build)

A dependency-light Node.js (CommonJS, standard library only) application:

- **Catalogue**: `ridiculous-top-40-song-catalogue.md` is parsed at runtime.
  The 100 `SONG-xxx` entries are the single source of truth; nothing is
  duplicated by hand.
- **Chart days**: Europe/London local dates with a documented daily boundary
  at **20:00 Europe/London**. Each chart day is the window
  `[20:00 London day D, 20:00 London day D+1)`, so visitors can browse chart D
  before the next reveal. GMT/BST and both DST transitions are handled through
  `Intl.DateTimeFormat`, with hand-verified boundary tests.
- **Simulation**: fully deterministic from a persisted game seed plus a
  hidden per-release `mojo` block (potential, debut, climb, plateau, decline,
  variation, variant curve, weekly noise). Variant curves: spike, steady,
  short hit, burner, long decline. User submissions sample a stronger
  potential band, giving a real but unguaranteed shot at the Top 10 / No. 1.
- **Persistence**: JSON state file with atomic temp-file rename + fsync and an
  in-process async write lock. `TOP40_DATA_FILE` overrides the location
  (tests and deployment).
- **Generation**: one idempotent function per chart day plus missed-day
  catch-up in order. Repeated or concurrent calls never duplicate sales or
  snapshots; already-published snapshots are never regenerated.
- **HTTP API**: health, public state/current chart/history/all-time, release
  submission (validated, length-limited, in-memory rate limit), and admin
  endpoints behind a signed HttpOnly SameSite=Lax session cookie. Hidden mojo
  is never exposed publicly.
- **Tests**: assert-based `node:test` suites for date boundaries (GMT/BST/DST),
  catalogue parsing, simulation determinism, hidden mojo, ranking tie-breaks,
  exactly-once/repeated/concurrent generation, catch-up, restart persistence,
  submission validation, rate limiting, and the admin session boundary.

Still to come (chunks 3–4): deployment config under `/top40`, browser QA
and polish.

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
- **Tests**: 32 assert-based suites covering date boundaries, simulation,
  exactly-once generation, public payload shape, submission confirmation,
  route assets, the admin session boundary, CRUD validation, correction
  logging, preview purity, and snapshot immutability.

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
