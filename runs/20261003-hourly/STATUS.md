# Hourly Top 40 — deployed

- Public URL: `https://jdwd40.com/top40/`.
- Runtime SHA: `14b14cb3f6fed41da7c9c6eff0b30b9e6a91b697` (PR #6 merged).
- Service: `deploy@top-40.service`, active, existing port 4210.
- Reset real hour: `2026-10-03T17:00:00.000Z` (18:00 BST).
- Next boundary observed: `2026-10-03T18:00:00.000Z` (19:00 BST).
- Local and production: 70 tests passed, 0 failures/skips; 23 files syntax OK.
- Current/history/all-time/band APIs: four new entries, one snapshot, four band rows.
- Genre API: ten groups; no public mojo leak.
- Catalogue: 2640 songs, 2540 current songs, 308 current bands; archived songs excluded.
- Public HTML/CSS/JS/admin assets and root site: HTTP 200.
- Unauthenticated admin: 401; authenticated login/state/logout: 200; revoked cookie: 401.
- Preview leaves persisted hash unchanged; speed-up returns 409 without mutation.
- Sole writer stopped for reset; rehearsal succeeded; retry was a no-op.
- Exact previous-game backup: `/home/jd/autobuild-deploy/backups/top-40/hourly-20261003/daily-state-backup.json` (mode 600).
- Backup SHA-256: `0c09030d2e7a91c59de3e199be0bccace128c6e2c3ea077d597d64f2251d9b56`.
- Only this application's JSON data reset. Authentication, unrelated apps/databases untouched.
- Old documentation PR #4 closed as superseded; current release evidence replaces daily status.

## Verification limitations

Full browser capture failed: headless Chrome exited on timeout; no fabricated screenshots.
Actual public/admin client rendering is covered by Node VM tests including London time/DST.
The first future live boundary has not yet occurred at recording time; timer/no-traffic
advancement, fill transition, restart/concurrency and missed hours passed automated tests.
No speed-up was used to invent a future chart for verification.

## Rollback

Stop the writer, restore the private daily backup to its configured state file, check out
`34a4b9a8dca6362a114b25ef2f8430f06fde7a2a`, restore that deploy pin and restart.
Always pair old code with old state: hourly v2 deliberately rejects v1 at startup.
