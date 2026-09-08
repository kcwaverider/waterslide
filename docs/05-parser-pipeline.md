# Parser Pipeline Spec

How source files become a graph. This is the doc the build leans on hardest —
everything in the graph model spec is a *destination*, and this is the machinery
that gets there.

**How to read this doc.** Field tables are normative. JSON blocks are
**illustrative only**.

---

## 0. The pipeline

Six stages, strictly ordered. Each stage's output is the next stage's only input.

| # | Stage | Cacheable | Notes |
|---|---|---|---|
| 1 | **Discover** | No | Walk repos, list candidate files, record commit hashes |
| 2 | **Hash** | No | Content hash per file. Cheap; drives stage 3 |
| 3 | **Parse** | **Yes** | Per-file, by hash. The expensive stage |
| 4 | **Resolve** | **No — never** | Match references across files and repos. See §2.2 |
| 5 | **Derive** | No | Tiers, parents, `skips_tiers`, `exclusive_group` grouping |
| 6 | **Emit** | No | Write `graph.json`. **Nothing else** |

**Stage 6 writes `graph.json` and only `graph.json`.** It does not touch
`baseline.json`. Capturing a baseline is a separate explicit action — see
persisted-files spec §1.6 — because a parse that refreshed the baseline would
make change state permanently empty.

**Read-only side inputs.** "Each stage's output is the next stage's only input"
describes the *flow of derived data*, not total isolation. Two committed or local
files are read as side inputs and never written by the pipeline:

| File | Read by | Used for |
|---|---|---|
| `config.yaml` | Stages 4, 5 | DI resolutions, tier globs, infrastructure markers, policy |
| `annotations.yaml` | Stage 5 | Manual edges, classifications, notes |
| `baseline.json` | Stage 5 | Change state, `is_broken`, tombstone reconstruction |

The cacheable/never-cacheable split at stages 3 and 4 is the single most important
structural fact in this document. Everything else follows from it.

**Determinism is a requirement, not a nicety.** The same inputs must produce
byte-identical output, because layout stability, change detection and diffing all
depend on it. Concretely: sort file lists before walking, sort node and edge
arrays before emitting, never let a hash-map iteration order reach the output, and
never derive an id from parse order or array index.

---

## 1. Input: multi-repo, always

### 1.1 Repo list

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Short name. Appears in every node id from this repo |
| `path` | string | yes | Local checkout path |
| `include` | string[] | no | Glob allowlist. Default: everything a pack claims |
| `exclude` | string[] | no | Glob denylist. Applied after `include` |

```jsonc
// ILLUSTRATIVE ONLY
{
  "repos": [
    { "name": "tapistree", "path": "~/code/tapistree",
      "exclude": ["**/Pods/**", "**/node_modules/**", "**/*.generated.py"] }
  ]
}
```

`name` is the user's choice, not the directory name — directories get renamed and
every node id in the baseline would shift. Once set it should be treated as
permanent; changing it invalidates all saved positions for that repo.

### 1.2 Per-repo state captured at parse time

| Field | Type | Meaning |
|---|---|---|
| `commit` | string | `HEAD` hash. For reproducibility |
| `dirty` | bool | Uncommitted changes present in the working tree |
| `branch` | string \| null | Convenience for display only |

`dirty` enables the "map as it *would* be" case: point the tool at a working tree
and see a change's effect before opening a pull request. It is display state, not
a gate — a dirty repo parses exactly like a clean one.

### 1.3 Exclusions that matter in practice

Skip by default: vendored dependencies, generated code, test files, build output.

Tests are the arguable one. They call into everything, so including them roughly
doubles the graph and adds edges that describe the test suite rather than the
system. Excluded by default, with a config flag to include, because "what does the
test suite touch" is a legitimate but *different* question.

---

## 2. Caching

### 2.1 What is cached

Parse results, keyed by file content hash. Not by path — by hash. A file that
moves without changing hits the cache; a file that changes misses regardless of
where it lives.

```
.waterslide/cache/{sha256-of-content}.json
```

The cache entry holds one file's stage-3 output (§3.3). Path is *not* part of the
key but *is* part of the payload, since node ids embed it — so a moved file needs
its cached payload re-pathed rather than re-parsed. Cheap.

Cache invalidation beyond content: bump on language pack version change, and on
graph model `schema_version` change. Both go in the entry so a stale entry is
detected rather than trusted.

### 2.2 The resolution pass always re-runs

**Non-negotiable.** Stage 4 runs in full on every parse, over the complete
in-memory set of parsed files, cached or not.

The reason is that resolution is not a property of any single file. Rename a
function in repo A and the *unchanged* file in repo B that called it now has a
broken reference. Nothing about B's content changed, so B is cache-fresh, and if
resolution were cached alongside it the break would be invisible. That break is
one of the highest-value findings this tool produces (see scope §what-it-is,
contract detection), so the pass that finds it cannot be skipped.

Cost is acceptable: resolution is string matching over an in-memory index, and
parsing was the expensive part.

### 2.3 Consequence for the language pack contract

Since resolution is central and always fresh, packs must not resolve across files
at all. §3.4 makes that boundary precise.

---

## 3. The language pack interface

A pack is the only language-aware component. Everything above it in the pipeline
handles nodes and edges without knowing what a decorator is.

### 3.1 What a pack declares about itself

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | e.g. `python`, `swift` |
| `version` | string | yes | Pack version. Part of the cache key |
| `graph_schema_version` | int | yes | Graph model version this pack emits |
| `extensions` | string[] | yes | File extensions claimed, e.g. `[".py"]` |
| `frameworks` | string[] | yes | Framework recognizers bundled, e.g. `["fastapi"]` |

`graph_schema_version` must **fail loudly** on mismatch. A pack emitting an older
model shape produces a map that is quietly thin — nodes present, edges missing —
which is worse than no map, because a thin map still looks plausible. Refuse to
run and name the pack.

**Frameworks are declared separately from the language, deliberately.** FastAPI
recognition is not Python recognition. A Python pack that finds functions, calls
and imports perfectly well can know nothing about routes. Keeping the two
separable means adding Django later touches a framework recognizer and not the
Python pack.

### 3.2 Framework recognizers

A framework recognizer runs *after* its language pack on the same file, and may
only add to or annotate what the language pack found.

| Capability | Allowed |
|---|---|
| Mark an existing node as an entry point | Yes |
| Add an edge the language pack couldn't see (route → handler) | Yes |
| Add a schema from a framework construct (Pydantic model) | Yes |
| Change a node's id | **No** |
| Remove a node the language pack emitted | **No** |

The id rule keeps identity owned by exactly one component. If a recognizer could
rename nodes, two recognizers claiming the same file would fight and there'd be no
arbiter.

### 3.3 What a pack returns

Called once per file, given `(repo_name, path, content)`. Returns:

| Key | Type | Meaning |
|---|---|---|
| `nodes` | Node[] | Definitions found in this file. Full ids, per graph model §1 |
| `edges` | PartialEdge[] | Relationships found. `to` may be unresolved. See §3.5 |
| `schemas` | Schema[] | Payload shapes declared in this file |
| `provides` | Provide[] | The names by which other files may refer to these nodes. See §3.4 |
| `diagnostics` | Diagnostic[] | Parse failures and unsupported constructs. Never thrown. Shape: graph model §10 |

Entry points are **not** a separate collection — they are the `is_entry_point`
and `entry_point_kind` fields on a node, per graph model §2.

> **Five required returns:** `nodes`, `edges`, `schemas`, `provides` and
> `diagnostics`. None is optional. `provides` was the one an earlier draft
> lacked — see §3.4 for why it cannot be dropped. `diagnostics` is shaped by
> graph model §10.

### 3.4 `provides`: why the fifth return exists

The core matches an outgoing reference like `memory_service.display` against
whatever file defines it. But the mapping from *file path* to *referable name* is
language-specific. In Python, `services/memory_service.py` is importable as
`services.memory_service`, subject to package layout and `__init__.py`. In Swift
there is no path-to-name relationship at all — visibility comes from module
targets and access control.

The core cannot compute that mapping without becoming language-aware, which is
exactly what the pack boundary exists to prevent. So the pack states it.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | The name others may use, e.g. `services.memory_service.display` |
| `node_id` | string | yes | The node it resolves to |
| `visibility` | enum | yes | `public` \| `module` \| `private`. Narrows match scope |
| `scope` | enum | yes | `global` \| `file`. See below |
| `scope_path` | string \| null | if `scope: file` | The file within which the bare name is valid |

One node may have several `provides` entries — a Python function is referable as
`module.func` and, after `from module import func`, as a bare name within the
importing file. Both are the pack's business to declare.

#### Bare names must be file-scoped

A qualified name is unambiguous anywhere. A bare name is not, and treating the
two the same is a soundness bug rather than an inconvenience.

Consider two files:

```python
# api/services/notes.py
from memory_service import display     # → memory_service.display
display(note)

# api/services/reports.py
from report_renderer import display    # → report_renderer.display
display(report)
```

Both packs emit a `provides` entry for the bare name `display`, pointing at
*different* nodes. If bare names were global, stage 4 would see two candidates
for every bare `display()` call and — per §4.3 — emit edges to **both**. Every
such call would sprout a false edge, marked `inferred`, with a reason that reads
like a genuine ambiguity. The map would be wrong in a way that looks careful.

**Rules:**

| `name` shape | `scope` | Matched against |
|---|---|---|
| Qualified (contains a separator) | `global` | Any reference in any file |
| Bare (no separator) | `file` | Only references originating in `scope_path` |

- `scope_path` is the path of the file that *imported* the name, not the file that
  defined it. The binding belongs to the importer.
- Stage 4 must therefore retain each parse result's owning file and use it when
  matching. Dropping it — treating the index as a flat name→node map — is the
  specific mistake this section exists to prevent.
- Two identical bare bindings in different files are not an ambiguity. They are
  two unrelated facts that happen to share a spelling.

### 3.5 The resolution boundary

**A pack resolves everything derivable from the file itself, and stops at anything
requiring another file.**

Inside the boundary — pack must handle:

- **Import tables.** Aliased imports die inside the pack. `import memory_service
  as mem`, then `mem.display()`, emits a reference to
  `memory_service.display`. The alias never leaves.
- **From-imports and bare names.** `from memory_service import display`, then
  `display()`, emits the same reference. This is a *distinct branch* in the
  recognizer, not a special case of the dotted form — there is no prefix to
  resolve against, only the import table.
- **Local scope.** Variables, parameters, nested functions, comprehensions.
- **`self` and class context.** `self.repo.save()` inside `NoteService` resolves
  through the attribute's declared or annotated type where available.
- **Swift equivalents.** `typealias`, extensions, and `@testable import`.

Outside the boundary — pack must **not** attempt:

- Deciding which node a qualified reference points at.
- Matching a URL literal to a route.
- Matching a publish topic to a subscriber.
- Any lookup requiring a second file's contents.

Two reasons the alias must resolve inside the pack. First, the map should show the
real target, not one file's nickname for it. Second, if aliases survived, a second
file importing the same module *without* renaming would emit a different reference
for an identical target, and you would get two nodes where there is one.

**Free diagnostic:** because the pack reports the resolved name and the core sees
every reference, the tool can notice that six files import one service under four
different aliases. Harmless, but a smell, and it costs nothing to surface.

### 3.6 `UnresolvedRef`

What a pack emits in an edge's `to` when the target lives elsewhere.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `ref_kind` | enum | yes | `symbol` \| `http` \| `topic` \| `datastore` \| `external` |
| `value` | string | yes | The resolved-as-far-as-possible reference |
| `hints` | object | no | Extra matching material. Shape varies by `ref_kind` |
| `source_line` | int | yes | Where the reference appears |

| `ref_kind` | `value` | `hints` |
|---|---|---|
| `symbol` | Qualified name after alias resolution | `{ arity, receiver_type }` |
| `http` | Path literal or template | `{ method, base_url_expr }` |
| `topic` | Topic string | `{ direction: "publish" \| "subscribe" }` |
| `datastore` | Collection or table name | `{ operation: "read" \| "write" }` |
| `external` | Vendor surface, e.g. `cohere/embed` | `{ sdk_symbol }` |

```jsonc
// ILLUSTRATIVE ONLY
{
  "from": "tapistree:ios/Services/NoteService.swift#NoteService.update",
  "kind": "http_request",
  "to": { "ref_kind": "http", "value": "/notes/{id}",
          "hints": { "method": "PUT", "base_url_expr": "APIConfig.baseURL" },
          "source_line": 88 },
  "confidence": "certain",
  "condition": null,
  "exclusive_group": null,
  "is_error_path": false
}
```

A pack sets `confidence` on what it *saw*: `certain` that the call site exists and
names this target. The core may **downgrade** confidence during resolution — a
URL literal matched to a route by convention becomes `inferred` with a reason —
but may never upgrade it.

---

## 4. Stage 4: resolution

### 4.1 Index, then match

Build one index across all parsed files: every `provides` entry, every route, every
topic, every collection. Then walk every `UnresolvedRef` and match it.

**The index is keyed by name *and* scope.** A `provides` entry with `scope: file`
matches only references originating in its `scope_path` (§3.4). The index cannot
be a flat name→node map, and the reference's own file must be carried into
matching — this is the most likely place for a subtle wrong-edge bug to enter.

| `ref_kind` | Matched against | Result confidence |
|---|---|---|
| `symbol` | `provides` index, respecting `visibility` | `certain` on exact match |
| `http` | Route table from framework recognizers | `inferred` — path template matching is convention |
| `topic` | Publish and subscribe sets, by string equality | `inferred` — the broker holds the real mapping |
| `datastore` | Collection nodes, minted on demand | `inferred` when derived from an entity class |
| `external` | Known-vendor table, node minted if absent | `certain` on SDK symbol, `inferred` on bare URL |

Every non-`certain` result must carry a `confidence_reason` written for a human:
"matched URL path literal to route decorator in `api/routers/notes.py`". The
reason is the highest-value field in the inspection panel, per UI spec §8.

### 4.2 Unmatched references

A reference that matches nothing becomes a **dangling edge**, not a dropped one.

Dropping it would hide the finding. The whole contract-break story — a renamed
topic leaving orphaned subscribers, a deleted endpoint still called from the
client — *is* the unmatched reference. Compare against `baseline.json`:

| Situation | Result |
|---|---|
| Ref unmatched, and the edge existed in baseline | `is_broken: true`, with `broken_reason` |
| Ref unmatched, and no baseline entry | Dangling edge to a synthetic `unknown` node |
| Ref matched, and was broken in baseline | Silently healed. No badge |

### 4.3 Ambiguous matches

Two `provides` entries claiming one name. Emit edges to **all** candidates,
confidence `inferred`, reason naming the ambiguity. Never pick arbitrarily — an
arbitrary pick is a confidently wrong map, which erodes trust faster than a
visibly uncertain one.

---

## 5. Stage 5: derivation

What the core computes once the graph is connected.

| Derived | From |
|---|---|
| `tier` | `config.yaml` path globs, then node kind as fallback |
| `parent` | Folder structure for the POC, per graph model §2.3 |
| `skips_tiers` | Band distance between an edge's endpoints |
| `is_infrastructure` | `config.yaml` declarations only. Never inferred |
| `exclusive_group`, `branch_ordinal` | **Not derived.** Pack-supplied per branch, per §6 and §3.6 — core cannot know where a branch sits without parsing |
| `is_error_path` | Pack-supplied per branch, per §6 |
| `id` (edge) | `edgeId()` from graph model §3.3.1, called by core for edges that left the pack with an `UnresolvedRef` target; packs call the same function for edges resolved within a file |

Tier assignment by path glob before kind matters for the monorepo case, where
`api/` and `ios/` are the strongest available signal.

---

## 6. Branch detection

This section carries more weight than its length suggests: the entire animation
model rests on it (UI spec §7.5), and it is per-language work.

### 6.1 What a pack must produce

For each branch point that gates *different outgoing edges*:

- One `exclusive_group` id shared by the alternative edges.
- `condition.expr` per branch, verbatim from source.
- `is_error_path` per branch.

Branch points gating no edges — a conditional that only sets a local variable —
produce nothing. This keeps groups scarce enough to be useful.

### 6.2 `is_error_path` detection

The signal is *the branch does not continue deeper into the system*.

Python:

| Construct | `is_error_path` |
|---|---|
| `raise` anywhere in the branch body | true |
| `return HTTPException(...)` / `JSONResponse` with 4xx or 5xx | true |
| Early `return` where the function continues below the branch | true |
| `except` clause | true by default |
| Branch body containing further calls that continue downward | false |

Swift:

| Construct | `is_error_path` |
|---|---|
| `guard ... else { }` — the else limb | true |
| `throw` | true |
| `catch` block | true by default |
| `return nil` from an optional-returning function | true |
| Normal `if` / `else` limbs that continue | false |

Detection is from branch *shape*, never from naming. A branch called
`handleFailure` that writes to three collections is not an error path for these
purposes — it is plumbing, and the map should show it.

### 6.3 try/except and do/catch are forks

Treat the protected body and each handler as alternatives in one
`exclusive_group`. Falls out for free, and means a handler doing real work — audit
write, failure event, retry enqueue — is reachable by clicking, per UI spec §7.5.

### 6.4 Dispatch tables

A handler map keyed by a payload field is a branch point with as many alternatives
as the map has literal keys. Each key becomes a `condition.expr` and one edge.

This is where the literal-derived option buttons come from, discussed as a road
map item: the options *are* the map keys, already extracted. No forecasting.

---

## 7. Swift recognizers

Target: the `tapistree` iOS client.

| Target | Approach | Confidence |
|---|---|---|
| Types and functions | `class_declaration`, `struct_declaration`, `function_declaration` | `certain` |
| Import table | `import_declaration`, plus `typealias` | `certain` |
| SwiftUI views | Types conforming to `View` | `certain` |
| UI handlers | `.onTapGesture`, `Button(action:)`, `.onSubmit`, `.task`, `.onAppear` | `certain` |
| App launch | `@main`, `App` conformance | `certain` |
| HTTP calls | `URLSession` calls; path from the `URL` construction expression | `inferred` |
| Codable payloads | Types conforming to `Codable` → Schema | `certain` |
| Error paths | Per §6.2 | `certain` |

**The hard part is the URL, not the call.** `URLSession.shared.data(for: request)`
is trivial to find; the request was built somewhere else from a base URL constant
and an interpolated path. Follow it as far as local scope allows, emit the best
path template available, and set `hints.base_url_expr` so the core can see what it
couldn't resolve. When only a fragment is recoverable, emit it with an `inferred`
confidence and a reason saying so — a partial path that matches one route is still
a correct edge.

`.task` and `.onAppear` are entry points of kind `ui_handler`, and are worth
calling out because they fire without a user action. A view that loads data on
appear is an entry point that no click produces.

---

## 8. FastAPI recognizers

Target: the `tapistree` Python API.

| Target | Approach | Confidence |
|---|---|---|
| Routes | `@app.get/post/put/delete/patch` and `@router.*` decorators | `certain` |
| Router mounting | `include_router(..., prefix=...)` → full path | `certain` |
| Path templates | Decorator argument, verbatim | `certain` |
| Request/response schemas | Pydantic models in signature and `response_model` | `certain` |
| Dependencies | `Depends(...)` → edge to the dependency callable | `certain` |
| Middleware | `@app.middleware`, `add_middleware` | `certain` |
| Background work | `BackgroundTasks`, and any queue library present | `inferred` |
| Mongo access | Motor/PyMongo collection access, or ODM entity class | `inferred` |
| External calls | Cohere and Anthropic SDK symbols | `certain` |
| Error paths | Per §6.2 | `certain` |

**Prefix composition is a real trap.** A route's displayed path is the decorator
argument prefixed by every `include_router` prefix above it, which may be nested
across files. Get this wrong and every client-to-route match in stage 4 fails
while each individual file parses cleanly. Worth a dedicated fixture.

**`Depends` is the middleware story.** An auth dependency in a route signature is
what the expected-middleware check reads (persisted-files spec §3.2–3.5). Route
with `Depends(get_current_user)` passes; the sibling route the agent added without
it does not. That check is the original motivating worry, and it lives here.

**Mongo read-versus-write** comes from the method name — `find_one` reads,
`update_one` writes, `aggregate` reads. Always `inferred`, and cascading writes may
be undercounted. Stated in scope §blind-spots and repeated here so it isn't
rediscovered during the build.

---

## 9. Failure handling

A pack **never throws**. One unparseable file must not take down the run.

| Failure | Behaviour |
|---|---|
| Syntax error | Emit a `diagnostic`, no nodes from that file, continue |
| Unsupported construct | Emit a `diagnostic` naming it, emit what was understood |
| Framework recognizer fails | Keep the language pack's output, diagnose the recognizer |
| No pack claims a file | Silent skip. Not a diagnostic — most files aren't code |
| `graph_schema_version` mismatch | **Abort the run.** Loud, per §3.1 |

Diagnostics surface as a count in the UI with a drill-down. Silent partial parsing
is the failure mode to design against: a map that renders cleanly while missing a
quarter of the system is actively misleading, which is worse than one that admits
it's incomplete.

---

## 10. Open questions

- Does the Python pack need type inference to resolve `self.repo.save()` when
  `repo` has no annotation? Cheap version: use the annotation when present,
  otherwise emit `inferred` with the attribute name. Probably enough.
- Where does `provides` visibility come from in Swift, given module targets aren't
  visible from a single file? May need the Xcode project file as a config input.
- Is `except` reliably `is_error_path: true`? A handler that retries and continues
  is arguably the happy path of a flaky call. Defaulting to true and letting the
  click reveal it seems right, but it will be wrong sometimes.
- ~~Do bare-name `provides` entries need a scope?~~ **Resolved: yes, file-scoped.**
  Global bare names would emit false edges to every same-named target. See §3.4.
- ~~Does stage 6 write `baseline.json`?~~ **Resolved: no.** Parsing never writes
  the baseline; see persisted-files spec §1.6.
- Should the resolution index be persisted purely as a diffing aid? Not needed for
  correctness — the pass re-runs regardless — but it might make "what changed in
  resolution since last parse" cheap.
