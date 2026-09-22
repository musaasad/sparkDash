# SparkDash Design Brief — Kimi × Mobbin research pass (2026-09-22)

Produced by: Kimi k3 (UX/product design lead) via Mobbin MCP shipped-product research.
Consumed by: TP2 (lead engineer). Arbitrated by: Qwen captain.
Evidence citations at bottom. Research areas: overview, dense infra tables, deploy detail, alerts, live consoles, forms/onboarding.

## Global rules
1. Typography: 13px base UI, 11px uppercase letter-spaced section labels, 20–24px semibold anchor numerals; mono 12px tabular for IDs/paths/endpoints/reqIds/metric values.
2. Spacing 4px grid: 16px panel padding, 24px between sections, 32–40px table rows; single-viewport operational density.
3. Status pills = dot + word, never color alone; animated pulse only for transient states (Starting/Loading/Stopping).
4. Color grammar: amber = primary actions + primary data series; green = live/healthy; red = real failure only; grey = stopped/retired. No gradients/glow/glass.
5. Empty states in-layout, explicit factual language; one section-level empty banner beats per-tile disclaimers; never a dead pane.
6. Loading = skeletons matching final geometry; no lone spinners; first paint shows toolbar + headers.
7. Time: relative in lists, absolute in detail headers; every metric restates its window; one segmented range control per tab with resolved absolute range.
8. Truncate with title tooltips; never wrap IDs/metrics; primary values full-contrast, secondary muted; absent = em-dash or muted "No X".
9. Destructive/irreversible = blocking dialog naming exact target + plain consequence sentence; toasts only for non-destructive saves.
10. Status vocabulary fixed: Running, Running external, Expected · not detected (warning), Degraded, Stopped. Lifecycle stays Available/Starting/Loading/Running/Stopping/Stopped/Error.

## Surface mandates
### Overview
- Health-verdict block + last-updated + auto-refresh toggle; attention queue with severity icon+word, resource, deep link; empty reads "No issues detected".
- KPI strip = one divided band (nodes healthy, deployments running, requests window, tokens/s, GPU util, errors window); explicit zeros.
- Per-section time-range top-right; every metric restates resolved window.
- Topology: dark field, compact node cards; TP2 = one enclosure spanning spark-1+spark-2; click → tabbed side panel.
- Error digest deduped ×N badges, ≤5 rows, "Open in Activity" deep link, terse copy.

### Models+Deployments
- Row grammar: pill → mono model/recipe → age+provenance → node cluster chips → View logs + kebab; 32–40px rows.
- Counted status tabs replace repeated status column; toolbar search-left / filters-middle / primary-right.
- Error rows expand inline: ~10 log lines mono + one remediation action; dedupe ×N.
- Starting/Loading = step checklist with mm:ss durations; controls ghost secondaries + one primary; Archive dialog states weights remain on disk.
- External runtimes: "Running external" pill, read-only connect panel (copyable endpoint, masked key + show toggle), muted "Launched outside SparkDash — manage via TabbyAPI", Stop/Restart disabled.
- Model catalog rows: glyph + mono path left, right-aligned metadata cluster; family grouping with variant counts.

### Fleet+Node detail
- Columns: identity → status pill → right-aligned tabular metrics (GPU %, VRAM used/total GB, temp °C, power W) → uptime → kebab; absent sensors em-dash.
- Aggregate health rail beside table; clicking a count filters the table.
- Detail header: breadcrumb, name, pill, copyable mono host, freshness; underline tabs Overview | GPUs | Models | Logs | Settings.
- Node Overview: big-number GPU util + VRAM above 2-col equal-height chart grid; amber primary series; one range control.
- Node Models tab uses shared row grammar; TP2 chips both nodes with current highlighted; external process read-only.
- Lifecycle controls only on node detail; SSH-unreachable = amber banner + last-contact timestamp, never blank.

### Activity
- Persistent toolbar: search left, severity facet chips with live counts, source dropdown, time-range chips; filters never in modals.
- Rows: relative ts, gutter bar + text level badge, actor-verb sentence, right-aligned duration chip; dedupe ×N.
- Inline expand: structured fields + copy-able raw JSON; error rows carry remediation deep link preserving reqId.
- Incident chains: fired → acknowledged → silenced → resolved timeline with severity dots + legend.
- Explicit stream state: Following/Paused + last-sync + resume-follow + range boundary markers.
- Severity hue always + icon + word; empty filtered state offers Clear filters / Refresh query.

### Live Console (HIGHEST PRIORITY)
- Persistent query toolbar: field-aware search (reqId:, model:, node:), time-window chips (15m/1h/24h), per-deployment source tabs, explicit Live toggle.
- Stream state: always-visible Following/Paused + last-sync; scroll-up pauses with sticky "Live off — resume follow"; SSH disconnect = amber banner naming node + Reconnect.
- Parsed rows: ISO ts, level gutter bar, copy-on-click mono reqId, right-aligned tabular chips fixed order: prompt/gen tokens, cached %, prefill tok/s, TTFT ms, decode tok/s, MTP accepted/attempted, tool calls, duration; 32px rows.
- Expanded row: Parsed ↔ Raw toggle (structured table vs highlighted raw JSON), property search, per-field copy, copy-full, "View in Activity" preserving reqId.
- Events-per-minute histogram with error overlay as time scrubber; severity facets with live counts; filters instant, never restart tail.
- Copy visible filtered rows; JSONL export of current query; p90+ TTFT/decode outliers tinted amber with threshold legend; empty filtered state never dead.

### Benchmarks
- Run rows: pill → mono name → target deployment chip → relative start → duration → View results + kebab; counted tabs; failed expand inline.
- Results header: breadcrumb, name, pill, target, absolute range; anchor tiles throughput + TTFT as p50/p90 pairs with owned empty states.
- 2x2 chart grid: throughput over time, TTFT distribution, decode tok/s, concurrency sweep; amber primary; crosshair tooltip; one global range.
- Comparison: side-by-side divided columns with signed deltas; green=improvement red=regression only; token composition proportional bars, never pies.
- Launch: dry-run first with parameter summary + duration estimate; Running shows progress steps; Stop ghost secondary; failed runs keep "Partial" results.
- Runs deep-link source deployment/recipe; re-run pre-fills; results persist with absolute timestamps.

### Settings
- Left rail by subsystem (General, Models, GPU/Runtime, Storage, Network, Advanced), Danger Zone last with warning icon; one section per page; no Members/Billing/Usage.
- Setting row: bold label + one helper sentence + control; constraints inline; validation inline adjacent, never toast-only.
- Save section-scoped, disabled until dirty, toast on success; sections whose save restarts a server state that consequence first.
- Mutually exclusive choices = radio cards with Recommended pill + one-line VRAM/speed tradeoff.
- Prerequisite-blocked = inline amber callout naming blocker + deep link; never silently disabled.
- Danger Zone: title + "This is irreversible" + type-the-resource-name enabling red target-named button; archive-style actions state weights kept.

## Evidence (top)
- https://mobbin.com/screens/2b10b36e-e9ce-424a-b603-e85f59bfbd07 (severity chips w/ counts)
- https://mobbin.com/flows/8f340677-1a20-4a77-a1cd-40650175678e (alert wizard + live preview)
- https://mobbin.com/flows/7fd6ae4f-6164-4b6b-8d0d-361f3aee9298 (rule rows, plain-language triggers)
- https://mobbin.com/flows/f56267b8-b1a4-497c-97b3-b2f2d2097d50 (log query toolbar, facets)
- https://mobbin.com/screens/3ca1f3d3-61c7-40f6-a238-57ec41878890 (histogram scrubber + structured rows)
- https://mobbin.com/flows/eb0244b7-db53-45f1-a3e6-90b24b91ba91 (row drawer Raw/Attributes + copy)
- https://mobbin.com/flows/d878641a-1cd8-4dc4-9986-24eb18e487fe (log-to-context jump)
- https://mobbin.com/screens/89c8f8ca-09a4-496a-87e4-5a735367449c (Listening/Stop stream state)
- https://mobbin.com/screens/4291ed3d-a9ea-46e1-92ac-d47c42fcda36 (inline metric chips per row)
- https://mobbin.com/screens/0ab1b8cb-1532-4cdb-82fa-59bbd466ced5 (type-the-name destructive confirm)
- https://mobbin.com/screens/aab240a8-faae-49d4-932e-7fb89be7af2d (settings rail + danger zone)
- https://mobbin.com/screens/72c1c5c4-2b7e-455e-8d8d-eecfe2f79520 (setting rows + inline validation)
