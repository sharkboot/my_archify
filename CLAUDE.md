# CLAUDE.md

Guidance for Claude Code when working in this repository. This is the **source repo** of the `archify` skill.

## What this is

Archify is a **zero-dependency Node.js (>=18, ESM) CLI** that turns a small typed JSON intermediate
representation (IR) into a single self-contained HTML file containing an inline SVG diagram. Five
diagram modes share one authoring, validation, and delivery pipeline.

Not a normal app: there is no build step, no `node_modules`, no test runner, and no lint config.
`package.json` declares only `bin/archify` and an override pin for `fast-uri@3.1.5`. Everything runs
directly from source with `node`.

## Command reference

```bash
node bin/archify.mjs render   <type> <in.json> [out.html] [--quality standard|showcase] [--repo-root <path>]
node bin/archify.mjs validate <type> <in.json> [--json] [--layout-json] [--quality ...] [--repo-root <path>]
node bin/archify.mjs deliver  <type> <in.json> [out.html] [--json] [--open] [--quality ...] [--repo-root <path>]
node bin/archify.mjs preview  <type> <in.json> [out.html] [--no-open] [--quality ...] [--repo-root <path>]
node bin/archify.mjs compare  architecture <base.json> <head.json> [out.html] [--receipt <path>] [--json]
node bin/archify.mjs migrate  workflow <old.json> <new.json> --to-schema 2 [--json]
node bin/archify.mjs inspect  <type> <in.json>          # architecture only; = validate --layout-json
node bin/archify.mjs check    <out.html>                # artifact checker only
node bin/archify.mjs visual-check <out.html> [--json]
node bin/archify.mjs guide    [scenario] [--json] [--lang en|zh]
node bin/archify.mjs brands   [name|domain|category] [--json]
node bin/archify.mjs brands capture <url> [--json]
node bin/archify.mjs examples | doctor | demo [dir]
```

`--repo-root` is **architecture-only**; every other mode rejects it (`assertEvidenceType` in `bin/archify.mjs`).
`--layout-json` is architecture and workflow only.

Type router: `architecture` (components/boundaries), `workflow` (processes/gates/CI-CD),
`sequence` (API call chains), `dataflow` (pipelines/ETL/lineage), `lifecycle` (state machines).
When unsure, run `node bin/archify.mjs guide "<scenario>" --json`.

## Layout

| Path | Role |
|---|---|
| `bin/archify.mjs` | CLI entrypoint; command dispatch, atomic deliver/migrate staging, receipt shapes |
| `bin/preview.mjs`, `bin/visual-check.mjs`, `bin/open-artifact.mjs` | Live preview (loopback watch), Chrome DevTools-pipe screenshots/containment, OS opener |
| `renderers/<type>/render-<type>.mjs` | One renderer per mode; validates IR, lays out, emits HTML |
| `renderers/workflow/workflow-compiler.mjs` | v2 "readable" layout compiler (rank solver) |
| `renderers/shared/` | Cross-mode runtime: `validator.mjs` + `generated-validators.mjs` (ajv standalone output, committed), `geometry.mjs`, `brand-marks.mjs`, `legend.mjs`, `output-path.mjs`, `diagnostics.mjs`, `i18n.mjs`, `text-fit.mjs`, `desktop-readability.mjs` |
| `schemas/*.schema.json` | One JSON Schema per mode + `common.schema.json` (`$defs` only). All `additionalProperties: false` |
| `examples/*.json` / `*.html` | Canonical IR examples per mode and their committed golden renders |
| `references/` | Progressive-disclosure contracts — see "Where to read first" |
| `delta/architecture-delta.mjs` | Architecture base↔head comparison runtime (used by `compare`) |
| `migrations/workflow-v2.mjs` | workflow schema v1 → v2 migration |
| `scripts/` | `check-render-output.mjs` (artifact checker), `check-update.mjs`, `render-examples.mjs`, `update-contract.mjs` |
| `assets/template.html` | HTML shell; fallback path for hand-placed SVG when no renderer can run |

## The authoring loop (the part that matters)

The skill's own operating contract lives in `SKILL.md`. Follow it; the essentials:

1. **Artifact first.** Write the candidate JSON before reading renderer internals. Never plan exact
   coordinates in prose. Read only the matching schema, `common.schema.json`, and one matching example.
2. **Start small.** One main path, ≤12 primary nodes, automatic routes and labels. Do **not** pre-add
   `via`, `channelX`, `channelY`, or `labelAt`. Apply at most **one diagnosed geometry control per repair**.
3. **Validate after every edit:**
   ```bash
   node bin/archify.mjs validate <type> <candidate.json> --quality showcase --json
   ```
   A showcase pass must show **all 9 artifact checks, 0 composition errors, 0 warnings**. A receipt with
   only 4 artifact checks is *basic* validation, not acceptance. `--layout-json` gives workflow v2 a
   stable compiler receipt (never solver internals).
4. **Deliver once, on a frozen candidate:**
   ```bash
   node bin/archify.mjs deliver <type> <candidate.json> <out.html> --quality showcase --json
   ```
   Delivery freezes spec bytes into a same-directory private snapshot, renders, checks, then atomically
   renames. Non-zero exit is **never** success. A failed delivery preserves the previous artifact — so do
   **not** run `visual-check` on that path (it would measure stale output).
5. **Then** collect desktop evidence on the trusted HTML:
   ```bash
   node bin/archify.mjs visual-check <out.html> --json
   ```
   Containment at 1440×900, 1600×1000, 1920×1080, 2048×1320 + light/dark screenshots. Exit 0 = pass,
   1 = overflow/capture failure, 2 = Chrome unavailable (`skipped`). Always reports
   `visualReview: "pending"` — screenshots are evidence, never an automatic polish claim.
6. Repair loop: consume diagnostics by stable `code` + exact `subject` + measured `evidence` +
   `supportedFixes`. Keep going while the objective error count reaches a new minimum; if two
   consecutive rounds do not improve the best count, stop and report the unresolved diagnostics truthfully.

Never start `preview` by default. Never edit a candidate after its final passing validation.

## Where to read first

Read `SKILL.md` for the operating contract. Then read **only** what the task needs — this repo is
deliberately progressive-disclosure, and `SKILL.md` explicitly forbids reading renderer/validator
source before a first candidate exists.

| Need | Read |
|---|---|
| Field enums, spacing math, repair order, placement rules | `references/authoring-contract.md` |
| Preview, repository evidence, export receipts, visual review | `references/delivery-contract.md` |
| Share Cards, guided stories, motion, deep links, presentation | `references/viewer-runtime.md` |
| Brand mark IDs, capture rules, provenance | `references/brand-marks.md` |
| Legend contract, schema version policy, engineering profile | `schemas/README.md` |
| Workflow v1/v2 constants, pins, migration, layout receipt | `renderers/workflow/README.md` |
| Dataflow / lifecycle / sequence specifics | the `README.md` beside each renderer |
| Scenario → mode/pattern recommendations | `recipes/scenarios.mjs` (or the `guide` command) |
| Nested drill-down (`detail` IR + viewer descent) | `renderers/shared/detail.mjs`, viewer `Archify.drilldown` module in `assets/template.html` |

## Nested drill-down (`detail` IR)

Archify supports nested drill-down: **single-click** on a node shows its rich detail in the Semantic
Passport panel; **double-click** descends into that node's own sub-diagram, recursing until a node has
no children. At the leaves, a code symbol node shows its complete content (fields, methods, verbatim
implementation bodies). All output stays in one self-contained HTML.

The `components[].detail` field is optional and is either:

- **`kind: "diagram"`** — a nested diagram (`components`/`connectors`, recurses); child nodes may each carry their own `detail`.
- **`kind: "code"`** — a leaf code artifact (title, subtitle, symbol, language, signature, doc, sources, fields, methods, code, notes); terminates descent.

Author `components[].detail` on any top-level or nested component; nodes that carry it emit `data-node-drilldown` and a drill-down badge, and the viewer only offers a dive when a payload exists (code leaves refuse double-click).

### Interaction contract (two viewer registrations, both required)

1. **Pan-exclusion** — `#drilldown-bar` and `#drilldown-detail` are in the container's pan/click guard
   list so dragging inside the detail panel never pans the diagram (template HTML, pan guard at the
   `data-just-panned` click handlers).
2. **Export strip** — the export path clones only the `<svg>` and asserts `canonicalStateClean`;
   any `[data-drilldown-badge]` overlay must be stripped from the clone before export, else export
   silently rejects.

The drill-down module swaps only the *contents* of the existing `<svg>` element (viewBox + innerHTML),
never replacing the element itself, so the camera, reader-width, rail-reserve, and radar modules keep
driving the live node across levels. Breadcrumbs walk back out; `Esc` pops one level.

### Geometry consistency with the main graph

Nested diagrams share the same geometric contract as the main architecture graph:
- Node sizes use `components[].size` when provided; otherwise fall back to the default `120×60`.
- Connection endpoints respect `fromSide`/`toSide` (inferred from component positions when omitted).
- Connection paths use rounded corners (8px radius) and the same routing logic as the main graph.
- The service-side renderer computes routing metadata (`fromSide`/`toSide`/`via`) and serializes it
  into the drill-down payload; the client renderer uses this metadata to match the main graph's style
  exactly. When metadata is absent (e.g., from an older IR), the client falls back to automatic routing.

### Schema caveat

`renderers/shared/generated-validators.mjs` is a committed ajv bundle whose generator is **not present
in this skill package**. The `detail`/`summary` fields are stripped via `RENDERER_EXTENSION_KEYS`
before calling the committed validator, and validated separately by the hand-written
`renderers/shared/detail.mjs` contract (depth guard `MAX_DETAIL_DEPTH=64`, node guard
`MAX_DETAIL_NODES=20000`, cross-collection checks for duplicate ids, unknown keys, bad connector
refs, absolute paths, `endLine < line`). Do **not** hand-edit `generated-validators.mjs`; reconcile it
upstream when the generator becomes available.

## Invariants that are easy to get wrong

- **`meta.quality_profile`** is a real field; a misspelling silently downgrades to basic validation. Set
  `"showcase"` unless the user explicitly asks for a dense `standard` map.
- **Omit by default:** `meta.visual_preset` (opens `classic`), `meta.subtitle` (never restate the title),
  `meta.legend` (truthful `auto`), `meta.engineering_profile`.
- **`meta.locale`** only accepts `"en"` / `"zh-CN"` and controls **renderer-owned UI only**. It never
  translates authored content. For any other language, keep authored copy in that language, omit
  `locale`, and disclose that fixed Viewer UI and `<html lang>` fall back to English.
- **Component types:** `frontend`, `backend`, `database`, `cloud`, `security`, `messagebus`, `external`.
  **Variants:** `default`, `emphasis`, `security`, `dashed` (sequence adds `return`).
- **Relationship labels are semantic data.** Shortening is a last resort after moving the label/route;
  deleting one is never a geometry repair. Required clear gap: `> 6.5px × ASCII units + 13px + 8px`
  (CJK counts as 2 units).
- **Route rhythm (showcase):** every nonzero segment ≥8px, every interior segment ≥16px.
- **Automatic Port Spread** is default behavior for architecture/workflow/dataflow/lifecycle; it skips
  single relationships and anything with explicit `via`/`channelX`/`channelY`/`labelAt`/non-`auto` route.
  Sequence never spreads ports. A side is a direction contract: first/last segment must be perpendicular.
- **Workflow:** use `schema_version: 2` for new work; keep v1 only to preserve existing fixed geometry.
  Never bump `schema_version` alone when absolute coordinates exist — use `migrate`.
- **Lifecycle:** main phases are columns `0..4`; event/terminal column `N` aligns under main column `N+2`;
  a recoverable failure is `type: "failure"` **plus** a real transition back to an active state.
- **Sequence:** omit `meta.column_fit` for stable `fixed`; use `"spread"` for a wide viewBox rather than
  shortening participant labels.
- **Desktop first-screen:** at every checked viewport
  `documentElement.scrollWidth <= innerWidth` and `scrollHeight <= innerHeight`. Never counterfeit a pass
  with `overflow: hidden`, clipping, an internal scroller, stretched SVG height, or smaller typography.
  Mobile may scroll vertically.
- **Handoff receipt** must state: type, absolute output path, specification SHA-256, artifact SHA-256,
  validation counts, `visual_review` status, `correction_rounds` (0–2). Never claim a pass you did not run.

## Changing this repo

- **Schemas are the source of truth for shape; renderers own geometry.** Adding a field means updating
  the mode schema (and `common.schema.json` if shared). Bumping a schema version is a breaking-IR event.
- **`renderers/shared/generated-validators.mjs` is generated and committed** by
  `scripts/generate-validators.mjs` (ajv 2020-12 standalone, `strict` + `allErrors`). That generator is a
  development-time script; it is not present in this skill package, so regenerate it in the upstream
  source tree. `npm test` runs it in check mode there and fails if the committed validators have drifted.
  When editing a schema here, treat `generated-validators.mjs` as needing a matching upstream update —
  a stale validator will reject or accept the wrong shapes.
- **Keep commits additive within a major line.** A file that validates today must keep validating and
  rendering within its declared `schema_version` across 2.x. Existing v1 output is preserved
  byte-for-byte and never silently reinterpreted as v2.
- **Fail closed.** Unpinned brand capture, unverifiable repository evidence, oversized/unsafe manifest
  responses, and symlinked cache entries all resolve to a refusal, not a best guess. Preserve that.
- **Atomicity is a contract.** `deliver`, `compare`, and `migrate` all stage into a private
  same-filesystem temp directory and rename only after all checks pass, preserving the previous artifact
  on any failure. Do not replace these with in-place writes.
- **Diagnostics are a public API.** Codes such as `composition/proper-crossing`,
  `workflow/explicit-pin-conflict`, `artifact/<check-name>`, `delta/commit-failed` are consumed by
  `supportedFixes` mapping in `bin/archify.mjs`. Renaming one is a breaking change.
- No new runtime dependency without a very good reason — the package ships as a zero-dependency ZIP.

## Verifying a change

```bash
node bin/archify.mjs doctor                      # environment + package integrity
node bin/archify.mjs examples                    # re-render every golden example
node bin/archify.mjs validate <type> examples/<matching>.json --quality showcase --json
node bin/archify.mjs demo <tmpdir>               # smoke-test the architecture path end to end
```

`doctor` prints `Archify is ready.` when Node ≥18, all required files, the scenario guide, the compare
runtime + fixtures, and the standalone validators are present and importable.

## Update awareness

After a first candidate exists, the skill runs `scripts/check-update.mjs` once. It is bounded,
fail-closed, and **never** downloads or installs anything — an `update_available` result is information
only, and the user decides what to do. Do not act on it or modify `skill-release.json` version fields on
its behalf.
