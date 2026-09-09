# Claude Code Handoff

This is the entry point. The other six documents describe **what** to build; this
one describes **how, in what order, and by whom** — including what runs in
parallel and what must not.

Read this file completely before doing anything else.

---

## 0. Two principles that override normal build instincts

1. **Never be in a state with nothing to show.** A correct parser that emits JSON
   is not something anyone can look at. Ugly-but-visual beats
   correct-but-invisible at every checkpoint, which is why the crude renderer is
   built in stage 2 against fixtures rather than waiting for a working pack.
2. **PR shape matters as much as code quality.** Work happens in reviewable
   pull requests, not pushes to main, and they are sized so that a reviewer can
   hold the whole change in their head. See §8.

Everything else in this document follows from the specs. These two don't, so they
are stated here.

---

## 1. Rules of engagement

1. **The specs are authoritative.** If code and spec disagree, the spec is right
   and the code is a bug — unless the spec is wrong, in which case say so and
   stop. Do not silently reconcile.
2. **If a spec is silent on something you need, ask.** Do not invent. Every open
   question is listed at the end of the relevant doc; if your question is already
   there, it is deliberately unresolved and needs a human answer first.
3. **Do not build from the open questions or the road map.** Those record
   thinking, not authorised work.
4. **Do not widen scope to make something work.** If a milestone can't be
   completed inside its scope, that's a finding to report, not a licence to add
   runtime tracing.
5. **Determinism is a hard requirement.** See §6.
6. **`core/` is privileged.** See §5.

---

## 2. Stack

Decided. Do not substitute.

| Slot | Choice | Notes |
|---|---|---|
| Language | **TypeScript**, end to end | Parser, CLI, and renderer. One language, no serialization boundary between contract and consumer |
| Parsing | **tree-sitter** (`web-tree-sitter`) | Queries live in `.scm` files, never as string literals in code |
| Contract | **Zod 4** | Schema is the source of truth; types via `z.infer`, JSON Schema via native `z.toJSONSchema()` |
| Renderer | **D3 + SVG** | Layered layout and object-along-edge animation are hand-rolled either way. No graph library |
| Runtime | Node 20+ | |

Notes that matter:

- **Zod is the drift-control mechanism** (see §5.2). The type is derived from the
  schema, so they cannot disagree. Never hand-write a TypeScript interface that
  duplicates a Zod schema.
- Use `z.toJSONSchema()`. Do **not** add `zod-to-json-schema` — that is the Zod 3
  approach and it errors against Zod 4.
- No graph layout library. Cytoscape and React Flow both default to
  force-directed or editable-diagram behaviour, which UI spec §0 explicitly
  rejects.
- Keep the `is_error_path` construct tables (doc 05 §6.2) in data files, not code.

## 3. Build sequence at a glance

```
STAGE 0  ──────────────  serial, agent    Toolchain, CI, workspaces
STAGE 1  ──────────────  SERIAL           M0: freeze the contract
STAGE 2  ──┬── path A ──┐
            ├── path B ──┤  3 PARALLEL     M1: both packs + crude renderer
            └── path C ──┘
STAGE 3  ──────────────  SERIAL           M2: the join   ← first real output
STAGE 4  ──┬── path D ──┐  2 PARALLEL     M3 persistence / M4 renderer
            └── path E ──┘
STAGE 5  ──────────────  SERIAL           M4: animation
STAGE 6  ──┬── path F ──┐  2 PARALLEL     M5 policy / docs + polish
            └── path G ──┘
```

| Stage | Paths | Owns |
|---|---|---|
| 2 | A | `packs/python/` — language, then FastAPI recognizers |
| 2 | B | `packs/swift/` — language, then URL reconstruction |
| 2 | C | `core/` internals, `cli/`, crude renderer against fixtures |
| 4 | D | Persistence, caching, CLI commands |
| 4 | E | Real renderer: layout, visual encoding, zoom |
| 6 | F | Policy checks |
| 6 | G | README, walkthrough, rough edges log |

**Serial stages are serial because of a hard dependency, not caution.** Stage 1 is
the contract everything imports. Stage 3 needs both packs emitting. Stage 5 needs
a renderer to animate. Do not start a parallel stage before its gate passes.

**Path G is not optional.** If time runs short, cut F.

## 4. Repo layout

```
/
├── docs/
│   ├── 00-handoff.md          ← this file
│   ├── 01-scope.md
│   ├── 02-graph-model.md
│   ├── 03-persisted-files.md
│   ├── 04-ui-layout.md
│   ├── 05-parser-pipeline.md
│   └── 06-policy-checks.md
├── core/                      ← graph model, schema, validator, derivation
├── packs/
│   ├── python/                ← Python language + FastAPI framework recognizers
│   └── swift/                 ← Swift language + URL reconstruction
├── cli/                       ← parse, dump, validate
├── web/                       ← renderer
├── fixtures/                  ← hand-written graphs, valid and malformed
└── .waterslide/                 ← generated; see doc 03 for what's gitignored
```

`core/` must not import from `packs/`. The dependency runs one way. If you want
an `if lang == "python"` branch in `core/`, that logic belongs in the pack
interface instead — see doc 05 §3, particularly `provides`.

### 4.1 Reading protocol

Do not read all six docs now. Read at the point of use.

| When | Read | Depth |
|---|---|---|
| Now | `01-scope.md` | Fully. Tells you what not to build |
| Now | `02-graph-model.md` | Fully. Everything depends on it |
| **M0** | `05-parser-pipeline.md` **§3 and §3.6 only** | Fully. The pack interface and `UnresolvedRef` are M0 contract items |
| **M0** | `03-persisted-files.md` **§0 and §1.5 only** | Fully. `graph.json` shape and the baseline node record |
| M1 | `05-parser-pipeline.md` §0–4, §6, §8, §9 | Fully |
| M1 (Swift track) | `05-parser-pipeline.md` §7 | Fully |
| M2 | `04-ui-layout.md` §0–4 | §0 first. Take the rejected-alternatives block seriously |
| M3 | `03-persisted-files.md` | Fully |
| M4 | `04-ui-layout.md` §5–9 | Fully |
| M5 | `06-policy-checks.md` | Fully |

Two thousand lines at once gets skimmed, and a half-remembered graph model
produces code that looks right and diverges quietly.

---

### 4.2 Stage 0 — Toolchain (do this first, serially)

The repo ships with docs, a README, a licence and a gitignore, and nothing else.
M0 cannot land without a toolchain, and the validator-as-arbiter requirement
(§5.2) needs somewhere to run on every commit. **This is agent work, not human
work** — set it up before M0.

| Piece | Choice |
|---|---|
| Package manager / layout | **npm workspaces** — `core`, `packs/*`, `cli`, `web` |
| TypeScript | **Strict, ESM.** `"strict": true`, `"module": "nodenext"` |
| Test runner | **vitest** |
| Gate | **Pre-commit hook**: typecheck → lint → test, on every commit. GitHub Actions is road map (§5.2) |
| Formatting | Prettier, default config. Not worth a debate |

Requirements:

- `core` has **no dependencies on `packs/*`**, and this must be *mechanically*
  enforced. npm workspaces alone will **not** do it: every workspace is symlinked
  into the root `node_modules`, so an undeclared import from `core` into `packs`
  still resolves and typechecks. TypeScript project references do **not** help
  either: they define build order, not import permissions, and a linked workspace
  package that exposes declarations compiles fine without one. The enforcement is:
  - **ESLint `no-restricted-imports`** — a zone rule banning `packs/*` (both the
    workspace package names and relative paths) from `core/**`. This is the
    guardrail, and it names the rule in the failure.
  - **TypeScript project references** for build order only. Do not describe them
    as a boundary.

  The pre-commit hook must fail on the lint error. A convention that holds only
  because nobody tested it is exactly what §5.2 exists to prevent.
- The test suite, run by the pre-commit hook, must run the validator over every
  fixture. It must accept every valid fixture and reject every malformed fixture
  with the expected diagnostic. A validator that doesn't run on every commit
  isn't an arbiter (§5.2).
- The pre-commit hook is a plain script under version control, installed by
  `npm install` via `core.hooksPath`. No hook-manager dependency. It runs
  typecheck, lint and test, **not** `format:check`: formatting is deliberately not
  gated, since Prettier is run on write and a formatting slip is not a
  correctness failure. Recorded so the omission reads as a choice, not a gap.
- Keep tree-sitter queries in `.scm` files and the `is_error_path` construct
  tables in data files, per §2.

**Done when:** `npm run typecheck`, `npm run lint` and `npm test` all pass on an
empty-but-wired repo, the pre-commit hook runs all three, and a deliberately added
import from `core` into `packs` fails lint. Write that import, watch it fail, then
delete it — an unverified guardrail isn't one.

---

## 5. M0 — Freeze the contract (serial, no parallelism)

Nothing forks until this lands. These are the interfaces every other track builds
against.

- Node, Edge, Schema entities per doc 02 §2–4, with all enums.
- Identity scheme per §1: `{scope}:{locator}`, **all seven scope prefixes** — `svc`, `{repo}`, `mongo`, `sql`, `topic`, `ext`, `unknown` (six fixed, plus a repo name).
- Serialization per §8, including the graph model version field.
- The **language pack interface** per doc 05 §3 — all five returns, including
  `provides`.
- `UnresolvedRef` shape, including `ref_kind`.
- **Validator.** The full list of invariants, all of which are stated in doc 02's
  field tables. Enforcing all of them is expected, not scope widening.

| # | Invariant |
|---|---|
| 1 | Node ids unique; edge ids unique; schema ids unique; repo names unique |
| 2 | Every edge `from` and `to` resolves to a node in the graph |
| 3 | Every `parent` resolves to a node in the graph |
| 4 | Every **non-null** `schema_id`, `response_schema_id` and `ref_schema_id` resolves to a schema |
| 5 | Every enum value is a legal member |
| 6 | `confidence != certain` → `confidence_reason` non-null (nodes, edges, schemas) |
| 7 | `is_entry_point: true` → `entry_point_kind` non-null |
| 8 | `is_broken: true` → `broken_reason` non-null |
| 9 | `exclusive_group` non-null → `source` non-null (graph model §3.2) |
| 10 | Node `kind: tombstone` → node `sources` is empty (nodes only; `tombstone` is not an edge kind) |
| 11 | Every `skips_tiers` member is a legal `tier` enum value |
| 12 | Every field-table key with Required `yes` or a condition is **present**, per graph model §2.5. Volatile fields (§7.1) are required in the artifact shape and must be absent in the canonical shape; the caller names the shape explicitly, §7.3 |
| 13 | `source == null` if and only if `source_count == 0` (graph model §3.3) |
| 14 | `branch_ordinal` non-null if and only if `exclusive_group` non-null |
| 15 | `branch_ordinal` is the zero-based position of the **alternative** within its `exclusive_group`, in source order. Values need not be unique within a group: two edges from the same alternative share an ordinal. The ordinals present in a group are contiguous from 0 with no gaps (graph model §3.3) |
| 16 | `skips_tiers` is empty when either endpoint is `external_service`, `topic`, `tombstone` or `unknown`, or has `tier: external` (graph model §3.4) |
| 17 | **Canonical shape only.** `nodes`, `edges`, `schemas` sorted ascending by `id` byte-wise; `repos` by `name`; `nodes[].sources` by `repo`, `path`, `line_start`, `line_end` (null first), `hash`; `skips_tiers`, `classification`, `tags` sorted ascending; every string NFC-normalized (graph model §7.2). Key order and whitespace are the serializer's, checked by byte diff |
| 18 | Every node id is `{scope}:{locator}` with scope one of `svc`, `mongo`, `sql`, `topic`, `ext`, `unknown` or a name in `repos[]`; an `unknown` locator is `{ref_kind}:{encoded_value}` with a legal `ref_kind` and a non-empty value in which `:`, `/`, `%`, space and control characters are canonically percent-encoded; no repo is named after a fixed scope, empty, or containing `:`; for a repo-scoped node with `sources`, every span shares the id's repo and at least one span's `path` is the path in the id (graph model §1) |
| 19 | Every `repo` on a node span (`sources[]`), edge `source` or schema `source` names a repo in `repos[]` (graph model §2.4) |
| 20 | The `parent` chain is acyclic; no node is its own ancestor (graph model §2.3). Self-loop edges remain legal |
| 21 | `line_end`, where non-null, is never less than `line_start` — on node spans, edge sources and schema sources (graph model §2.4). A pack must not repair this with `null` |
| 22 | Node `kind: tombstone` → `confidence` is `inferred` and `confidence_reason` is non-null (graph model §5.1) |
| 23 | `tags`, `classification` and `skips_tiers` contain no duplicates (graph model §7.2, §3.4). Rejected, never deduplicated |
| 24 | Node `kind: unknown` → `sources` is empty, `confidence` is `inferred` and `confidence_reason` is non-null (graph model §2.1). The twin of 22: it stands in for a reference that matched nothing, so a source or `certain` would claim a definition the parser never saw |

**Not an invariant:** a broken edge does *not* have to point at a tombstone.
Tombstones cover a removed target *node*; a removed *field* breaks an edge whose
target still exists. See graph model §5.1.
- **Fixtures.** Valid graphs plus at least six deliberately malformed ones.
  **Written in canonical form** (graph model §7.2), so round-trip verification is
  a plain file diff. **At least one valid fixture must be multi-repo** — graph
  model §0 requires the two-repo case exercised from milestone one, and a
  single-repo fixture would let repo-scoped ids pass untested. **At least one
  valid fixture uses edge ids produced by `core`'s id function** (graph model
  §3.3.1), and a unit test pins that function's output for a known input as a
  literal expected hash. Without both, nothing tests the encoding and a wrong
  implementation survives until two packs disagree in Stage 2.

**Done when:** hand-written fixtures round-trip byte-identically, and the
validator rejects each malformed fixture with a specific message. Round-tripping
compares canonical graphs, per graph model §7.1.

### 5.1 Why the fixtures come first

They are the cheapest test asset in the project and they will catch pack bugs for
the next five milestones. Write them before forking, not after.

### 5.2 Drift control across parallel work

Parallel agents interpreting the graph model differently is the main risk of §7.
Do not solve it with conversation — an agent can be confidently wrong and say so
persuasively. Make disagreement structurally impossible instead:

- The model is **importable code**, not prose. Both packs import the same Zod
  schemas from `core/`. Drift becomes an import error, not a judgement call.
- Emit a **JSON Schema** from the model with `z.toJSONSchema()` and commit it.
  Committing it is not the gate; the test is. `core/test/json-schema.test.ts`
  regenerates the schemas from the Zod source and compares each committed file
  under `core/schema/` against the fresh output, so a hand edit to a committed
  file fails the pre-commit hook instead of surviving until a consumer trips
  on it. Two requirements that test does not yet meet: it must **deep-equal
  the parsed objects**, not compare bytes — a byte comparison couples the gate
  to formatting, and formatting is not the contract; and it must **iterate the
  exported `JSON_SCHEMA_FILES` registry** rather than a duplicated literal list
  of keys, so that a schema added to the registry is pinned without anyone
  remembering to edit the test. The registry is the authority: a schema that
  is not in `JSON_SCHEMA_FILES` is not gated, however the test iterates, so a
  Zod schema that is meant to be emitted is added to the registry, not just
  written into `core/schema/`.
- The **validator is the arbiter**, and runs in the pre-commit hook on every
  commit. Every track's output must pass it. Running it in CI on every PR is
  road map, not MVP — the reasoning holds unchanged if this ever gets more than
  one contributor, but a hook is enough while it has one.
- **The contract surface in `core/` is privileged.** `core/` is two zones, and
  only one of them is privileged:
  - **Contract surface.** Only the orchestrating session changes it. A pack
    that needs a model change files a request; it does not edit these files
    itself. The files: `core/src/model/` (the Zod schemas and every enum),
    `core/src/validate.ts` (the invariant list), `core/src/edge-id.ts`,
    `core/src/span-hash.ts`, `core/src/unknown-id.ts`,
    `core/src/json-schema.ts` (the JSON Schema generator and its registry) and
    the generated files under `core/schema/`. `core/src/index.ts` is contract
    surface for anything it removes or renames; adding an export is an
    internals change.
  - **Internals.** The owning track's (C in Stage 2), no special ceremony.
    The files: everything under `core/src/pipeline/` (discovery, hashing, the
    cache, config, derivation, `rePath`, the stage-3 driver),
    `core/src/canonical.ts` (the canonical serializer), the tests under
    `core/test/` and the scripts under `core/scripts/`.

  The contract surface is privileged because it is what every other track
  imports. A change to it in one PR is an inconsistency the other two PRs
  cannot see, which is the §8.2 hazard, so contract changes go through one
  session rather than three. Internals are imported by nothing outside
  `core/`; a change there is an ordinary change and needs no request. One
  line in `validate.ts` needs drawing: fixing it to enforce an invariant the
  §5 table already states is an internals change, while adding, removing or
  reinterpreting an invariant is a contract change.
- The graph model **version field must fail loudly** on mismatch. A thin map looks
  like a working map.

Inter-agent messaging (Agent Teams, cross-session messaging) is useful for
*notifying* peers that a contract changed. It does not decide whether they
complied. The validator does.

---

## 6. M1 — Both packs, both languages, no join yet

**Scope:** Python pack (language + FastAPI recognizers) and Swift pack (language +
URL reconstruction), each emitting valid graph fragments independently. Plus a
crude renderer built against fixtures. Cross-language resolution is M2.

Two packs is not twice one pack, and it is also not the hard part. The hard part
is the join, which is deliberately deferred so that each pack can be verified
alone before anything depends on both.

Note that language recognition and framework recognition are separate concerns
even inside one pack (doc 05 §3). Adding Django later must not touch Python
parsing.

Done when all of the following hold:

1. **It validates.** The M0 validator passes on both packs' output.
2. **It's deterministic.** Two consecutive runs produce a byte-identical
   **canonical graph** — everything except the volatile fields listed in graph
   model §7.1. `parsed_at` differing is expected and is not a failure; comparing
   whole artifacts would fail every time by design. Then shuffle file discovery
   order and confirm it's *still* byte-identical. Non-determinism here poisons
   change detection for the whole project.
3. **Entry points are complete.** Every FastAPI route appears as a node with
   `is_entry_point: true` and the right `entry_point_kind`. Verify against a
   manual count. Missing routes are the worst failure, because the map still
   looks plausible.
4. **Aliases resolve inside the pack.** `import memory_service as mem` then
   `mem.display()` emits an edge to `memory_service.display`. Six files importing
   one service under four aliases produce **one** target node, not four. Include
   `from x import y` then bare `y()` — no prefix to resolve against, so it needs
   its own recognizer branch.
5. **Spot-check passes.** Ten edges verified by hand across kinds — route to
   service, service to repository, repository to collection, external call to a
   vendor SDK. Each correct in target, kind, tier and confidence.
6. **Unresolved refs are reported, not swallowed.** Summary of every
   `UnresolvedRef` that didn't resolve, grouped by `ref_kind`, printed every run.
   This is a coverage metric.
7. **A pack never throws.** Feed it a syntactically broken file, an empty file,
   and a construct no recognizer handles. Each produces a partial result plus a
   diagnostic. Per doc 05 §9, **silent partial parsing is the failure mode to
   design against**.
8. **Something renders.** Ugly is fine. There must be a picture.

### 6.1 Traps in M1

- **Nested `include_router` prefix composition.** Get this wrong and every route
  path is subtly wrong, so every client-to-route match fails in M2 — while each
  file parses cleanly and nothing looks broken. Test nested inclusion explicitly,
  with prefixes at both levels.
- **Swift URL reconstruction.** The hard part isn't finding the call, it's
  rebuilding the URL: base-URL constants, path interpolation, whatever helper
  wraps the request. Emit an `UnresolvedRef` with `ref_kind: http` and a usable
  `confidence_reason` rather than guessing a path.
- **Bare-name scope.** `from x import y` then bare `y()` produces a `provides`
  entry scoped to the *importing* file, not a global one (doc 05 §3.4). Two files
  importing different functions under the same bare name must not collide. Get
  this wrong and every such call sprouts a false edge that reads like a careful
  ambiguity finding. Fixture it explicitly.
- **`is_error_path` detection.** Per-language tables, doc 05 §6. Open question:
  an `except` that retries is arguably the happy path. Put uncertainty in
  `confidence_reason` rather than guessing confidently.
- **ORM/ODM writes.** Collection inferred from entity class, read-vs-write from
  method name. Cascading writes will be undercounted; accepted, but it must be
  visible in diagnostics rather than invisible.
- **Un-annotated `self.repo.save()`.** Open question in doc 05 §10 whether the
  Python pack needs type inference. If you hit this and it matters, stop and ask.

---

## 7. Parallel tracks

After M0 lands, three tracks run concurrently. Directories are disjoint, so
conflict risk is low.

| Track | Owns | Depends on |
|---|---|---|
| **A** | `packs/python/` | M0 contract only |
| **B** | `packs/swift/` | M0 contract only |
| **C** | `core/` internals — `core/src/pipeline/`, `core/src/canonical.ts`, `core/test/`, `core/scripts/` — plus `cli/` and `web/`. The contract surface in `core/` is not Track C's; see §5.2 | M0 contract only |

### 7.1 Track C is the sleeper

The renderer depends only on `graph.json` — **not on any pack**. Build it against
hand-written fixtures while the packs are still being written. That's how you have
a demoable picture before either parser finishes.

Same for the resolution stage: build it against synthetic `UnresolvedRef`s.

### 7.2 Genuinely serial

- The join (M2) needs both packs actually emitting.
- Any change to the graph model after the fork. See §5.2.

### 7.3 Human track, running alongside

- Review tooling set up and verified on a throwaway PR before real work depends
  on it.
- README maintained continuously, not written at the end.
- **Keep a running log of rough edges, dated.** Anything reconstructed later is
  vague; anything noted in the moment is specific.

---

## 8. PR structure

Volume alone doesn't make a change reviewable. What does is a diff scoped so a
reviewer can hold the whole thing in their head, split where the seams actually
are rather than where the file count happens to divide.

### 8.1 Suggested PR boundaries

| # | Contents | Interesting to review? |
|---|---|---|
| 1 | Core model, enums, validator, fixtures | Moderate |
| 2 | Tree-sitter plumbing, discovery, hashing, cache | Moderate |
| 3 | Python language recognizers (calls, imports, **aliases**) | **Yes** |
| 4 | FastAPI framework recognizers (routes, `include_router`, deps) | **Yes** |
| 5 | Swift language recognizers | Moderate |
| 6 | Swift URL reconstruction | **Yes** |
| 7 | Resolution stage + `UnresolvedRef` handling | **Yes** |
| 8 | Derivation, emit, crude renderer | Moderate |
| 9 | **The join** — cross-language resolution | **Yes** |

PR 9 stays separate deliberately. A change touching both packs and the resolution
stage is where cross-cutting mistakes hide, and it deserves its own review rather
than arriving buried in a pack change.

### 8.2 Hazard: concurrent PRs on the same contract

Stage 2 runs three paths in parallel, which makes this likely rather than
hypothetical.

Two PRs can both touch the graph model contract — one adding a field the Python
pack needs, one adding a field the Swift pack needs. Neither conflicts textually.
Both are individually valid. Merged together they may be inconsistent, and no
single diff shows the problem.

Mitigations, in order of reliability:

- `core/` is privileged (§5.2). Contract changes go through one session, not three.
- The validator runs in the pre-commit hook on every commit, so an inconsistency
  fails a check rather than relying on someone noticing. CI on every PR is road
  map (§5.2).
- When two contract-touching PRs are open at once, merge one and rebase the other
  before review rather than reviewing both against the same base.

### 8.3 Review cadence

Automated review runs on every push and draws from a limited hourly pool.
Pushing while a review is still running discards the review in progress — the
result never posts, but the allowance is spent.

**Batch commits locally and push once per review cycle.** Push, wait for the
review to post, act on it, then push again. One review per round. Review
configuration lives in a file at the repo root and must be present on the
feature branch to apply to that branch's PR.

### 8.4 Editing formatted files

Prettier rewraps long lines on `--write`, so the text on disk is not the text
that was typed. Three edits in M0 failed because a patch anchored on the typed
form, and each recovery rewrote a whole file — riskier than the patch it
replaced.

**Read the exact on-disk region immediately before composing an edit.** Run
`prettier --write` on the file first so the text is stable, anchor on a single
distinctive line rather than a multi-line block that may rewrap, and when a match
fails, re-read and re-anchor rather than rewriting the file.

---

## 9. Remaining milestones

### M2 — The join

Client-to-route matching across the language boundary.

**Done when:** iOS calls connect to FastAPI routes, and a deliberately renamed
route produces a dangling edge with a usable `confidence_reason` rather than a
silent disappearance.

This is the milestone where the tool starts being worth looking at: a line
crossing from a Swift view into a Python route. Backend-only is a dependency
diagram, which plenty of tools already produce. Cross-language is the point of
this one.

### M3 — Persistence and caching

- The five files per doc 03. Respect the write-ownership split exactly: the tool
  never writes a committed hand-authored file.
- Caching per doc 05 §2. **Stage 4 resolution never caches.** Wire it so this is
  structurally impossible, not merely avoided.
- `baseline.json` and change-state computation. **Parsing reads the baseline and
  never writes it** — persisted-files §1.6. Capturing one is a separate command.
- CLI, invoked as `waterslide`: `parse`, `validate`, `dump`, `baseline`, and
  `view` — opens the renderer. `view --export <file.html>` writes a
  self-contained HTML with D3 and the graph inlined, for sharing. `view` may
  land with M4 if the renderer isn't ready.

**Done when:** a warm parse of an unchanged tree is measurably faster than cold
and canonically byte-identical; touching one file changes only that file's nodes;
renaming a symbol in file A correctly breaks the edge from unchanged file B and
mints a tombstone for the removed target; and running `parse` twice in a row does
**not** clear change state.

That last one is the whole reason resolution can't cache. Make it a test.

### M4 — Real renderer and animation

- Layered layout per doc 04 §1. External as a column, not a band.
- Visual encoding per §3. Hue is kind, saturation is change state, double outline
  is new, dashes are confidence. These channels must not collide. Nothing conveyed
  by colour alone.
- Two zoom concepts per §2, named in code as `magnification` and `zoom`. Do not
  let them merge into one variable.
- Read doc 04 §0 first, and the rejected-alternatives block.
- **The graph is drawn once and fixed.** Animation moves objects along existing
  edges. It does not discover, draw, or reveal the graph. Several earlier design
  errors came from getting this backwards.
- Entry point sidebar per §6. The app opens on a list of things a user or system
  can do.
- Branch selection per §7.5. Happy-path heuristic, forks clickable to flip,
  nothing persisted because the default is deterministic.
- No prompting for input values. No "run the error case" toggle. Both were
  considered and rejected; reasoning is in the rejected-alternatives block.

**Done when:** every entry point plays start to finish without a dead end, forks
are visibly clickable, and loops and wide fan-out both animate without special
casing. Wide fan-out is a signal worth seeing, not a problem to cap.

### M5 — Policy checks

Per doc 06. All three checks plus the `capabilities` block. Empty config must
leave everything inert and the map fully functional.

---

## 10. What not to build, ever

From doc 01, repeated because it's the section most likely to erode:

- No runtime tracing, instrumentation, or production observability.
- No real payload values. Shapes only.
- No evaluation of logic correctness or error handling. The plumbing is intact;
  the water may still go down the wrong pipe, and that's fine — not this tool's
  job.
- No naming, formatting or complexity opinions. A linter does that better.
- No rename detection. A function that moves file but keeps its name reads as a
  new node. Accepted tradeoff.

---

## 11. First action

Read `01-scope.md` and `02-graph-model.md` in full. Then do M0, serially, alone.

Do not fork tracks until the validator rejects every malformed fixture.

If anything in either doc is ambiguous, contradictory, or appears to conflict with
this handoff, say so before writing code.
