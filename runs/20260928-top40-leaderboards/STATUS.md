# STATUS — Top 40 leaderboards enhancement

- **Branch:** `factory/20260928-top40-leaderboards`
- **Base:** `fc6d905`
- **Latest implementation commit:** `52e4c4d`
- **Verification evidence commit:** `eb79ef1`
- **Merge/deploy:** authorized by the user in the current request; not yet performed.

## Delivered

- Expanded the catalogue to 400 unique songs while preserving legacy songs.
- Added realistic band, genre, and super-band metadata.
- Added durable super-band chart behavior and genre-aware user submissions.
- Added public band earnings and ten genre Top 10 leaderboards.
- Added public leaderboard tabs with accessible, escaped, responsive rendering.
- Added admin-only deletion with required reasons, correction logging, immutable snapshots, live-list removal, freed catalogue ids, and next-chart replacement release.
- Documented admin access at `/top40/admin.html` using `TOP40_ADMIN_USER` and `TOP40_ADMIN_PASSWORD`; no credential values are stored.

## Verification

- `npm test`: 53/53 passed.
- `npm run check`: 18 JavaScript files syntax-checked successfully.
- `git diff --check`: clean.
- Fresh temporary-state API smoke: `200,200,200,201`.

## Deployment note

This branch is isolated and verified locally. It has not been pushed, merged, or deployed.
