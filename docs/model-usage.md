# Model usage

Factory run `20260922-203921-0e8393`, project `top-40`, branch
`factory/20260922-203921-0e8393-top40`.

| Stage | Worker | Model | Provider | What it did |
|---|---|---|---|---|
| INTAKE / ISOLATE / PLAN | Factory Manager | gpt-5.6-sol (orchestration only) | openai-codex | Run setup, worktree isolation, approved the four-chunk plan in `runs/20260922-203921-0e8393/plan.md`. |
| BUILD chunk 1 | Engineer | kimi-for-coding | kimi-coding | Implemented the application core: catalogue parsing, Europe/London chart-day utilities, deterministic release simulation, JSON persistence, exactly-once/catch-up generation, HTTP API with session-bound admin endpoints, and the test suite. |
| BUILD chunk 2 | Engineer | kimi-for-coding | kimi-coding | Built the public experience (countdown, full chart table, reveal animation, history/all-time/song-history views, submission flow) and the admin experience (session-bound CRUD, reasoned correction log, pure next-chart preview), extended snapshots with cumulative sales + re-entry flags, and added payload/CRUD/immutability/route-asset tests. |

Per JD's factory v0.4 model discipline: Codex orchestrates only, Kimi codes
only, Grok 4.6 reviews only (INSPECT stage, not yet reached). No worker
self-repointed; no per-session overrides were used.

## Runtime model usage

The application itself performs **no model inference at runtime**. The chart
simulation is fully deterministic (seeded PRNG + persisted per-release
parameters), so there is nothing to meter, cache, or fall back on inside the
app. The only "AI" involvement is the above build-time authoring.

## Chunk 1 token note

Exact token counts are reported by the factory dashboard from run telemetry;
they are intentionally not restated here to avoid inventing precision.
