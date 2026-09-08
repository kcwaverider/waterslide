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
| `parent` | string \| null | yes | Containing node one semantic level up. Null at top level |
| `source` | object \| null | yes | Location. Null for synthetic nodes such as external services |
| `source.repo` | string | if source | Repo name |
| `source.path` | string | if source | Path from repo root |
| `source.line_start` | int | if source | First line |
| `source.line_end` | int | no | Last line, where known |
| `source.hash` | string | if source | Hash of the defining source span. Drives `modified` detection |
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
  "source": {
    "repo": "tapistree",
    "path": "api/routers/notes.py",
    "line_start": 42, "line_end": 58,
    "hash": "sha256:9f2c…"
  },
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
`module`, `service`

`kind` is what a node *is*, and drives hue. It is distinct from `tier`, which
drives position — a `function` may sit in `domain` or in `data_access`.

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

---

## 3. Edge

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable across parses given identical endpoints and kind |
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
| `source` | object \| null | yes | Where the call site lives. Same shape as node `source` |
| `is_broken` | bool | yes | Previously resolved, no longer does. See §5.1 |
| `broken_reason` | string \| null | if broken | Explanation shown on the warning icon |
| `skips_tiers` | string[] | yes | Bands bypassed. Empty for normal edges. See §3.3 |

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
  "source": { "repo": "tapistree", "path": "ios/Services/NoteService.swift", "line_start": 88 },
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
| `source_line` | int | no | Where it appears |

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

**Default selection.** Within an `exclusive_group`, the animation picks:

1. The first edge with `is_error_path: false`, ordered by `source.line_start`.
2. Failing that (every branch is an error path), the lowest `source.line_start`.

Deterministic, so nothing about the choice is persisted — it recomputes
identically every parse. Overriding it is a UI concern; see UI spec §7.5.

**What this cannot tell you.** If a threshold decides between two endpoints, the
map shows both branches correctly even when the value feeding the comparison is
wrong. The plumbing is intact; the water may still go down the wrong pipe. The
tool also has no interpreter, so a branch is *chosen*, never *evaluated* — the
choice is a legible default, not a claim about what would really happen.

**Rendering:** conditions do not use line style, which is reserved exclusively for
confidence (§5). An edge may be both `inferred` and conditional. Conditions render
as a text label plus a fork marker at the branch point.

### 3.3 `skips_tiers`

Populated when an edge jumps more than one band — a `ui_view` writing straight to
a collection, say. Suspicious by default, so it can be badged and counted with no
extra config. Also the basis for a coupling metric: count edges crossing distant
parts of the tree and watch whether that number grows.

---

## 4. Schema

Payload shapes are separate entities referenced by id, so one Pydantic model
isn't duplicated across forty edges and a classification change is a single edit.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable id |
| `name` | string | yes | Type name as written in source |
| `source` | object \| null | yes | Where the type is defined |
| `confidence` | enum | yes | Per §5 |
| `fields` | Field[] | yes | May be empty for opaque payloads |

**Field:**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Field name |
| `type` | string | yes | Type as written in source |
| `optional` | bool | yes | Whether it may be absent |
| `classification` | string[] | yes | What the field *is*. May be empty |
| `ref_schema_id` | string \| null | no | Set when the field is itself a schema |

```jsonc
// ILLUSTRATIVE ONLY
{
  "id": "sch_note_update_req",
  "name": "NoteUpdateRequest",
  "source": { "repo": "tapistree", "path": "api/models/note.py", "line_start": 12 },
  "confidence": "certain",
  "fields": [
    { "name": "note_id", "type": "str",       "optional": false, "classification": ["identifier"] },
    { "name": "body",    "type": "str",       "optional": false, "classification": ["free_text", "may_contain_pii"] },
    { "name": "tags",    "type": "list[str]", "optional": true,  "classification": [] },
    { "name": "author",  "type": "UserRef",   "optional": false, "classification": [], "ref_schema_id": "sch_user_ref" }
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

---

## 7. Graph metadata

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema_version` | int | yes | Bump on breaking model changes |
| `parsed_at` | ISO 8601 | yes | When this graph was produced |
| `repos` | Repo[] | yes | Always a list, even at length one |
| `repos[].name` | string | yes | Used in node ids |
| `repos[].path` | string | yes | Local checkout path |
| `repos[].commit` | string | yes | Hash, for reproducibility |
| `repos[].dirty` | bool | yes | Uncommitted changes present |
| `tier_config_hash` | string | yes | Invalidates layout when tiers change |
| `stats` | object | no | Counts, including breakdown by confidence |

`dirty` flags the "map as it *would* be" case — pointing the tool at a working
tree to see a change's effect before opening a pull request.

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
personal rather than shared. An earlier draft of this section had positions and
config sharing one committed file; see persisted-files spec §0 for why that was
wrong.

---

## 9. Derived, never stored

Computed at render time:

- **`change_state`** — `unchanged` \| `modified` \| `new` \| `removed`, computed
  against `baseline.json`. Derivation table lives in persisted-files spec §1.5.
  It must **not** be derived from the absence of a saved position; that coupled
  diff detection to layout storage and broke once layout became personal.
- **Default branch selection** at each `exclusive_group`, per §3.2. Deterministic
  from `is_error_path` and source line, so never persisted.
- **Aggregated edges** for zoomed-out views — forty calls to Mongo become one
  thick line, and the animation shows one object moving rather than forty.
- **Reachable set** from an entry point — the "blast radius" driving flow mode.
- **Offscreen indicator counts** — shallow count at the current level, with change
  state inherited from the most significant nested descendant.

---

## 10. Open questions

- ~~Do conditional-edge dashes collide with confidence dashes?~~ **Resolved:**
  line style is confidence only; conditions get a label and fork marker.
- ~~Does `condition` earn its keep, if nearly every edge is conditional?~~
  **Resolved:** yes, but for a different reason than originally written. It is
  fork *labelling*, and the fork model needs `exclusive_group` alongside it to be
  useful at all. See §3.2.
- How reliable is `is_error_path` detection across Swift and Python? A `guard`
  with an early return, a `raise`, and a returned error response all need
  recognising. Parser spec should treat this per-language.
- Is a string enum enough for `tier`, or does it need a first-class entity?
- Aggregated edge confidence: does one `inferred` child make the rolled-up edge
  `inferred`, or does the majority win?
- Edge `id` stability: derived by hashing `from` + `to` + `kind`, or persisted?
  Matters if edges ever carry annotations of their own.
