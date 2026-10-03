# Tripper City Top 40

A mobile-first daily fictional chart simulation for kids. One real day is one chart week.

This repository is the source for the `/top40` deployment on jdwd40.com.

## Admin access

Open `https://jdwd40.com/top40/admin.html` in production, or
`http://localhost:<TOP40_PORT>/admin.html` locally. Sign in with the values
configured in `TOP40_ADMIN_USER` and `TOP40_ADMIN_PASSWORD`. Credentials are
server environment variables and must not be committed. Login is disabled when
the password is unset.

Admins can edit release metadata, preview or generate the next chart, speed up
the simulation, delete releases or pending submissions, and review the
correction log. Deletion requires a reason, removes the release from live
charts and leaderboards, preserves published history, and releases a
replacement on the next generated chart.

## Public leaderboards

The public page includes Genre Top 10s for Hip-Hop, Dance/EDM, Rock, Pop, R&B,
Country, Indie, Soul, Alternative, and Electronic, plus a band leaderboard
ranked by fictional earnings at £0.99 per simulated sale. User submissions
must select a genre and are always treated as super bands.

## Run it

```sh
npm test          # assert-based test suites (temp state files only)
npm run check     # syntax-check every .js file
npm start         # serve on TOP40_PORT (default 3000)
```

Environment (see `.env.example`): `TOP40_DATA_FILE`, `TOP40_PORT`,
`TOP40_ADMIN_USER`, `TOP40_ADMIN_PASSWORD`, `TOP40_SESSION_SECRET`.

## Existing-game catalogue transition (offline, explicit)

Expanding the catalogue does not replace already published charts. To move an
old live game to the realistic catalogue, use the one-off transition below.
It retires known legacy **rival** releases (never deletes them), adds 40 distinct
current-catalogue rivals, and publishes one new simulated day after the latest
snapshot/cursor. Existing user releases stay eligible; pending submissions debut
normally. Old snapshots, release IDs, earned sales and historical rankings
are preserved; still-live user/current releases accrue normal new-chart sales.
Legacy songs remain in history/all-time/band totals intentionally;
the current chart and genre lists use the new snapshot. Future rival generation
never falls back to legacy songs, even if current songs are all in use.

The persisted `catalogueTransition` marker makes retries a no-op. A game with no
live legacy rivals is marked without publishing another chart. Fewer than 40
available current songs causes a preflight error before any state mutation.
The command refuses missing, empty, corrupt or unsupported files and never uses
the default data path implicitly. It must not run beside a live writer: the JSON
store's lock is in-process, not cross-process.

Safe production procedure (not automatic on startup or public requests):

1. Approve/merge the code onto the actual production branch; select that exact
   revision, not the conflicting docs-only PR. Confirm the configured state file
   and service name from the existing deployment; do not guess either.
2. Stop the service/writer. Make a timestamped backup of its configured state
   file, record its hash, and create a separate rehearsal copy. Retain the backup.
3. Check out the new revision without restarting the service. Run tests/checks
   from that checkout and migrate the **rehearsal copy**:

   ```sh
   npm test && npm run check
   node scripts/transition-catalogue.js /absolute/path/to/rehearsal.json
   node scripts/transition-catalogue.js /absolute/path/to/rehearsal.json
   ```

   Check that only legacy rivals changed to `retired: true`, legacy release
   metrics/IDs and all old snapshots are identical, and exactly one new full
   chart was appended with current-catalogue rivals (user entries may also rank).
   Other live releases accrue normal new-chart metrics. Check
   `catalogueTransition` and `lastScheduledDay`; the second invocation must return
   `created: false` with an unchanged file hash. Pending submissions, if any,
   legitimately change to released and receive normal new user releases.
4. With the writer still stopped, run the same command once against the actual
   configured state file. Verify the same preservation invariants, pin the new
   deployment revision, then restart the service. Never reset/delete state or overwrite a
   historical snapshot to make the current chart look new.
5. Read back health, current chart, genres, history, all-time, bands and an old
   release's history. Confirm a full realistic live chart, preserved legacy
   history/totals, no public mojo, and protected admin routes still return 401
   without a session. Verify the next real daily boundary advances one simulated
   day, including after a restart. If rollback is necessary, stop the writer and
   restore **both** the previous code revision and its matched backup before
   restarting; do not roll back code alone after new writes.

Scheduling now persists `lastScheduledDay` (real Europe/London chart day)
separately from `lastGeneratedDay` (simulated chart date). Speed-up changes only
the simulated date after establishing the real cursor. Each missed real day
advances one simulated day; repeated same-day reads do not advance again. Older
future-dated states without a scheduling cursor anchor to the current real day
once, because their previous real-day offset cannot be recovered. The explicit
transition also anchors the real cursor to migration day. The reveal boundary
remains **20:00 Europe/London**; generation still runs on startup or API catch-up,
not a new background timer.
