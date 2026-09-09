# Valid fixtures

Hand-written graphs in **canonical form** (graph model §7.2): key order, array
sort order, NFC and whitespace are all load-bearing, because the round-trip test
compares `serializeCanonical(validate(file))` to the file bytes. Do not reformat.

| File | Exercises |
|---|---|
| `derived-ids.json` | Two repos; every edge id derived by `edgeId`; a fork pair on one branch point; an inferred cross-language `http_request`; an `external_call` collapsing two call sites; an inferred `write` |
| `single-repo-minimal.json` | One repo; `svc:` and `sql:` scopes alongside `mongo:` and `{repo}:`; a `service` parent; a band-skipping `call` (api → data_access, skipping `domain`); a non-null `ref_schema_id`; an `inferred` schema with its reason; a `function` placed in `tier: external` by config with an ordinary edge and empty `skips_tiers` (invariant 16's fourth branch) |
| `tombstone-broken-edge.json` | A `tombstone` target with a broken edge into it, and a broken edge whose target still exists (graph model §5.1) |
| `annotated-edge.json` | An `annotated` edge with `source: null` and `source_count: 0`; a `topic` node with a `subscribe` out and a `publish` in; a self-loop `call` (recursion is legal); non-ASCII labels and tags for the escaping and NFC rules |
| `band-skip.json` | A `ui_view` writing straight to a collection: `skips_tiers` spanning four bands, the positive case for invariant 11 |
| `split-definition.json` | A Swift `class` declared in `Models/Note.swift` and extended in `Extensions/Note+JSON.swift`: one node with two `sources` in canonical span order, the motivating case for `sources[]` |
