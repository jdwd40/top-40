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
