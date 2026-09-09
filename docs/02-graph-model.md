# Graph Model Spec

The load-bearing document. Language packs emit into this model; the web app
renders from it. Everything else depends on it holding up.

**How to read this doc.** Each entity has a **field table**, which is normative —
field names, types and requirements are the spec. The JSON block that follows is
**illustrative only**; the values are invented to show shape, not to constrain.

Three entity types: **Node**, **Edge**, **Schema**, plus graph-level metadata.

---

## 0. Multi-repo, always

The reference codebase (`tapistree`) is a monorepo, so the POC exercises the case
where the repo list has exactly one entry.

**This is a trap.** Build against a monorepo only and you will bake in
assumptions that break the first time the tool is pointed at four repos. The
cross-repo matching pass — topic string matching, URL-to-route resolution — is
barely exercised when everything sits in one tree.

Mitigations, treated as requirements:

- `repo` appears in every node id, always. No "default repo" shortcut.
- The repo list is always a list, even at length one.
- A synthetic multi-repo fixture exists in the test suite from milestone one.
- Within a monorepo, top-level directories may map to services via tier config.
  That mapping is separate from repo identity and must not substitute for it.

---

## 1. Node identity

Identity must be stable across parses, so saved layout positions survive and a
node is recognised as "the same node" between runs.

Format: `{scope}:{locator}`

| Kind of thing | Format | Example |
|---|---|---|
| Service | `svc:{name}` | `svc:tapistree-api` |
| Code node | `{repo}:{path}#{qualified_name}` | `tapistree:api/routers/notes.py#update_note` |
| Module | `{repo}:{path}` | `tapistree:api/routers/notes.py` |
| Mongo collection | `mongo:{db}.{collection}` | `mongo:tapistree.notes` |
| SQL table | `sql:{schema}.{table}` | `sql:public.orders` |
| Queue topic | `topic:{name}` | `topic:note.indexed` |
| External service | `ext:{vendor}/{surface}` | `ext:cohere/embed` |

**Rules (normative):**

- **Six scope prefixes exist:** `svc`, `{repo}`, `mongo`, `sql`, `topic`, `ext`.
  The `{repo}` form covers two row kinds — code nodes and modules — since a module
  is just a code node whose locator has no `#qualified_name`.
- **A repo must not be named `svc`, `mongo`, `sql`, `topic` or `ext`.** Its name
  is an id scope, and those five are taken. A repo name is also non-empty and
  contains no `:`, for the same reason, and is unique within `repos[]`
  (handoff §5, invariant 1).
- **A split definition keeps one id.** When a node has several `sources`, the id
  names the declaring file: every span shares the id's repo scope, and at least
  one span's `path` is the path in the id. The validator checks both (invariant
  18).
- **Locators are non-empty.** For `mongo`/`sql`, both sides of the `.` are
  non-empty; for `ext`, both sides of the `/`. For repo-scoped ids the path is
  relative, uses forward slashes, has no leading slash and no backslash, and a
  `#` is followed by a non-empty `qualified_name`.
- **The validator checks id format** (handoff §5, invariant 18): the scope is one
  of the five fixed prefixes or a name in `repos[]`; `mongo`/`sql` locators contain
  a `.`, `ext` locators a `/`; and a repo-scoped node with a `source` has
  `source.repo` equal to its scope and `source.path` equal to the path part of its
  locator.
- Identity is never derived from array index or parse order.
- `qualified_name` includes the class for methods: `NoteService.update`.
- Paths are relative to repo root, forward slashes, no leading slash.
- A node that moves file but keeps its name is a **new** node. Accepted
  tradeoff — rename detection is out of scope for the POC.

---

## 2. Node

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable identity per §1 |
| `kind` | enum | yes | Structural type. Drives colour. See §2.1 |
| `label` | string | yes | Human display text, e.g. `PUT /notes/{id}` |
| `tier` | enum | yes | Band placement. Drives vertical position. See §6 |
| `parent` | string \| null | yes | Containing node one semantic level up. Null at top level. The chain is acyclic — see §2.3 |
| `sources` | SourceSpan[] | yes | Every file span that defines this node. One for the common case, several for a definition split across files, **empty** for synthetic nodes such as external services. See §2.4 |
| `sources[].repo` | string | yes | Repo name. Must be in `repos[]` |
| `sources[].path` | string | yes | Path from repo root |
| `sources[].line_start` | int | yes | First line, 1-based |
| `sources[].line_end` | int \| null | yes | Last line. Null where not determinable. Never less than `line_start` |
| `sources[].hash` | string | yes | Hash of this defining span. Drives `modified` detection with the other spans, persisted-files §1.5 |
| `confidence` | enum | yes | `certain` \| `inferred` \| `annotated`. See §5 |
| `confidence_reason` | string \| null | yes | Required when confidence is not `certain` |
| `is_entry_point` | bool | yes | Whether control enters here from outside |
| `entry_point_kind` | enum \| null | if entry point | See §2.2 |
| `is_infrastructure` | bool | yes | Eligible for middleware collapse. Set by config, never inferred |
| `tags` | string[] | yes | Free labels for filtering. May be empty |

```jsonc
// ILLUSTRATIVE ONLY
{
  "id": "tapistree:api/routers/notes.py#update_note",
  "kind": "endpoint",
  "label": "PUT /notes/{id}",
  "tier": "api",
  "parent": "tapistree:api/routers/notes.py",
  "sources": [
    {
      "repo": "tapistree",
      "path": "api/routers/notes.py",
      "line_start": 42, "line_end": 58,
      "hash": "sha256:9f2c…"
    }
  ],
  "confidence": "certain",
  "confidence_reason": null,
  "is_entry_point": true,
  "entry_point_kind": "http_route",
  "is_infrastructure": false,
  "tags": ["auth_required"]
}
```

### 2.1 `kind` enum

`ui_view`, `ui_handler`, `client_service`, `endpoint`, `function`, `class`,
`repository`, `middleware`, `collection`, `table`, `topic`, `external_service`,
`module`, `service`, `tombstone`

`kind` is what a node *is*, and drives hue. It is distinct from `tier`, which
drives position — a `function` may sit in `domain` or in `data_access`.

`tombstone` is the exception to everything else in this enum: it is the only kind
minted from `baseline.json` rather than from source, it always has
`sources: []`, and it exists solely to give a broken edge a resolvable target.
See §5.1. Fifteen values, six hue groups — `tombstone` shares the muted/grey
group with nothing else, since it is the absence of a thing.

### 2.2 `entry_point_kind` enum

`ui_handler`, `http_route`, `webhook`, `queue_subscriber`, `cron`, `app_launch`

Every entry point becomes an item in the sidebar — a playable story. This list is
what turns a static graph into something you can watch.

### 2.3 `parent` and zoom

`parent` is the sole mechanism for zoom aggregation: service → module → function.
The hierarchy derives from folder structure for the POC. Declared grouping
(e.g. "everything touching payments", spread across directories) is road map.

A useful side effect: if two things you think of as one concern don't share a
parent and connect only by a long edge, that's the map telling you the code
disagrees with your mental model.

**The parent chain is a tree.** No node is its own ancestor; a self-parent is
the degenerate case. The validator rejects any cycle (handoff §5, invariant 20),
because `parent` is the only aggregation mechanism and a cycle would make zoom
non-terminating. Edges are unaffected: a self-loop edge — a recursive function —
is legal and worth seeing.

### 2.4 Two source shapes, not one

An earlier draft said edge `source` had "the same shape as node source", which
made `hash` required on edges and schemas. It isn't, and every example correctly
omitted it. Two distinct shapes:

**`SourceSpan`** — nodes only, and always as an **array**, `sources`. A
definition can be split across files: a Swift type declared in
`Models/Note.swift` and extended in `Extensions/Note+JSON.swift` is one node with
two definition sites, and a single object could only name one of them — the
rest would be silently unrepresented. So a node carries every span that defines
it. One span is the common case; several for a split definition; an empty array
for synthetic nodes (collections, external services, tombstones), replacing what
was `null`.

| Field | Type | Required |
|---|---|---|
| `repo` | string | yes |
| `path` | string | yes |
| `line_start` | int | yes |
| `line_end` | int \| null | yes |
| `hash` | string | yes |

**`SourceLocation`** — edges and schemas, as a single nullable `source`. A
call site is a point, not a span; it cannot be split across files.

| Field | Type | Required |
|---|---|---|
| `repo` | string | yes |
| `path` | string | yes |
| `line_start` | int | yes |
| `line_end` | int \| null | yes |

**Both shapes reference a repo.** `repo` must name an entry in `repos[]`
(handoff §5, invariant 19) — on every span of every node, and on every edge and
schema that carries a source. It is the same class of dangling reference as an
edge endpoint or a `schema_id`, and the validator treats it the same way.

**`line_end` is never less than `line_start`** (invariant 21). A pack that
computes an end before its start has a bug, and the right outcome is a rejected
graph so someone fixes the parser. A pack must **not** repair this by emitting
`line_end: null` — null is reserved for ends that genuinely are not determinable,
and degrading a wrong value to null would swap a loud failure for a quiet one
(parser §9).

**Open question, recorded not resolved.** `line_end` is nullable, but tree-sitter
always knows where a matched node ends, so on a parsed node a null end is
suspicious rather than normal. The genuine null cases are hand-written
annotations and edges. This may want tightening to non-null on parsed nodes, and
`line_end` on edges may be droppable entirely. Neither is worth changing now.

`hash` exists on nodes because it drives `modified` detection against the
baseline (persisted-files §1.5). An edge has no independent existence to be
modified — it is derived from its endpoints, and the hash of the file its call
site sits in is already carried by the `from` node. Adding one would create a
second, redundant change signal that could disagree with the first.

### 2.5 Nullable versus absent (normative)

This decides `.nullable()` against `.optional()` in Zod and directly affects
byte-identity, so it is stated once and applies to every entity in this document.

**Every key in a field table whose Required column is `yes` or a condition is
always present in the serialized output.** Where the table permits null, the
value is `null` — the key is never omitted.

| Required column reads | Meaning |
|---|---|
| `yes` | Key always present. Null allowed only if the type says `\| null` |
| A condition, e.g. `if not certain`, `if source`, `if broken` | Key **always present**. Must be non-null when the condition holds; null otherwise |
| `no` | Key may be absent entirely |

A conditional entry is a constraint on the *value*, never a licence to drop the
key. `confidence_reason` is present on every node, edge and schema — null when
`certain`, non-null otherwise. Same for `entry_point_kind`, `broken_reason`,
`line_end`, `condition.source_line`, `response_schema_id`, `ref_schema_id` and
`branch_ordinal`.

Where a JSON example in this document omits such a key, the example is wrong and
the table wins. Examples are illustrative; tables are normative.

---

## 3. Edge

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable across parses given identical endpoints and kind; fork edges also key on `exclusive_group` and `branch_ordinal`. See §3.3 |
| `from` | string | yes | Source node id |
| `to` | string | yes | Target node id |
| `kind` | enum | yes | See §3.1 |
| `label` | string \| null | yes | Display text on the edge |
| `schema_id` | string \| null | yes | Payload travelling `from` → `to` |
| `response_schema_id` | string \| null | yes | Payload returning, where applicable |
| `confidence` | enum | yes | Per §5 |
| `confidence_reason` | string \| null | yes | Required when not `certain` |
| `condition` | object \| null | yes | Set when the edge fires conditionally. See §3.2 |
| `exclusive_group` | string \| null | yes | Fork membership. Edges sharing a value are alternatives. See §3.2 |
| `is_error_path` | bool | yes | Branch is an error/early-exit path. Drives default selection. See §3.2 |
| `source` | object \| null | yes | Call site **location** of the *first* occurrence. See §2.4 and §3.3 |
| `source_count` | int | yes | Distinct call sites collapsed. **0 when `source` is null** — an annotated edge has no call site. See §3.3 |
| `branch_ordinal` | int \| null | yes | Position within `exclusive_group`, source order, from 0. Non-null exactly when `exclusive_group` is. See §3.3 |
| `is_broken` | bool | yes | Previously resolved, no longer does. See §5.1 |
| `broken_reason` | string \| null | if broken | Explanation shown on the warning icon |
| `skips_tiers` | string[] | yes | Bands bypassed. Empty for normal edges. See §3.4 |

```jsonc
// ILLUSTRATIVE ONLY
{
  "id": "e_0a41…",
  "from": "tapistree:ios/Services/NoteService.swift#NoteService.update",
  "to": "tapistree:api/routers/notes.py#update_note",
  "kind": "http_request",
  "label": "PUT /notes/{id}",
  "schema_id": "sch_note_update_req",
  "response_schema_id": "sch_note_response",
  "confidence": "inferred",
  "confidence_reason": "matched URL path literal to route decorator",
  "condition": null,
  "exclusive_group": null,
  "is_error_path": false,
  "source": { "repo": "tapistree", "path": "ios/Services/NoteService.swift", "line_start": 88, "line_end": null },
  "source_count": 1,
  "branch_ordinal": null,
  "is_broken": false,
  "broken_reason": null,
  "skips_tiers": []
}
```

### 3.1 `kind` enum

| kind | Meaning |
|---|---|
| `call` | In-process function call |
| `http_request` | Crosses a process boundary over HTTP |
| `read` | Reads from a datastore node |
| `write` | Writes to a datastore node |
| `publish` | Emits to a topic |
| `subscribe` | Consumes from a topic |
| `external_call` | Terminates at an `external_service` node |

`http_request` is separated from `call` deliberately: one crosses a process
boundary and one doesn't, and that difference matters visually and for animation
timing.

### 3.2 Forks: `condition`, `exclusive_group`, `is_error_path`

Three fields describe branching. Together they let the animation pick one path
without asking the user anything.

**`condition`** — what the source says about when this edge fires.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `expr` | string | yes | The condition as written in source |
| `source_line` | int \| null | yes | Where it appears. Null when not determinable |

Used for dispatch fan-out (a handler map keyed by a payload field) and threshold
branches. Its job is **labelling**, not evaluation — the tool never executes
`expr`. It is display text and a hint to whoever is reading the map.

**`exclusive_group`** — an opaque id shared by the outgoing edges of one branch
point. Two edges with the same value are alternatives: exactly one of them fires
on any given execution. Edges with `null`, or with differing values, are
independent and may fire together.

This distinction is load-bearing rather than decorative. Without it the animation
cannot tell a fork (`if/else` — pick one) from fan-out (two sequential calls — do
both), and parallel-edges-fire-simultaneously in the UI spec would animate both
sides of every conditional at once.

> **Note on a reversal.** `exclusive_group` was proposed earlier, dropped as
> speculative, and is now back. The difference is that it previously had no
> consumer; it now has one, which is default branch selection.

**`is_error_path`** — set when the branch raises, returns an error response, or
otherwise exits early rather than continuing deeper into the system. Detected
from the shape of the branch body, not from naming. Sole purpose is deprioritising
the branch during default selection.

**Default selection.** Within an `exclusive_group`, the animation picks the
first edge under this **total ordering**, applied to every edge in the group:

1. `is_error_path: false` sorts before `is_error_path: true`.
2. Then ascending `source.line_start`.
3. Then ascending `source.path`, for a group spanning files.
4. Then ascending `branch_ordinal`, as the final tie-breaker (§3.3).

**Every edge carrying a non-null `exclusive_group` MUST have a non-null
`source`.** A branch exists at a place in a file; an edge with no source location
cannot be part of a fork. The validator enforces this; the full list of validator
invariants is in handoff §5.

Steps 3 and 4 exist because steps 1 and 2 alone are not a total order. Two
branches can share a line (a ternary, a one-line `guard ... else`), and
`source.line_start` is not unique across files. `branch_ordinal` is unique within
a group by construction, so step 4 always terminates. Without it the chosen
branch would depend on array order, which depends on parse order, which breaks
the determinism requirement.

Because the ordering is total, the choice is fully determined by the graph and
nothing about it is persisted — it recomputes identically every parse. Overriding
it is a UI concern; see UI spec §7.5.

**What this cannot tell you.** If a threshold decides between two endpoints, the
map shows both branches correctly even when the value feeding the comparison is
wrong. The plumbing is intact; the water may still go down the wrong pipe. The
tool also has no interpreter, so a branch is *chosen*, never *evaluated* — the
choice is a legible default, not a claim about what would really happen.

**Rendering:** conditions do not use line style, which is reserved exclusively for
confidence (§5). An edge may be both `inferred` and conditional. Conditions render
as a text label plus a fork marker at the branch point.

### 3.3 Edge identity: one edge per relationship, not per call site

`id` is derived as a hash of `from` + `to` + `kind`. That is deliberately not
unique per call site, and the consequence is the rule:

**Two call sites from A to B of the same kind are one edge, not two.**

`NoteService` calling `repo.save()` on lines 12 and 47 produces a single
`write` edge. The map's claim is *NoteService writes to notes*, which is true
once regardless of how many statements do it. Drawing two identical arrows
between the same pair of nodes adds no information and clutters the layout.

| Field | Behaviour when collapsing |
|---|---|
| `source` | The occurrence with the lowest `line_start`, then lowest `path` |
| `source_count` | Incremented per distinct call site |
| `condition` | Null unless *every* occurrence shares the same condition |
| `exclusive_group` | Never collapsed — see below |
| `confidence` | `inferred` if any occurrence is `inferred`, else `certain`. See below |
| `is_error_path` | True only if every occurrence is an error path |

**Confidence merging is defined over parsed edges only.** `certain` and `inferred`
are levels and merge as above — one uncertain call site makes the whole edge
uncertain, which is the conservative direction. `annotated` is **not** a level
(§5), it's a different origin, so it never participates:

| Situation | Result |
|---|---|
| All occurrences parsed | Merge per the table above |
| An annotated edge exists with no parsed equivalent | Kept as-is, `annotated` |
| An annotated edge collides with a parsed edge of the same id | **The parsed edge wins.** Emit a `redundant_annotation` diagnostic |

The last row is worth the diagnostic: it means someone hand-wrote an edge the
parser can now see for itself, so the annotation is dead weight and should be
deleted. Silently discarding it would leave a stale annotation nobody knows to
remove.

**Fork edges are keyed differently.** Edges with a non-null `exclusive_group` are
alternatives at one branch point and must stay distinct, so they are keyed by
`from` + `to` + `kind` + `exclusive_group` + `branch_ordinal`.

`branch_ordinal` rather than a line number, because a line number is not unique
within a group: `foo(1) if c else foo(2)` puts two alternatives on one line with
identical endpoints and kind, and a line-keyed id would make them collide and the
graph invalid.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `branch_ordinal` | int \| null | yes | Position of this alternative within its `exclusive_group`, in source order, from 0. Non-null exactly when `exclusive_group` is non-null |

The pack assigns it while walking the branch — it already knows the order, so this
costs nothing and avoids adding column tracking to every recognizer. It is
derived from *source* order, not parse order, so the determinism rule in §1 is
satisfied.

`branch_ordinal` also replaces `edge.id` as the final tie-breaker in §3.2's
default-selection ordering, which is both cheaper and more meaningful.

**Accepted consequence:** because fork edge ids depend on `branch_ordinal`,
reordering the limbs of an `if`/`else` changes those ids, and the baseline will
report the old edges as removed and the new ones as new. That is a real
false-positive and it is accepted: swapping branch order is a semantic change
often enough that flagging it is defensible, and the alternative — line- or
column-keyed ids — is worse for the far more common case of a block simply moving
down a file.

The argument against line-based ids stands for non-fork edges: moving a call from
line 12 to line 47 must not change the id, or every refactor would light up the
map with false breakage.

**Validator rules:** edge ids unique within a graph; `source == null` if and only
if `source_count == 0`; `branch_ordinal` non-null exactly when `exclusive_group`
is non-null.

#### 3.3.1 Edge id encoding (normative)

"A hash of `from` + `to` + `kind`" is not enough to make two implementations
agree, and naive concatenation lets different tuples share an input. One
encoding, implemented once:

| Step | Definition |
|---|---|
| Key | Non-fork edge: `[from, to, kind]`. Fork edge: `[from, to, kind, exclusive_group, branch_ordinal]` |
| Input bytes | The key serialized as a JSON array with no whitespace, strings NFC-normalized, encoded UTF-8. JSON array framing makes the input unambiguous — no separator can appear inside a quoted string unescaped |
| Hash | SHA-256 over the input bytes |
| Output | `e_` followed by the first 16 lowercase hex characters of the digest |

Sixty-four bits is ample for graphs of thousands of edges and keeps ids readable
in diffs. The full digest is not persisted anywhere.

`core/` exports the single function that does this, and nobody computes an id
any other way — the same reason the Zod schemas live in `core/` (handoff §5.2).
**Whoever knows both endpoint ids calls it.** A pack does, for an edge it
resolved within one file. Core does, after stage 4, for an edge whose `to` left
the pack as an `UnresolvedRef` — a `PartialEdge` carries no `id` for exactly
that reason. One implementation, two callers. The validator checks uniqueness and resolution, not
derivation — so derivation is pinned separately: at least one valid fixture
carries ids produced by the exported function, and a unit test asserts the
function's output for a known input against a literal expected hash. Malformed
fixtures and fixtures that exercise other invariants may use any unique string.

### 3.4 `skips_tiers`

Populated when an edge jumps more than one band — a `ui_view` writing straight to
a collection, say. Also the basis for a coupling metric: count edges crossing
distant parts of the tree and watch whether that number grows — which is why a
duplicate entry is rejected, not deduplicated (invariant 23): `["domain","domain"]`
would make one edge look like it skipped two bands, and a pack emitting it has a
bug it should learn about.

**Computed only between the six ordered bands.** `ui`, `ui_logic`, `api`,
`domain`, `data_access`, `store` have a depth relationship; nothing else does.
An edge is skipped over entirely — `skips_tiers: []` — when either endpoint is:

| Excluded endpoint kind | Why |
|---|---|
| `external_service` | `external` is not a depth layer (§6). Leaving the system isn't skipping a band, and edge *length* already carries that signal |
| `topic` | A queue is transport, not depth. See below |
| `tombstone` | It sits where the removed node sat; the edge is already flagged `is_broken` and doesn't need a second badge |

The same holds for any endpoint whose `tier` is `external` by config regardless of
`kind`: `external` is not one of the six ordered bands, so no depth relationship
exists to compute. The validator checks both the kind list and the tier.

**On topics specifically.** With `topic` defaulting to `store` (§6.1), an
`endpoint` publishing an event would otherwise register as skipping `domain` and
`data_access` — and "a route publishes an event" is an ordinary, healthy pattern,
not coupling. Badging it would train people to ignore the badge, which costs more
than the check is worth.

The underlying reason is that a topic's tier is about *where it draws*, not how
deep it is. It sits near the collections because data at rest belongs there
visually. Depth is the wrong question to ask about it.

---

## 4. Schema

Payload shapes are separate entities referenced by id, so one Pydantic model
isn't duplicated across forty edges and a classification change is a single edit.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id |
| `name` | string | yes | Type name as written in source |
| `source` | object \| null | yes | Definition **location**. See §2.4 — no `hash` |
| `confidence` | enum | yes | Per §5 |
| `confidence_reason` | string \| null | yes | Required non-null when confidence is not `certain`. Same invariant as nodes and edges, §5 |
| `fields` | Field[] | yes | May be empty for opaque payloads |

**Field:**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Field name |
| `type` | string | yes | Type as written in source |
| `optional` | bool | yes | Whether it may be absent |
| `classification` | string[] | yes | What the field *is*. May be empty |
| `ref_schema_id` | string \| null | yes | Set when the field is itself a schema |

```jsonc
// ILLUSTRATIVE ONLY
{
  "id": "sch_note_update_req",
  "name": "NoteUpdateRequest",
  "source": { "repo": "tapistree", "path": "api/models/note.py", "line_start": 12, "line_end": null },
  "confidence": "certain",
  "confidence_reason": null,
  "fields": [
    { "name": "note_id", "type": "str",       "optional": false, "classification": ["identifier"],                   "ref_schema_id": null },
    { "name": "body",    "type": "str",       "optional": false, "classification": ["free_text", "may_contain_pii"], "ref_schema_id": null },
    { "name": "tags",    "type": "list[str]", "optional": true,  "classification": [],                               "ref_schema_id": null },
    { "name": "author",  "type": "UserRef",   "optional": false, "classification": [],                               "ref_schema_id": "sch_user_ref" }
  ]
}
```

### 4.1 Classification vs policy

`classification` labels are neutral and descriptive: `identifier`, `email`,
`name`, `free_text`, `may_contain_pii`, `health_data`, `financial`.

They say **what a field is**, never what's allowed. Policy regimes (GDPR, HIPAA,
CCPA) live in a separate config layer that maps these labels to rules. Switching
regime re-colours the map; it never requires re-annotating fields.

Preferred source of truth is a Pydantic `Field` annotation next to the type, so
classification versions with the model rather than drifting in a side file.

Nested schemas reference via `ref_schema_id` rather than inlining, so cycles in
type definitions don't cause infinite expansion.

### 4.2 Egress

Because every edge carries a schema, the egress report is a filter rather than a
feature: every edge terminating at an `external_service` node, with its fields
listed. For an app doing semantic indexing and summarisation, that answers "which
user content reaches Cohere and Anthropic" — a compliance question as much as an
architectural one.

---

## 5. Confidence

Three discrete levels. Not a percentage — a percentage implies precision that
can't be justified. Either it was read from source or it wasn't.

| Level | Meaning | Line style |
|---|---|---|
| `certain` | Read directly from source | Solid |
| `inferred` | Stitched together by convention | Dashed |
| `annotated` | A human supplied it; the parser couldn't see it | Dotted |

`annotated` isn't really a confidence level — it's a different origin. It is as
trustworthy as the person who typed it.

`inferred` and `annotated` **must** carry a `confidence_reason`: a short human
sentence, shown on click. Knowing *why* it's uncertain is more actionable than
knowing how uncertain.

Examples:

- `matched publish topic literal 'note.indexed' to subscriber in api/workers/indexer.py`
- `resolved PaymentProcessor → StripeProcessor via config/production.yaml`
- `inferred collection 'notes' from entity class Note`
- `hand-annotated: handlers registered dynamically at startup`

### 5.1 Broken edges

`is_broken` is a boolean, not a confidence level. Set when an edge previously
resolved and no longer does after local changes — a renamed topic leaving an
orphaned subscriber, a dropped endpoint someone still calls, a removed field
another service reads.

Renders red with a **clickable warning icon** at the edge midpoint. Icon rather
than colour alone, so it survives colourblindness and greyscale. Clicking gives
the `broken_reason`.

This is the class of breakage that survives code review, because no single repo
looks wrong on its own.

#### Broken edges still need two endpoints

**Not every broken edge needs a tombstone.** Three cases, and only the first one
does:

| What was removed | Target node | Tombstone? |
|---|---|---|
| The target node itself — a deleted endpoint, a renamed topic | Gone | **Yes** |
| A field the target still exposes — a dropped response field | Still exists | No |
| The reference resolved elsewhere — an ambiguity narrowed | Still exists | No |

The rule is about the structural invariant, not about brokenness: **every edge
endpoint must resolve to a node** (handoff §5, validator). When the target still
exists, `is_broken` is simply a flag on an otherwise ordinary edge and nothing
needs minting.

**When the target node itself is gone, mint a `tombstone` for it.**

| Field | Value |
|---|---|
| `id` | The id the target had in `baseline.json`, unchanged |
| `kind` | `tombstone` |
| `label` | The last known label, from the baseline |
| `sources` | `[]` — the definition is gone |
| `confidence` | `inferred` — **enforced**, invariant 22. A tombstone appears nowhere in source, so `certain` would claim the parser saw something it definitionally did not |
| `confidence_reason` | e.g. `present in previous parse, absent now; edge from api/routers/notes.py still references it` |
| `tier` | Whatever the baseline recorded, so it renders where it used to sit |

Consequences, all intended:

- The validator needs no exception. Endpoint resolution stays absolute, which
  keeps it a cheap unconditional check rather than a conditional one.
- The validator must **not** require that every broken edge points at a
  tombstone. That would be wrong for the field-removal case above.
- The map shows *where the thing used to be*, which is far more useful than an
  edge trailing off into space.
- A tombstone is only ever minted from a baseline entry, so a fresh clone with no
  baseline produces none. Nothing is invented.
- Tombstones are transient. When the reference is fixed or removed, the next
  parse simply doesn't mint one.

`tombstone` is therefore a node kind, and is the only kind the parser mints from
the baseline rather than from source.

---

## 6. Tiers (bands)

Layout is **layered, not force-directed**. Force-directed reshuffles everything
when one node is added, destroying your mental map. Layered pins nodes to
horizontal bands and optimises only left-to-right ordering within each band, so
depth on screen means depth in the stack.

POC bands, top to bottom:

| Tier | Contents |
|---|---|
| `ui` | Swift views |
| `ui_logic` | Client-side handlers and services |
| `api` | FastAPI endpoints |
| `domain` | Business logic, use cases |
| `data_access` | Repositories, ODM layer |
| `store` | MongoDB collections |

Plus one band that is **not** a depth layer:

| Tier | Contents |
|---|---|
| `external` | Rendered as a vertical column down one side |

External services aren't deeper, they're *outside*. A Swift view calling S3
directly draws a long horizontal edge from the top band; a Python worker calling
Anthropic draws a short one from the middle. Both read instantly as "leaving the
system", and edge length indicates how deep in the stack the call originated.
Direct database access is the mirror image — an edge skipping bands vertically.

Tier assignment is declared in config, defaulted from `kind`. **Declared always
wins.**

### 6.1 Default tier by kind (normative)

Used when no config glob matches. Config overrides any row.

| `kind` | Default `tier` |
|---|---|
| `ui_view`, `ui_handler` | `ui` |
| `client_service` | `ui_logic` |
| `endpoint`, `middleware` | `api` |
| `function`, `class`, `module`, `service` | `domain` |
| `repository` | `data_access` |
| `collection`, `table`, `topic` | `store` |
| `external_service` | `external` |
| `tombstone` | Whatever the baseline recorded for the node it replaces |

Three of these deserve a note, because they were the ones the table was missing:

- **`service`** spans every band by nature — it's a container, visible at the
  coarsest zoom level, not a thing that sits at a depth. `domain` is a placeholder
  that puts it mid-stack rather than a claim about where it belongs. Any real
  monorepo should assign services by config glob.
- **`module`** defaults to `domain` for the same reason, but in practice a path
  glob almost always matches first — a module *is* a path.
- **`topic`** is in `store` because a queue holds data between services. It isn't
  a datastore, but of the seven bands it's the closest fit, and a topic sitting
  next to the collections reads correctly on the map: data at rest.

None of these three should be resolved by better defaults. They should be
resolved by config, which is why declared always wins.

**Declared wins even when the result is unusual.** An `external_service` placed
in a non-`external` tier by config is legal, and no invariant should ever be
added for it: tier is config-controlled, and the tool draws the structure it is
told to without an opinion on whether the arrangement is wise. The reverse case
comes up too: an external service *reaching into* your datastore is an edge, not
a tier. `ext:cohere/embed → mongo:tapistree.notes` is fully representable with
Cohere still in the `external` column, and renders as a long edge crossing every
band — the correct and appropriately alarming picture.

---

## 7. Graph metadata

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema_version` | int | yes | Bump on breaking model changes |
| `parsed_at` | ISO 8601 | yes (artifact only, §7.3) | When this graph was produced |
| `repos` | Repo[] | yes | Always a list, even at length one |
| `repos[].name` | string | yes | Used in node ids |
| `repos[].path` | string | yes (artifact only, §7.3) | Local checkout path |
| `repos[].commit` | string | yes | Hash, for reproducibility |
| `repos[].dirty` | bool | yes (artifact only, §7.3) | Uncommitted changes present |
| `tier_config_hash` | string | yes | Invalidates layout when tiers change |
| `stats` | object | no (artifact only, §7.3) | Counts, including breakdown by confidence. The only optional key in the model — safe because §7.1 excludes it from the canonical graph, so its presence cannot affect byte-identity |

`dirty` flags the "map as it *would* be" case — pointing the tool at a working
tree to see a change's effect before opening a pull request.

### 7.1 Volatile metadata and the determinism requirement

`parsed_at` changes on every run by definition, which would make the
byte-identical determinism requirement (parser pipeline §0) impossible to satisfy
as literally stated. Resolve it by defining two things rather than one:

| Term | Contents |
|---|---|
| **The graph artifact** | The whole of `graph.json`, including `parsed_at` |
| **The canonical graph** | Everything except the fields listed below |

**Volatile fields, excluded from the canonical graph:**

| Excluded | Why |
|---|---|
| `parsed_at` | Changes every run by definition |
| `repos[].path` | A local checkout path; differs per machine |
| `repos[].dirty` | Working-tree state, not graph content |
| `stats` | Derived counts, and a plausible home for timings later |

`stats` is excluded **unconditionally**, not "if it ever carries timings." A field
cannot be conditionally canonical — that would make the determinism check depend
on the contents of the thing being checked. Everything in `stats` is derivable
from the canonical graph anyway, so excluding it loses nothing.

**The determinism requirement applies to the canonical graph, not the artifact.**
Two runs over identical inputs must produce byte-identical canonical graphs.
`parsed_at` differing is expected and is not a determinism failure.

### 7.2 Canonical serialization (normative)

"Stable order" needs defining, or byte-identity isn't testable.

| Rule | Definition |
|---|---|
| Top-level key order | `schema_version`, `tier_config_hash`, `repos`, `nodes`, `edges`, `schemas` |
| `nodes` | Array, sorted ascending by `id`, byte-wise |
| `edges` | Array, sorted ascending by `id`, byte-wise |
| `schemas` | Array, sorted ascending by `id`, byte-wise |
| `repos` | Array, sorted ascending by `name` |
| Object key order | The order keys appear in this document's field tables |
| Arrays of scalars (`skips_tiers`, `classification`, `tags`) | Sorted ascending, no duplicates (invariant 23) |
| `nodes[].sources` | Sorted ascending by `repo`, then `path` (byte-wise), then `line_start` |
| `schemas[].fields` | **Declaration order from source.** Not sorted — field order is meaningful and reordering would hide a real change |
| Indentation | Two spaces |
| Line endings | `\n` |
| Trailing newline | Present |
| Unicode | NFC-normalized, UTF-8, no BOM |
| String escaping | Only what RFC 8259 §7 requires: `"`, `\`, and U+0000–U+001F, using the two-character short forms (`\n`, `\t`, `\r`, `\b`, `\f`) where they exist and `\u00XX` lowercase-hex otherwise. Every other code point, non-ASCII included, is emitted as literal UTF-8, never as a `\u` escape. `/` is not escaped. This is `JSON.stringify`'s behaviour for well-formed strings |
| Numbers | Integers only in the model; no float formatting question arises |

Sorting is byte-wise on the UTF-8 encoding, not locale-aware — locale collation
would make output machine-dependent, which is the failure this section exists to
prevent.

**Two kinds of rule, enforced in two places.** The table above mixes rules that
survive `JSON.parse` with rules that don't, and only the first kind can be
checked on a parsed graph:

| Survives parsing | Rules | Enforced by |
|---|---|---|
| Yes | Array order of `repos`, `nodes`, `edges`, `schemas`, `nodes[].sources`; order of `skips_tiers`, `classification`, `tags`; NFC normalization of every string | The **validator**, canonical shape only — handoff §5, invariant 17. A caller who validates without round-tripping still gets a signal |
| No | Top-level and object key order, indentation, line endings, trailing newline, string escaping | The **serializer**, checked by byte diff against the fixture files |

`schemas[].fields` order is declaration order, which the validator cannot know,
so it is neither sorted nor checked.

**Fixtures are written in canonical form.** That makes round-trip verification a
plain `diff` of two files rather than a structural comparison, which is both
cheaper and harder to get subtly wrong.

Provide a `--canonical` flag (or equivalent) that writes only canonical fields in
canonical form. Anything depending on stability — layout, change detection,
diffing — reads that.

### 7.3 Two shapes, one validator, explicit choice

The §7 table marks `parsed_at`, `repos[].path` and `repos[].dirty` as required,
yet the canonical graph omits them by definition, and fixtures are written in
canonical form. Both are valid, as different shapes of the same contract:

| Shape | Contents | Where it appears |
|---|---|---|
| **`CanonicalGraph`** | Every field except the §7.1 volatile ones | Fixtures, `--canonical` output, everything that compares or diffs |
| **`GraphArtifact`** | `CanonicalGraph` plus `parsed_at`, `repos[].path`, `repos[].dirty`, and optionally `stats` | `graph.json` as written by `parse` |

In Zod terms `GraphArtifact` extends `CanonicalGraph`; there is one set of node,
edge and schema schemas, not two. `stats` is artifact-only: it never appears in
the canonical shape, optional or otherwise.

**The caller names the shape. The validator never infers it.**

```ts
validate(graph, { shape: "canonical" | "artifact" })
```

| `shape` | Volatile fields (`parsed_at`, `repos[].path`, `repos[].dirty`) | `stats` |
|---|---|---|
| `canonical` | Must be **absent** | Must be absent |
| `artifact` | Must be **present** | May be present |

There is no default. An unlabelled call is a type error, not a convenience.
Discriminating by presence would be guessing, and it would silently weaken
invariant 12 for exactly these three fields: a real parse output that forgot
`parsed_at` would pass as "canonical". Two invariants are shape-dependent:
invariant 12 (key presence) requires the volatile fields in the artifact shape
and forbids them in the canonical shape, and invariant 17 (canonical order)
applies to the canonical shape only. Every other invariant applies identically
to both.

**Errors are collected within a phase, not across phases.** Validation runs in
two phases. The *structural* phase (Zod: presence, types, enums, shape) either
passes or returns every structural error. The *semantic* phase (ids resolve,
every invariant in the handoff §5 table) runs only after the structural phase passes, and returns every
semantic error. A graph with both kinds of problem therefore reports the
structural ones first and the semantic ones on the next run. This is
deliberate: the semantic checks index nodes by id and dereference fields, which
is unsafe on a graph that did not parse. Fix one wave, expect a second.

"Required" in the §7 table means required *in the artifact*; the volatile fields
are not part of the canonical shape rather than being optional within it, so
§2.5's rule against optional keys still holds.

---

## 8. Serialization

Authoritative list is the persisted-files spec §0. Summary:

| Path | Content | Committed? |
|---|---|---|
| `.waterslide/annotations.yaml` | Hand-written facts the parser can't derive | **Yes** |
| `.waterslide/config.yaml` | Tiers, infrastructure markers, policy, DI resolution | **Yes** |
| `.waterslide/layout.json` | *Optional* published shared layout | **Yes** |
| `.waterslide/positions.json` | Personal node coordinates | No — gitignored |
| `.waterslide/baseline.json` | Last-parsed ids and hashes, for change state | No — gitignored |
| `.waterslide/graph.json` | Full graph output | No — gitignored |
| `.waterslide/cache/{hash}.json` | Per-file parse cache | No — gitignored |

Gzip `graph.json` above a few MB.

Note the split: files humans write are never rewritten by the tool, and layout is
personal **by default** — `layout.json` is an opt-in shared starting point,
published by explicit action, never written automatically. An earlier draft of this section had positions and
config sharing one committed file; see persisted-files spec §0 for why that was
wrong.

---

## 9. Derived, never stored

Computed at render time:

- **`change_state`** — `unchanged` \| `modified` \| `new` \| `removed`, computed
  against `baseline.json`. Derivation table lives in persisted-files spec §1.5.
  It must **not** be derived from the absence of a saved position; that coupled
  diff detection to layout storage and broke once layout became personal.
- **Default branch selection** at each `exclusive_group`. Deterministic under
  §3.2's four-step total ordering, so never persisted.
- **Aggregated edges** for zoomed-out views — forty calls to Mongo become one
  thick line, and the animation shows one object moving rather than forty.
- **Reachable set** from an entry point — the "blast radius" driving flow mode.
- **Offscreen indicator counts** — shallow count at the current level, with change
  state inherited from the most significant nested descendant.

---

## 10. Diagnostics

**This section records a decision the specs had left undefined.** Parser pipeline
§3.3 names `Diagnostic[]` as a pack's fifth return and §9 lists the failure
classes, but neither fixed the fields. Two consumers need to *group* diagnostics
— the per-run unresolved-reference summary (handoff §6, item 6; parser §9) and
the `redundant_annotation` diagnostic (§3.3) — and grouping needs a stable code,
not a message string. So the shape is fixed here, in the model, where the other
contract items live.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `severity` | enum | yes | `error` \| `warning` \| `info` |
| `code` | string | yes | Stable `snake_case` identifier. The grouping key. Never derived from the message |
| `message` | string | yes | One human sentence. May vary; `code` may not |
| `repo` | string \| null | yes | Repo the diagnostic concerns. Null when not tied to one |
| `path` | string \| null | yes | File from repo root. Null when not tied to a file |
| `line` | int \| null | yes | Line where known |
| `pack` | string \| null | yes | `id` of the emitting pack (parser §3.1). Null when core emitted it |

§2.5 applies: every key is always present, null where the table allows.

Codes are open-ended — a pack may define its own — but these are reserved with
fixed meanings so consumers can rely on them:

| `code` | Emitted by | Severity | When |
|---|---|---|---|
| `syntax_error` | pack | `error` | File could not be parsed. No nodes from that file (parser §9) |
| `unsupported_construct` | pack | `warning` | A construct no recognizer handles. What *was* understood is still emitted |
| `recognizer_failure` | pack | `error` | A framework recognizer failed; the language pack's output is kept |
| `unresolved_ref` | core | `warning` | Stage 4 could not resolve an `UnresolvedRef`. The summary groups these, then by `ref_kind` inside the message |
| `redundant_annotation` | core | `warning` | A hand-written edge collides with a parsed edge of the same id; the parsed one wins (§3.3) |

A `graph_schema_version` mismatch is **not** a diagnostic. It aborts the run
(parser §3.1, §9).

Diagnostics are not part of `graph.json`. They are a run output, surfaced as a
count with drill-down; silent partial parsing is the failure mode they exist to
prevent.

## 11. Open questions

- ~~Do conditional-edge dashes collide with confidence dashes?~~ **Resolved:**
  line style is confidence only; conditions get a label and fork marker.
- ~~Does `condition` earn its keep, if nearly every edge is conditional?~~
  **Resolved:** yes, but for a different reason than originally written. It is
  fork *labelling*, and the fork model needs `exclusive_group` alongside it to be
  useful at all. See §3.2.
- ~~Does branch default selection have a deterministic tie-breaker?~~
  **Resolved:** four-step total ordering, and `source` is now mandatory on any
  edge in an `exclusive_group`. See §3.2.
- ~~Does a required `parsed_at` break the byte-identical determinism gate?~~
  **Resolved:** determinism applies to the *canonical graph*, which excludes
  volatile fields. See §7.1.
- ~~Can a broken edge point at a node that no longer exists, given the validator
  requires every endpoint to resolve?~~ **Resolved:** tombstone nodes, minted
  from the baseline. See §5.1.
- How reliable is `is_error_path` detection across Swift and Python? A `guard`
  with an early return, a `raise`, and a returned error response all need
  recognising. Parser spec should treat this per-language.
- Is a string enum enough for `tier`, or does it need a first-class entity?
- Aggregated edge confidence: **partly resolved.** For edges collapsed by §3.3
  (multiple call sites, one relationship) one `inferred` makes the edge
  `inferred`. Still open for *zoom* aggregation, where forty edges roll into one
  thick line at service level — the conservative rule may be too noisy there.
- ~~Edge `id` stability: derived by hashing `from` + `to` + `kind`, or
  persisted?~~ **Resolved: derived, and deliberately not per-call-site.** Two
  call sites of the same kind collapse to one edge. Fork edges are keyed
  additionally by `exclusive_group` and `branch_ordinal`. See §3.3.
