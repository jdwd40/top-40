# Tripper City Top 40: catalogue, leaderboards, genres, and deletion

## Intent

Extend the existing dependency-free Top 40 simulator without changing its JSON-file persistence or immutable published snapshots. The app should use a larger, more realistic fictional catalogue, expose genre and band rankings, make user submissions strong super-band releases, and let authenticated admins remove releases safely.

## Scope and constraints

- Keep the existing CommonJS Node.js server, browser UI, and standard-library-only runtime.
- Preserve the existing 100 catalogue songs and all published snapshots.
- Add realistic fictional bands and songs with canonical genres. Existing joke records become legacy catalogue entries and are retained for old data compatibility.
- Admin-only deletion remains behind the existing signed HttpOnly session.
- No real money, payments, audio, or external database is introduced.

## Data model

Catalogue rows gain optional metadata while remaining markdown-backed:

- `song_id`: stable unique ID.
- `artist`: display/band name.
- `genre`: one canonical genre.
- `title`: display title.
- `bandId`: stable fictional band identifier for new records; legacy rows fall back to a normalized artist key.
- `superBand`: whether the band receives durable chart strength.
- `legacy`: true for the preserved original joke catalogue; false for new releases.

Releases persist `bandId`, `genre`, and `superBand` in addition to the existing release fields. User submissions persist their selected genre, use a normalized artist-derived band key, and set `superBand: true`. Existing state files are read compatibly: missing metadata is derived from the release's song/catalogue row or defaults to Pop and false.

Deleted releases are removed from the live release array and their catalogue song ID is freed. Historical snapshot entries are not rewritten. Public live rankings are computed from current releases/snapshots and therefore exclude deleted releases; historical snapshots remain an immutable record of what was published.

## Catalogue and simulation

`src/catalogue.js` continues to parse the markdown source. The parser accepts legacy four-column rows and extended rows. New release selection prefers non-legacy songs and falls back to legacy songs only after the current catalogue is exhausted.

`src/sim.js` adds a super-band mojo profile. Super bands receive high potential, restrained weekly noise, longer retention, and a long-run curve. Their sales are strong but still share deterministic tie-breaking and weekly variation, so they usually lead rather than being hard-coded at rank one. Ordinary releases retain the existing random curve families.

`src/chart.js` carries catalogue metadata onto releases and snapshot entries. It keeps the existing exactly-once generation and one-rival-per-generated-day behavior. Deleting a release frees a catalogue ID; the next generated day adds a replacement through the normal rival-release path. User submissions are released with their strong profile and selected genre.

## Public API

Keep existing endpoints and add:

- `GET /api/chart/genres`: current published chart grouped by canonical genre, each group limited to its top ten entries.
- `GET /api/chart/bands`: all-time band leaderboard, excluding deleted releases, sorted by simulated earnings. Each row includes band, genre summary, release count, lifetime sales, simulated earnings, best peak, total chart weeks, and super-band status.

Existing current chart, history, all-time, and release-history payloads gain safe public `genre`, `bandName`, and `superBand` fields. Hidden mojo remains private.

Simulated earnings use the fixed display rule `lifetimeSales * 0.99`, formatted as pounds in the UI. The value is a ranking/display metric only.

## Admin API and UI

Extend the existing release list with genre, band, super-band status, and deletion controls. The current delete endpoint remains admin-only, reason-required, and correction-logged. Its response also reports that the next generated chart will receive a replacement release.

Admin access documentation will point to:

- production page: `https://jdwd40.com/top40/admin.html`
- local page: `http://localhost:<TOP40_PORT>/admin.html`
- credentials: `TOP40_ADMIN_USER` and `TOP40_ADMIN_PASSWORD` environment variables

No credential is committed or displayed. Unconfigured passwords continue to disable login.

## Public UI

Add two tabs/sections:

- **Genre Top 10s**: a section per genre using the current chart's rank order.
- **Band leaderboard**: band earnings table with release count, simulated earnings, peak, weeks, and a super-band badge.

The submit form adds a required genre select. Existing mobile layout, escaping, accessibility patterns, and retry states are reused.

## Deletion behavior

1. Authenticate the admin session.
2. Validate a 3–300 character reason.
3. Remove the release from live state and free its catalogue ID.
4. Append a `delete-release` correction record.
5. Exclude it from current/all-time/genre/band rankings.
6. Leave existing snapshots untouched.
7. On the next generated chart, the existing rival-release step fills the vacancy with a new song.

If a deleted release is requested by release-history ID, the immutable snapshot fallback may still return its historical appearances; this preserves the repository's published-history contract.

## Testing

Add or update assert-based Node tests for:

- extended catalogue parsing, unique IDs, realistic catalogue size, canonical genres, and retained legacy rows;
- metadata propagation to releases and public snapshots;
- super-band retention/strength and user-submission super-band status;
- genre top-ten grouping and band earnings aggregation;
- deleted releases excluded from live rankings and catalogue IDs freed;
- next-chart replacement after deletion;
- immutable historical snapshots after deletion;
- submission genre validation and public payload shape;
- admin-only access and correction logging;
- public/admin documentation and static route assets.

Run `npm test` and `npm run check` from the isolated worktree before completion.
