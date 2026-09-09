# Persisted Files Spec

Files live in `.waterslide/`. They are split by *who writes them* and *who they
belong to* — not by topic.

The who-writes-them line matters because a tool that rewrites a file also holding
hand-authored config will eventually clobber comments and formatting, and then
you stop trusting it. The who-owns-them line matters because layout is personal:
forcing one shared arrangement means your tidy-up of the payment flow overwrites
mine, and neither of us can arrange the map for the question we're currently
asking.

| File | Written by | Committed | Purpose |
|---|---|---|---|
| `annotations.yaml` | Humans | **Yes** | Facts the parser cannot derive |
| `config.yaml` | Humans | **Yes** | Tiers, infrastructure markers, policy, DI resolution |
| `layout.json` | Humans (publish action) | **Yes** | *Optional* shared layout to adopt as a starting point |
| `positions.json` | The tool | No | Personal node coordinates |
| `baseline.json` | The tool | No | Last-parsed node ids and hashes. Drives change state |

Also generated and gitignored: `graph.json`, `cache/`.

**Naming note:** you picked "tiers" for the third file. I've broadened it to
`config.yaml` because infrastructure markers, policy regimes and DI resolution
are also hand-written config rather than facts, and they don't belong in the
annotations bucket. If you'd rather keep them separate, split later — but the
hand-written/machine-written line is the one worth defending.

Generated artefacts (`graph.json`, `cache/`) stay gitignored.

---

## 1. `positions.json` — machine-written, local

Purely presentational. Gitignored. Losing it costs you nothing but your manual
tidying, and the map still renders correctly from auto-layout.

**Correction to graph model §9:** change state must *not* be derived from the
absence of a saved position. That coupled diff detection to layout storage, which
only works if positions are shared and authoritative. Change state comes from
`baseline.json` instead — see §1.5.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema_version` | int | yes | Bump on breaking changes |
| `positions` | object | yes | Map of node id → coordinate |
| `positions[id].x` | number | yes | Horizontal position within band |
| `positions[id].y` | number | no | Vertical. Usually derived from tier; set only if nudged |
| `positions[id].pinned` | bool | yes | True when a human placed it. Auto-layout must not move it |

```jsonc
// ILLUSTRATIVE ONLY
{
  "schema_version": 1,
  "positions": {
    "myrepo:api/routers/notes.py#update_note": { "x": 420, "y": null, "pinned": true },
    "mongo:myrepo.notes":                      { "x": 380, "y": null, "pinned": false }
  }
}
```

**Requirements:**

- `pinned: false` entries are auto-placed and may be recomputed freely. Only
  `pinned: true` is sacred.
- Unknown node ids are ignored silently. Unlike annotations, a stale position is
  harmless and needs no remedy UI.
- No merge strategy needed — the file is never shared.

### 1.5 `baseline.json` — change detection

Machine-written, gitignored, personal. A snapshot of the previous parse used
solely to compute change state.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema_version` | int | yes | Bump on breaking changes |
| `captured_at` | ISO 8601 | yes | When the snapshot was taken |
| `repos` | BaselineRepo[] | yes | `{ name, commit }` per repo at snapshot time. **Deliberately narrower** than graph model §7's `Repo`, and a separate type: the baseline never needs `path` or `dirty`, and keeping it distinct means widening it later is a baseline change, not a graph contract change |
| `nodes` | object | yes | Map of node id → `{ baseline_hash, label, tier }` |
| `edges` | string[] | yes | Edge ids present at snapshot time |

`label` and `tier` are stored so a tombstone node can be reconstructed when an
edge breaks (graph model §5.1). Without them a tombstone would have no name and
nowhere to sit.

#### Every node needs a baseline hash, including source-less ones

`modified` was originally defined against a single `source.hash`, but not every node has a
source. A Mongo collection, an external service surface and a tombstone all carry
`sources: []`, so they could never be classified.

**`baseline_hash` is defined for every node kind:**

| Node has | `baseline_hash` is |
|---|---|
| `sources` non-empty | Hash over every span's `hash`, taken in canonical span order (graph model §7.2). A change in *any* defining file marks the node modified, where a single-source hash would have missed a change in a secondary file |
| `sources` empty | Hash of the node's identity-bearing fields: `id`, `kind`, `label`, `tier` |

A synthetic node is therefore `modified` when its label or tier changes — a
collection that moves band because config changed, say — and `unchanged`
otherwise. That is the correct behaviour: nothing about a collection can change
except how the tool describes it.

Derivation, replacing graph model §9:

| Condition | State |
|---|---|
| **No baseline file exists** | Every node `unchanged`. See below |
| Node id absent from baseline | `new` |
| Present, `baseline_hash` differs | `modified` |
| Present, `baseline_hash` matches | `unchanged` |
| In baseline, absent from current graph | `removed` |

**The first row is a whole-graph short-circuit, evaluated before any per-node
rule.** With no baseline there is nothing to compare against, so the per-node
rules never run — which is why "absent from baseline" does not make everything
`new` on a fresh clone. The distinction is between *no baseline* and *a baseline
that doesn't contain this node*:

| Situation | Result |
|---|---|
| No baseline file at all | Everything `unchanged`. The map is a starting point, not a diff |
| Baseline exists, node absent from it | That node is `new` |

Without the short-circuit, a fresh clone would render every node as new, which
carries no information and makes the change encoding useless on first use.

Edge ids in the baseline are what make `is_broken` detectable: an edge that was
present and now isn't, where both endpoints still exist, is a severed link rather
than a deletion.

**Because the baseline is personal, change state means "new since *I* last
looked"** — which is more useful than "new since anyone last parsed".

### 1.6 Parsing must never write the baseline

**Correction to parser pipeline §0**, which listed stage 6 as "write
`graph.json`, update `baseline.json`". It must write only `graph.json`.

If every parse refreshed the baseline, the baseline would always equal the
current graph and every node would be `unchanged` forever. Change state would be
permanently empty. The whole feature would silently do nothing, which is the
worst possible failure — it looks like a working map with no changes in it.

**Capturing a baseline is a separate, explicit action.**

| Trigger | Behaviour |
|---|---|
| `waterslide parse` | Reads the baseline. Never writes it |
| `waterslide baseline` (or a UI "mark as seen" button) | Overwrites the baseline from the current graph |
| No baseline file present | Parse proceeds; everything `unchanged` per the short-circuit above |

The mental model is marking email as read. Reading changes nothing; you say when
you're done.

Consequence worth stating: the baseline can be arbitrarily old, and that's fine.
"What's changed since I last looked" is exactly what you want when you last
looked three weeks ago.

The baseline updates on an explicit action, not on every parse. Otherwise
re-parsing twice in a row silently erases the diff you were about to look at.

### 1.6 `layout.json` — optional shared layout

Committed, but written only by an explicit **publish layout** action. Never
touched by ordinary node dragging.

Purpose: someone arranges the payment flow legibly and publishes it, so others
can adopt that arrangement as a starting point. Same shape as `positions.json`.

Precedence: personal `positions.json` wins over `layout.json`, which wins over
auto-layout. Two actions are offered — *adopt shared layout* (copies into
personal positions) and *reset to shared* (discards personal overrides).

Shared layout is opt-in, never imposed.

---

## 2. `annotations.yaml` — hand-written facts

Only for things the parser genuinely cannot see. Everything here produces graph
entities with `confidence: annotated`.

### 2.1 Manual edges

| Field | Type | Required | Meaning |
|---|---|---|---|
| `from` | string | yes | Node id |
| `to` | string | yes | Node id |
| `kind` | enum | yes | Per graph model §3.1 |
| `reason` | string | yes | Why the parser couldn't see it. Becomes `confidence_reason` |
| `schema_id` | string | no | Payload, if known |

### 2.2 Field classification overrides

Preferred home for classification is a Pydantic `Field` annotation next to the
type, so it versions with the model. This section is the fallback for Swift
structs, third-party types, and anything not expressible in source.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema` | string | yes | Schema name or id |
| `field` | string | yes | Field name |
| `classification` | string[] | yes | Labels per graph model §4.1 |

### 2.3 Notes

Free-text annotation pinned to a node, shown on click. No semantics, just
context for whoever reads the map next.

```yaml
# ILLUSTRATIVE ONLY
manual_edges:
  - from: "myrepo:api/workers/registry.py#register_all"
    to:   "myrepo:api/workers/reindex.py#handle_reindex"
    kind: call
    reason: "handlers registered by directory scan at startup; no literal keys"

classifications:
  - schema: NoteSummaryRequest
    field: body
    classification: [free_text, may_contain_pii]

notes:
  - node: "mongo:myrepo.embeddings"
    text: "Vectors only. Source text lives in notes collection."
```

---

## 3. `config.yaml` — hand-written config

### 3.1 Tiers

Declared tier assignment always wins over the default inferred from `kind`.
Matched by path glob, first match wins.

```yaml
# ILLUSTRATIVE ONLY
tiers:
  order: [ui, ui_logic, api, domain, data_access, store]
  external_column: right
  assign:
    - { glob: "ios/Views/**",        tier: ui }
    - { glob: "ios/Services/**",     tier: ui_logic }
    - { glob: "api/routers/**",      tier: api }
    - { glob: "api/services/**",     tier: domain }
    - { glob: "api/repositories/**", tier: data_access }
```

### 3.2 Infrastructure markers

Sets `is_infrastructure: true`, making nodes eligible for middleware collapse.
Never inferred — always declared.

```yaml
infrastructure:
  - { glob: "api/middleware/**" }
  - { glob: "api/deps/auth.py" }
```

### 3.3 Expected middleware

The inverted check, and the more valuable half. Declares what *must* be present,
so an endpoint missing it gets flagged — an agent adding a route and forgetting
the auth decorator is exactly the case that survives review.

```yaml
expected_middleware:
  - applies_to: { glob: "api/routers/**" }
    require: [auth, request_logging]
    severity: warn
```

Declarative rules beat majority-inference: "every route under `/api` requires
auth" is a rule, not a guess about what most routes happen to do.

**`require` names need defining.** `auth` is a logical capability, and what
satisfies it (a `Depends` argument, a decorator, an upstream middleware node) is
framework-specific. That mapping lives in a `capabilities` block — see policy
checks spec §2.1. Per-route exemptions also live in this rule; see §2.4 there.

### 3.4 DI and implementation resolution

Resolves an interface to the concrete implementation that's live under a given
config, producing `confidence: inferred` edges with the config file as the reason.
Multiple named profiles can be held and switched between, so you can watch the
active path change without re-parsing.

```yaml
resolutions:
  - profile: production
    bind:
      - { interface: "EmbeddingProvider", to: "CohereEmbedder" }
  - profile: local
    bind:
      - { interface: "EmbeddingProvider", to: "StubEmbedder" }
```

### 3.5 Policy regimes

Maps neutral classification labels to rules. Switching regime re-colours the map;
it never requires re-annotating fields.

```yaml
policy:
  active: gdpr
  regimes:
    gdpr:
      flag_on_egress: [name, email, identifier, may_contain_pii]
    hipaa:
      flag_on_egress: [health_data, identifier, name]
```

---

## 4. Stale references

An annotation can reference a node that no longer exists. This is surfaced
prominently but **never blocks** — parsing completes, the map renders, the graph
is usable.

### 4.1 Two causes, different remedies

| Cause | What happened | Useful remedy |
|---|---|---|
| **Gone** | Function deleted, topic removed | Delete the annotation, or keep it (mid-refactor) |
| **Moved** | Node still exists under a new id — renamed or moved file | Re-point the annotation |

The tool cannot tell these apart, since rename detection is out of scope. So it
presents both sets of remedies and lets the human decide.

### 4.2 Presentation

- Rendered as an obvious icon and colour treatment on the affected node or edge,
  reading clearly as "click me".
- Not a modal, not a blocking prompt, not a console warning that scrolls past.
- Clicking opens a remedy list.

### 4.3 Remedies

| Remedy | Effect |
|---|---|
| Delete annotation | Removes the entry from `annotations.yaml` |
| Keep and silence | Marks it `expected_missing`, suppressing the icon until the target reappears |
| Re-point | Opens a **plain search** over all node ids; picking one rewrites the reference |

Re-point via plain search — no fuzzy name-match suggestions, which would be
confidently wrong often enough to erode trust. The human does the matching; the
tool just makes it fast.

This quietly gives you rename recovery without building rename detection.

### 4.4 Why non-blocking matters

A stale annotation is the kind of thing that silently makes the map wrong, so it
must be visible. But blocking on it would make the tool obstructive during exactly
the refactors where you most want to look at the map. Visible plus optional means
annotations get pruned as a side effect of using the tool, rather than as a chore.

---

## 5. Open questions

- ~~Should `positions.json` be committed?~~ **Resolved: no.** Layout is personal;
  shared layout is opt-in via `layout.json`.
- ~~What action updates the baseline — a button, or automatically on commit?~~
  **Resolved: an explicit action, and never a side effect of parsing.** See §1.6.
- ~~Does `expected_middleware` need per-route exemptions, or is a narrower glob
  always enough?~~ **Resolved: yes, inline in the rule**, with a mandatory reason.
  A narrower glob hides the decision; an exemption with a reason is reviewable in
  a pull request. See policy checks spec §2.4.
- Where does `expected_missing` state live — in `annotations.yaml` next to the
  entry, or in a separate suppression list?
