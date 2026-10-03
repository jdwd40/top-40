# Tripper City Top 40

A dependency-free, real-time **hourly** fictional chart simulation. Chart keys are
UTC ISO timestamps (`2026-10-03T16:00:00.000Z`), not accelerated calendar dates.
The UI shows London date/time with `HH:mm` and BST/GMT; history groups each
London date, including the repeated autumn hour.

This repository is the source for the `/top40` deployment on jdwd40.com.

## Timing and arrivals

- A fresh game starts at the **actual current UTC hour** with **four** rival songs,
  never a seeded 40. Four rivals arrive each subsequent elapsed hour until a
  published chart first reaches 40 entries; thereafter one arrives per hour.
  Deleting a release does not restart the launch phase. Catalogue exhaustion
  skips an arrival rather than selecting archived songs.
- The server ticks once a second independently of HTTP traffic, checks the real
  clock and runs missed-hour catch-up under the existing Store write lock. Boot,
  timer, reads and admin catch-up share the same idempotent generation path.
  A clock rollback cannot repeat sales; missed UTC buckets replay in order.
- Published snapshots are immutable. Sales, movement and time on chart are
  **hourly**; `hoursOnChart` counts actual chart appearances, not age across gaps.
  Super bands retain the stronger, longer-lived sales curve. User submissions
  require a canonical genre, use super-band mojo, and debut at the **next real
  hour**, never an earlier hour replayed during catch-up.
- No future-date speed-up: the admin control is disabled and the authenticated
  `/api/admin/speedup` endpoint returns **409** without writes. Admin Generate
  catches up elapsed hours only. Preview catches up a clone and scores the next
  real hour; it cannot publish, consume real submissions or count real sales.

The static catalogue contains **2,640 unique song IDs**, including 100 archived
legacy rows excluded from future generation, and 2,540 current songs across
**308 current fictional bands**. Song IDs support more than three digits.

## Admin access

Open `https://jdwd40.com/top40/admin.html` in production, or
`http://localhost:<TOP40_PORT>/admin.html` locally. Sign in with the values
configured in `TOP40_ADMIN_USER` and `TOP40_ADMIN_PASSWORD`. Credentials are
server environment variables and must not be committed. Login is disabled when
the password is unset.

Admins can edit release metadata/mojo, preview the next real hour, catch up
elapsed hours, delete releases or pending submissions, and review the correction
log. Every correction/deletion requires a reason. Deletion removes a release
from live charts and leaderboards but leaves published history intact; normal
hourly arrivals continue on the next chart.

## Public leaderboards

Genre Top 10s cover Hip-Hop, Dance/EDM, Rock, Pop, R&B, Country, Indie, Soul,
Alternative and Electronic. Band earnings use £0.99 per simulated sale. Public
current/history, release histories, all-time and leaderboards never expose mojo.

## Run it

```sh
npm test          # native Node tests, isolated temporary game files only
npm run check     # syntax-check every .js file
npm start         # TOP40_PORT, default 3000
```

Environment (see `.env.example`): `TOP40_DATA_FILE`, `TOP40_PORT`,
`TOP40_ADMIN_USER`, `TOP40_ADMIN_PASSWORD`, `TOP40_SESSION_SECRET`.

## Explicit offline hourly reset (v1 → fresh v2)

**This is a deliberately incompatible new game, not a read-side migration.**
Startup refuses v1, empty, corrupt or malformed state without rewriting it. A
missing state file can initialize a genuinely new game. Never delete a live
state file to bypass the version check. `transition-catalogue.js` is retired and
fails without writes: its future simulated dates/full-40 seed are not valid here.

The authorized reset covers **this application's configured JSON state only**:
releases, snapshots, submissions, corrections and derived leaderboards. It does
not clear other databases, services, the source catalogue or recovery backups.
The old game's history survives in the private backup, not in the new active
leaderboards/history.

1. Confirm the exact app service, configured `TOP40_DATA_FILE`, old code revision
   and new tested revision. Stop the **sole** writer; do not guess the service or
   path. Keep all backup/rehearsal files outside public serving paths. The Store
   lock is process-local; `--service-stopped` is an operator acknowledgement,
   not a cross-process lock. Do not run multiple writers for one game file.
2. Capture the stopped file's SHA256, keep an independent recovery copy, and
   rehearse on a separate copy using the new checkout. Use a **new** backup path
   for every different target/reset. Example placeholders (replace with the
   confirmed paths; these commands are not automatic deployment actions):

   ```sh
   STATE=/absolute/path/to/configured/top40-state.json
   REHEARSAL=/absolute/private/rehearsal/top40-state.json
   REHEARSAL_BACKUP=/absolute/private/backups/rehearsal-before-hourly.json
   BACKUP=/absolute/private/backups/top40-before-hourly.json
   SHA=$(sha256sum -- "$STATE" | cut -d ' ' -f 1)
   cp -- "$STATE" "$REHEARSAL"
   npm test && npm run check && git diff --check
   node scripts/reset-hourly.js "$REHEARSAL" "$REHEARSAL_BACKUP" "$SHA" --service-stopped
   node scripts/reset-hourly.js "$REHEARSAL" "$REHEARSAL_BACKUP" "$SHA" --service-stopped
   ```

   Verify the backup hash equals `SHA`, first result is `created: true`, retry is
   `created: false` with unchanged state bytes, v2 has one current-hour snapshot
   with four distinct current songs and no old submissions/corrections/history.
3. With the real writer **still stopped**, use the same exact original hash:

   ```sh
   node scripts/reset-hourly.js "$STATE" "$BACKUP" "$SHA" --service-stopped
   sha256sum -- "$BACKUP"
   ```

   The script exclusively creates a mode-0600 backup, verifies its exact bytes,
   rejects a changed source hash, atomically writes v2, and reads it back. It
   refuses implicit/relative targets, source symlinks, public backup paths,
   unsupported/malformed state, mismatched hashes and existing backup files.
   A retry with the original arguments/hash verifies the retained backup and
   returns a byte-preserving no-op, even after normal hourly advancement.
4. Pin/restart the exact new app revision. Verify `/health`, `/api/state`, current,
   genres, history, all-time, bands, release history and unauthenticated admin
   rejection. Confirm UTC timestamps use today's **actual** date/hour, four
   initial songs, empty old game totals, London time labels, next-hour submission
   confirmation, no public mojo, and no speed-up publication. Leave it running
   without requests through a real hourly boundary, then restart and verify
   exactly-once advancement and preserved new snapshots.
5. If rollback is needed, stop the writer and restore **both** the previous code
   revision and its matching private backup before restarting. Never roll back
   code alone after v2 writes, and never overwrite the retained backup.

Local test/review evidence and the visual-verification limitation are recorded
in `docs/hourly-readiness.md`. No production reset/deploy is performed by tests.
