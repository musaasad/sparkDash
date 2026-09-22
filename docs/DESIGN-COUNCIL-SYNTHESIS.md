# SPARKDASH — AI Lab Control Plane: Design Council Synthesis

Date: 2026-09-21 · Captain: Qwen 3.8 (qwen38-local) · Branch: `feature/ai-lab-control-plane`

Inputs (independent, bounded reviews):
- **Kimi k3** (moonshotai) — UX & product design
- **DeepSeek V4 Pro** (deepseek-official) — frontend/product engineering
- **TP2 DeepSeek V4.1** (deepseek-v41-local @ 192.168.1.173:8888, live model id
  `DeepSeek-V4.1-Flash-UNCENSORED-EXL3`, probed via `/v1/models` + minimal chat probe first) — repository/safety audit

## Resolved product direction

### 1. Information architecture — KEEP 6 sections
`Overview | Models | Fleet | Activity | Benchmarks | Settings`.
- **Kimi dissent**: Activity premature as top-level (empty-page risk). **Resolution**: keep the
  route (user requirement), but it must be backed by a real server-side event log
  (lifecycle/audit events, bench completions, showcase sessions, node online/offline
  transitions, alerts). Unknown attribution renders as *unknown*, never invented.
- Overview = health synthesis; Fleet = node inventory + topology + drill-down. Any screen
  listing node cards belongs to Fleet, not Overview (today's OverviewPage is Fleet).
- Node detail pages move under Fleet (`/node/:id`, alias legacy `/spark/:id`). Showcase
  remains a full-screen escape route.
- Primary nav = fixed 6 items reusing the existing `.pill-nav` styling (DeepSeek dissent
  against new nav chrome — accepted). `SparkTabs` survives as the node sub-nav inside Fleet
  (keeps its tests and drag-reorder behavior where it still makes sense).

### 2. Design system
- Keep CSS custom properties as the single token source + thin `@theme` alias layer.
- Add semantic lifecycle status tokens across all four themes:
  `running` (success solid), `starting`/`loading` (accent amber, pulsing — transitional ≠ healthy),
  `stopping` (warning outline), `stopped` (muted hollow), `error` (danger), `unknown` (muted dashed),
  plus `--color-info` distinct from accent.
- Dark-first default via pre-paint `data-theme` script in `index.html` (never flip `:root`).
- De-embellish: remove glass blur, 30px shell radius, dot glow, and 28px per-card hero numbers
  from dark/OLED; flat full-bleed shell; 4-base spacing scale; tabular numerals for metrics.
- Status color only on status cells; numeric cells stay neutral (no neon numbers).

### 3. Routing & state (DeepSeek mandates accepted)
- Single typed `parseRoute()` discriminated union + `navigate(route)`; no react-router.
- WS message union extended: `snapshot | console | lifecycle | activity`; dispatched in
  `onmessage` before React state. Console lines never ride the 1s snapshot.
- `domainStore.ts` mirrors `metricsStore` contract: `recipeMap`, `runtimeMap`,
  `consoleBuffers` (ring, coalesced appendSeq ≤ 50ms), `useRecipe/useRuntime/useConsole`.
- Console rendering capped (~2k lines) + follow/pause/new-logs pill; no virtualizer this phase.

### 4. Server architecture (TP2 map accepted)
New files following existing structure:
- `server/util/shlex.js` — `shlexQuote()`; every interpolated remote value passes through it.
- `server/models/ModelRegistry.js` + `server/recipes/RecipeRegistry.js`
  (`config/models.json`, `config/recipes.json`, atomicWrite, `toPublic` redaction, secrets flagged env).
- `server/deployments/DeploymentService.js` — dry-run state machine (7 states),
  `activeBySpark` lock + `config/deployments-active.json` checkpoint → 409 on duplicate,
  append-only `config/audit.jsonl` `{ts, actor, node, recipe, action, result, dryRun}`.
  **Never** reuses the Hermes remote-mutation pattern; dry-run asserts zero sshExec.
- `server/collectors/LiveConsole.js` — streaming `spawn` of `ssh … tail -n N -F <quoted path>`
  (read-only), ring buffer, loguru parser → telemetry records.
- `server/activity/ActivityLog.js` — aggregation endpoint over audit + bench history +
  showcase history + node transitions.
- Lifecycle mutations require a token **even on loopback** (dev :5556 included).
- Fix existing leak: bench job responses echo the stored LLM API key — redact in serialization.

### 5. Live Console (Kimi spec accepted)
- **Telemetry View**: one row per request — time · req id · prompt tok · gen tok · cached % ·
  new prompt tok · prefill T/s · TTFT · decode T/s · MTP accepted/attempted (tooltip) ·
  tool calls · duration · status. Tabular mono numerals; expandable row detail.
- **Raw Console**: mono 12px/1.5, follow default, pause freezes view not ingestion,
  search (substring/regex, prev/next), level coding via 2px left border + faint bg tint for
  errors only, copy-friendly, `role="log"`.
- Parsed from the real TabbyAPI loguru format verified on dgx-3:
  `#<id> … N tokens generated at X T/s · prompt N tokens, P% cached, N new in S s (X T/s) ·
  first token S s, total S s · draft A/B accepted (P%)` + `parsed N tool call(s)`.

### 6. Registry / onboarding
- Wizard collapses to 3 steps + collapsed Advanced + diff-style Review
  (Model → Runtime & Compute → Review). Server-side validation: port conflict, path grammar,
  topology vs node count, env name grammar, CPU affinity grammar.
- Recipe ids are slugs; recipe→nodes reference SparkRegistry ids (allowlist preserved).
- Archive = preserve config/recipes/bench history + mark archived; never touches weights.
- Qwen 3.8 on dgx-3 is seeded as the first real model+recipe (metadata only).
  Controls render **disabled with an explicit reason** ("externally managed · dry-run phase")
  — showing live controls on a never-touch process is a trust violation.

### 7. Destructive-action tiers
Stop/Restart = secondary + confirm dialog stating impact; Force Kill = danger text button in
overflow only, typed-name confirmation, never adjacent to Stop; Archive = neutral with
"weights are never deleted" copy. Mobile: bottom sheet, 48px targets, destructive last, never swipe.

### 8. Fleet/topology
Topology ships with semantic edges only (shard role + live throughput + degraded dashed-gray);
static deterministic geometry per topology type; grouped list fallback >4 nodes.

### 9. Benchmarks
Preserve existing decode/prefill benches. Record `recipeId`/`modelId` join keys at job start.
Benchmarks section = history table + recipe comparison restricted to comparable workloads
(same prompt type/concurrency), explicitly refusing misleading cross-comparisons.

### 10. Charts & deps
One generalized `TimeSeriesChart` (axes/ticks/tooltip/range) from `LlmTrendChart`.
**No new runtime dependencies** (no react-router, no chart lib, no virtualizer, no UI framework).

## Deferred (documented, not forgotten)
⌘K command palette · true virtualization · restore wizard · generic form builder ·
MTP columns beyond what TabbyAPI emits · recipe benchmark joins beyond recorded history.

## Model labor
- Kimi k3: IA/density/status/console/mobile mandates (biggest dissent: Activity top-level).
- DeepSeek V4 Pro: router/store/primitives/chart/focus-trap engineering mandates; defer list.
- TP2 V4.1 (live-probed): reuse map, injection-surface audit, lifecycle safety gates, commit order.
- Qwen Captain: synthesis above, all integration decisions.