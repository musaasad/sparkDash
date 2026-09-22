# SPARKDASH DESIGN SYSTEM — LangChain/Mobbin North Star (Kimi spec, v1)

PRIMARY AND ONLY design reference: the LangChain (LangSmith) web app on Mobbin, selected by the owner.
Adopt STRUCTURE, hierarchy, density, interaction grammar — never LangChain's blue hue, branding, logos, or copy.
SparkDash retains its restrained amber accent (#e8a830). Both LIGHT and DARK themes are first-class,
hand-tuned variants of one commercial product — not inversions. `white` and `oled` are delta themes.

Evidence (LangChain/Mobbin):
- https://mobbin.com/screens/6e562f85-bb16-43c5-825f-60e66cf7e565
- https://mobbin.com/screens/b8b2cedb-d284-4b98-add9-f9a43f8ffe07
- https://mobbin.com/screens/a29b8703-23ed-45d9-ab6c-9327bf5df3df
- https://mobbin.com/screens/3fe9126c-5520-4950-a3f9-bbe5d35809e3
- https://mobbin.com/screens/d6fd7ab4-9f5e-4e41-8e39-ceaa7fc9ee72
- https://mobbin.com/screens/5050aa3f-1295-4431-a1fd-2db978c328e8
- https://mobbin.com/screens/4ece4b86-b8be-48ad-9588-85948e3eea39
- https://mobbin.com/screens/05c9fe2b-8d71-4f6d-97e8-c31cb3dc614e

## 1. Semantic tokens (map onto existing --color-* custom properties in src/index.css)

### Dark (default)
| token | value |
|---|---|
| pageBg | #0f0f11 |
| surface | #161619 |
| surfaceElevated | #1d1d21 (popovers/modals/toasts) |
| surfaceSecondary | #1a1a1e (section bands) |
| border | #232327 hairline |
| borderStrong | #333339 (inputs, outline buttons) |
| textPrimary | #f2f2f3 |
| textSecondary | #a2a2aa |
| textMuted | #6b6b73 |
| accent | #e8a830 |
| accentStrong (link/text-accent) | #f0b63f |
| accentText (on accent) | #221a07 |
| success | #3fb96f |
| warning | #e0a838 |
| error | #e5594d |
| neutral/offline | #7a7a82 |
| hover | rgba(255,255,255,0.04) |
| selected | rgba(232,168,48,0.16) |
| focusRing | rgba(232,168,48,0.65) 2px outline, 1px offset |
| tableHeaderBg | #17171b |
| tableRowHover | #1b1b20 |
| codeSurface | #121215 (+1px border) |
| codeText | #d7d7dc |

OLED delta: pageBg #000, surface #0b0b0d, surfaceElevated #131316, surfaceSecondary #0e0e11,
border #1e1e22, borderStrong #2c2c32, tableHeaderBg #0d0d10, tableRowHover #131316, codeSurface #09090b.

### Light
| token | value |
|---|---|
| pageBg | #ffffff |
| surface | #ffffff |
| surfaceElevated | #ffffff + shadow 0 4px 16px rgba(0,0,0,0.12) |
| surfaceSecondary | #f7f7f8 (section bands) |
| border | #e6e6e9 hairline |
| borderStrong | #d3d3d8 |
| textPrimary | #1a1a1e |
| textSecondary | #55555e |
| textMuted | #8d8d95 |
| accent | #e8a830 |
| accentStrong (link/text-accent on white, 4.6:1) | #9c6d10 |
| accentText | #221a07 |
| success | #2d9d78 |
| warning | #b45309 |
| error | #dc2626 |
| neutral/offline | #9a9aa2 |
| hover | rgba(0,0,0,0.04) |
| selected | rgba(232,168,48,0.15) (solid ≈ #fbeecb) |
| focusRing | #b97c0e |
| tableHeaderBg | #f6f6f7 |
| tableRowHover | #f7f7f8 |
| codeSurface | #f5f5f6 (+1px border) |
| codeText | #43434b |

WHITE delta (grey canvas): pageBg #f4f4f5, surface #fff, surfaceSecondary #f0f0f2, border #e3e3e7,
tableHeaderBg #f2f2f4, tableRowHover #f4f4f5, codeSurface #f1f1f3.

Theme parity rule: identical alphas, radii, spacing, typography across all four themes — only
surface/border/text tokens shift. Light is hand-tuned, never a mechanical inversion.

## 2. Shell
- Sidebar: 230px fixed rail; header = wordmark + workspace chevron + collapse icon; 11px uppercase muted group label; Search row with right-aligned ⌘K keycap.
- Nav groups separated by 1px hairlines, no group titles: Overview | Models (·Recipes·Deployments·Runtimes as detail pages, not nav rows) | Fleet | Activity · Benchmarks; Settings pinned above footer, outside scroll area.
- Nav row: 32px tall, 12px side padding, 6px radius, 16px icon + 13px/500 label; active = full-width amber `selected` tint, label 600, icon accent; counts right-aligned 12px textMuted numerals — never pills.
- Footer: Settings row pinned above workspace card — 24px avatar, 13px/600 workspace name, 11px muted operator ID truncated; collapse toggle in rail header only.
- Breadcrumb: 12px, Lab / Section / Entity, '/' separators, textSecondary links, last segment textPrimary; sits ABOVE the H1, never replaces it.
- Page header: 20px/600 H1 + 13px textSecondary one-line subtitle; right cluster ≤3 actions — icon ghost, outline secondary, one solid accent primary; extras into overflow menu.
- Detail header: H1 entity name, mono ID chip + copy beneath, 36px underline tab strip; filters on a second 40px bar with Reset + Save View right-aligned.
- Dashboard sections: full-bleed 36px surfaceSecondary band (16px icon + 13px/600 title, right-aligned local filter e.g. "Last 7 Days") above hairline table; each section filters independently.
- Settings shell: back-link + 200px grouped sub-nav, 30px rows; content column max 720px.
- Content: fluid width, 24px page padding, 24px section gaps; tables bleed to content edges; flat surfaces only — no gradients, glass, glow.

## 3. Typography
- Inter for UI; JetBrains Mono ONLY for IDs, keys, metrics, code — never prose; tabular-nums on every metric column.
- Scale: 11px overline (600 uppercase 0.08em textMuted); 12px breadcrumb/table-header/helper; 13px body/nav/buttons/cells; 20px/600 H1; 36px/600 display (Overview home only).
- Weights: 400 body, 500 nav/labels/table-headers/buttons, 600 H1/active-nav/section-titles; 700 only for large display numerals.
- Line-heights 1.45 body / 1.25 headings; table cells single-line ellipsis; long IDs middle-truncated with copy affordance.
- Metric chips: 12px mono, codeSurface bg, 4px radius, 2px/6px padding, codeText; units lowercase muted ("184 tok").
- Links accentStrong 500, underline on hover only; in-table links textPrimary hover-underline.
- Table headers 12px/500 textMuted sentence case; sort caret 12px on hover, persists on active sort column.
- Time grammar: relative in lists ("2m ago"), absolute in detail headers, absolute mono w/ ms in logs — never mixed within one surface.

## 4. Density
- 4px base: gaps 4/8/12/16/24; card padding 16px; page padding 24px; toolbar→table 12px.
- Radii: 4px mono chips, 6px inputs/buttons/nav tint, 8px cards/modals/table containers, 999px status dots only.
- Heights: controls 32px, icon buttons 28px, nav rows 32px, section bands 36px, tab strips 36px, toolbars 40px.
- Table rows 36px (32px dense via toolbar toggle); header 32px; cell padding 6px 12px; 1px row separators; no zebra, no vertical borders.
- Modals 440px max, 16px padding; popovers surfaceElevated + 1px border; light adds shadow, dark uses border only.
- Icons 16px nav/toolbar, 14px inline/status, 20px template cards, 12px carets; SVG only, no emoji.
- Checkbox column 32px; text left; numerics right-aligned mono; actions right, 28px ghost icon buttons.

## 5. Components
- Buttons: primary = accent bg + accentText, 32px, 6px radius, 13px/500, hover darkens 8%; secondary = 1px borderStrong transparent; ghost icon-only 28px. ONE primary per view.
- Tables: hairline rows; sortable headers; status = dot+word pill (never color alone); metrics as mono chips; 0% error = success-green text chip; over-SLO latency = error-red text; linked entities as icon+label chips.
- Status pills: 8px dot + 12px/500 word on surfaceElevated chip + 1px border — Running=success, Deploying/Loading=accent, Stopping/Warning=warning, Failed=error, Offline/Retired=neutral; transitional states pulse the dot only.
- Tabs: text-only underline strip, 36px, 16px gaps; active textPrimary 600 + 2px accent underline; inactive textSecondary 500; counts as plain superscript numerals; no pills/boxes/icons on tabs.
- Toolbar Row1: entity tabs left; ghost utilities + one accent "+ New" right. Row2: saved views, time filter, scope toggles, inline search, "+ Add filter" with count, density icons, Columns — exact order.
- Columns popover: right-anchored, "Search columns" input, "Show all columns" reset, checkbox rows in schema order; persists per view; never a modal.
- Forms: label 13px/500 above control; helper/consequence 12px textMuted below; selects with leading icons; toggles right-aligned; sliders show live value; validation deferred to Save then inline under field.
- Settings cards: surface bg, 1px border, 16px padding; labeled inputs with suffix hints, radio-cards, tooltips; API keys masked prefix…suffix + copy; every mutation confirmed by bottom-right toast.
- Detail layout: left rail 240px (environment chips, history with relative times); main = back-chevron + mono ID header, tab strip, collapsible sections, key-value lists (12px muted label / 13px value).
- Modals: centered 440px — title, one consequence sentence, optional from→to state diagram, accent-tint info banner for propagation; footer ghost Cancel + solid verb-named primary; destructive = error-bg button.

## 6. States
- Empty table: single hairline rounded box, one muted sentence; headers + pager stay visible; no illustration/CTA inside table.
- Empty page: centered 32px muted icon, "No X found" 14px/600, one-line explanation, single accent "+ New X" + optional "Learn more"; CTA mirrored top-right.
- Loading: skeleton rows matching exact table geometry (36px shimmer on surfaceSecondary); full-page spinner only at app boot.
- Waiting/polling: persistent accent-tint banner ("Waiting for node heartbeat…") + elapsed timer; after 120s append troubleshooting link — never poll silently forever.
- Error: inline error-tint banner above content (14px icon, message, ghost Retry); shell/nav/other sections stay interactive; red reserved for this.
- Offline node: neutral dot + "Offline", row dimmed 60%, actions disabled with tooltip reason; stale telemetry never recolors the pill.
- Mutation success: bottom-right toast (surfaceElevated, 8px radius, 13px) + affected row flashes `selected` 600ms.
- Post-create: land on list with new row visible + enabled, plus horizontal "add another" strip — no toast-only dead end.
- No-data metrics: mono "—" in textMuted; never blank cells or fabricated zeros.
- Dirty config: navigating away with unsaved changes opens Save/Discard/Cancel confirm — required guard.

## 7. Workflows (guided, progressive disclosure)
- Getting-started: 11px overline "LET'S GET STARTED" + 36px display heading + fraction counter (2/4, square checkboxes); horizontal 280px cards (title, one-liner, corner arrow); completed flips to success-tint + checkmark + past-tense copy; overflow fade + scroll.
- Template picker before blank form: creation opens picker — left 2-col grid of template cards (20px icon, 13px/600 name, one-line description), right rail "Create from scratch"; "Show all templates →".
- Create dialog: 400px single purpose — title, one explainer, labeled field with example placeholder ("ex: llama-3-8b-int4"), consequence note beneath, ghost Cancel + solid "Create X", X top-right.
- Config page: breadcrumb + Cancel/Save top-right (sticky); left 220px template list; center stacked fields with 13px/600 section headers + inline hint bars; right 280px execution rail (Enabled toggle, sliders with live %, collapsible sample JSON + Test button).
- Progressive disclosure: "Show all →" links, collapsible code/JSON blocks, tabbed snippets with copy; never an "Advanced" toggle wall of dozens of fields.
- Connect-node guided page: persistent status banner, integration chip-picker grid, stacked sections with tabbed install commands, in-context "Generate Join Token" primary.
- Deploy wizard: visible stepper (Model → Recipe → Nodes → Review) — 24px numbered circles, 13px labels, hairline connectors, current = accent, completed = success check.
- Confirmation flow: from→to diagram, accent info banner explaining propagation, primary button repeating the verb.
- Save/apply: sticky top-right Cancel/Save; successful save lands on updated detail view, not a dead-end toast.

## 8. SparkDash per-surface adaptation
- Tokens: implement in src/index.css as custom properties mapped onto existing --color-* set (pageBg→--color-base, surfaceElevated→new, selected≈--color-accent-soft; codeSurface/accentText new); white/oled are deltas on light/dark only.
- Overview: display "Welcome" + getting-started checklist (first Model → Recipe → Deployment → Node) when lab is fresh; then Models/Fleet/Activity sections, each with surfaceSecondary band, local time filter, own dense table. Operational cockpit — never a configuration page.
- Models: registry table — name, mono version chip, params/size mono, status pill, counts as muted numerals, relative updated; Columns popover default subset Name/Version/Size/Status/Updated. Model detail: Overview | Recipes | Deployments | Benchmarks tabs; recipe cards show lifecycle badge (Draft/Validated/Proven/Deprecated/Archived) + [Deploy] [Duplicate] [Edit] [...].
- Fleet: Compute Nodes table — name, GPU mono chips (VRAM used/total, util%), tok/s mono, temp error-red over 85°C, Offline = neutral dot + dimmed row; empty state routes into Connect-node guided page.
- Activity: runs-style table — success check icon, deployment name, tok/s + cost mono chips, latency error-red over SLO, relative timestamps; toolbar ordering per spec; per-section time filter only.
- Benchmarks: A/B side-by-side comparison columns; deltas signed mono in success/error; suite creation via template-picker.
- Settings: grouped sub-nav (General/Access/Integrations/Runtimes/Limits); API-key rows masked prefix…suffix + copy; inline-create popovers with full-width Save; radio-cards; mutation toasts bottom-right.
- Deployment/runtime detail: left rail environment chips + history; tabs Overview/Config/Logs/Metrics; logs absolute mono-ms timestamps; start/stop/remove/promote all route through from→to confirm modal (dry-run phase: modals state simulated effect).

## 9. Anti-patterns (hard rules)
- Never copy LangChain blue, branding, logos, proprietary copy — structure only; every tint role maps to amber tokens.
- No zebra rows, heavy cell borders, boxed metric cells — hairlines + plain/mono text.
- No filled-pill count badges or left-border active indicators — muted right-aligned numerals; full-width amber-tint active row only.
- No illustrated empty states with CTAs inside tables — one muted bordered sentence, pager intact; CTAs live in toolbar/header.
- No pill/boxed tabs or icon badges on tabs — text-only, weight shift, 2px accent underline.
- No competing colored buttons — one accent primary per header; destructive buttons only inside confirm modals.
- No breadcrumb-as-title, no missing H1, no global filter replacing per-section local filters, max 3 header actions before overflow.
- No indefinite silent polling, no unsaved-changes dead ends — banner + timeout escape; dirty-state guard on config pages.
- No gradients, glow, glass blur, emoji, oversized heroes, AI-template aesthetics (locked design bar).
- Never encode status by color alone — dot+word pill; red = terminal failure only, amber = transitional/warning, grey = retired/offline.