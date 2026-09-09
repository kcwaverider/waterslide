# Malformed fixtures

Every file here is **deliberately invalid**. Each breaks exactly one rule so the
validator can be tested against known-bad input with a specific expected error.
`expected.json` maps each file to the error code and JSON path the validator must
report; the test in `core/test/validate.test.ts` asserts both.

Most are a single mutation of `fixtures/valid/derived-ids.json`; a few start
from other valid fixtures (`skips-tiers-into-topic`, `skips-tiers-into-tombstone`,
`tombstone-certain`, `duplicate-skips-tier`, and the three multi-span cases built
from `split-definition.json`), and a few carry a
second edit whose only purpose is to keep every *other* invariant satisfied, so
that exactly one rule fails (`fork-without-source.json` also zeroes
`source_count`; `tombstone-with-source.json` also sets an inferred confidence;
the id-scope files rename references and re-sort). Edge ids are not re-derived
after mutation, which is fine: the validator checks uniqueness and resolution,
not derivation (graph model §3.3.1).

Each fixture produces **exactly one** validator error, asserted by the test. No
two fixtures share the same error code and JSON path, with one allowlisted
exception: `skips-tiers-into-tombstone.json` and `skips-tiers-external-tier.json`
both report `E_SKIPS_TIERS_EXCLUDED` at `$.edges[0].skips_tiers`. They are
different branches of invariant 16 built from different base graphs, and the
coincidence of index is not worth breaking either fixture to avoid.

| File | Expected code | What is wrong |
|---|---|---|
| `duplicate-node-id.json` | `E_DUPLICATE_ID` | second node repeats the first node's id (invariant 1) |
| `edge-endpoint-unresolved.json` | `E_EDGE_ENDPOINT` | edge points at a node id that does not exist (invariant 2) |
| `parent-unresolved.json` | `E_PARENT` | node's parent id does not exist (invariant 3) |
| `schema-ref-unresolved.json` | `E_SCHEMA_REF` | edge schema_id names a schema that is not in the graph (invariant 4) |
| `ref-schema-id-unresolved.json` | `E_SCHEMA_REF` | field ref_schema_id names a schema that is not in the graph (invariant 4) |
| `illegal-node-kind.json` | `E_ILLEGAL_ENUM` | node kind 'widget' is not in the enum (invariant 5) |
| `illegal-skips-tier.json` | `E_ILLEGAL_ENUM` | skips_tiers contains 'basement', not a tier (invariant 11) |
| `missing-confidence-reason.json` | `E_CONFIDENCE_REASON` | inferred node with confidence_reason null (invariant 6) |
| `entry-point-without-kind.json` | `E_ENTRY_POINT_KIND` | is_entry_point true with entry_point_kind null (invariant 7) |
| `broken-without-reason.json` | `E_BROKEN_REASON` | is_broken true with broken_reason null (invariant 8) |
| `fork-without-source.json` | `E_FORK_SOURCE` | edge in an exclusive_group with source null (invariant 9) |
| `tombstone-with-source.json` | `E_TOMBSTONE_SOURCE` | tombstone node that still carries a defining span (invariant 10) |
| `missing-key.json` | `E_MISSING_KEY` | broken_reason key omitted instead of null (invariant 12, §2.5) |
| `source-count-mismatch.json` | `E_SOURCE_COUNT` | source non-null but source_count 0 (invariant 13) |
| `branch-ordinal-without-group.json` | `E_BRANCH_ORDINAL` | branch_ordinal set on an edge with no exclusive_group (invariant 14) |
| `duplicate-branch-ordinal.json` | `E_BRANCH_ORDINAL_DUPLICATE` | two alternatives in one exclusive_group share branch_ordinal 0 (invariant 15) |
| `skips-tiers-into-external.json` | `E_SKIPS_TIERS_EXCLUDED` | external_call edge with non-empty skips_tiers; external is not a depth (invariant 16) |
| `wrong-schema-version.json` | `E_SCHEMA_VERSION` | schema_version 2 against a version 1 model; must fail loudly (handoff §5.2) |
| `canonical-with-volatile.json` | `E_VOLATILE_SHAPE` | parsed_at present in a graph validated as canonical shape (graph model §7.3) |
| `line-start-zero.json` | `E_RANGE` | line_start 0; line numbers are 1-based, so the model's positive lower bound rejects it |
| `line-end-before-start.json` | `E_RANGE` | a span whose line_end precedes its line_start; a pack must not repair this with null (invariant 21) |
| `span-repo-unknown.json` | `E_SOURCE_REPO` | a node span whose repo is not in repos[]; invariant 19 applies per element of sources |
| `tombstone-certain.json` | `E_TOMBSTONE_CONFIDENCE` | a tombstone claiming confidence certain; it appears nowhere in source, so it is always inferred (invariant 22) |
| `duplicate-skips-tier.json` | `E_DUPLICATE_VALUE` | skips_tiers lists domain twice; the coupling metric would count one skip as two, so duplicates are rejected rather than deduplicated (invariant 23) |
| `unsorted-edges.json` | `E_CANONICAL_ORDER` | edges[0] and edges[1] swapped; canonical shape requires byte-wise ascending id order (invariant 17) |
| `unsorted-tags.json` | `E_CANONICAL_ORDER` | tags out of ascending order; scalar arrays are sorted in canonical shape (invariant 17) |
| `non-nfc-string.json` | `E_CANONICAL_NFC` | label contains a decomposed (NFD) character; canonical shape requires NFC (invariant 17) |
| `illegal-id-scope.json` | `E_ID_FORMAT` | node id scope 'widget' is neither a fixed scope nor a repo name; the edge to it is updated so only invariant 18 fires |
| `id-path-mismatch.json` | `E_ID_FORMAT` | repo-scoped node whose source.path disagrees with the path in its id (invariant 18) |
| `repo-named-after-scope.json` | `E_ID_FORMAT` | a repo named 'sql' collides with a fixed id scope (invariant 18); node ids and sources are renamed with it so nothing else fires |
| `skips-tiers-into-topic.json` | `E_SKIPS_TIERS_EXCLUDED` | publish edge into a topic with non-empty skips_tiers; a topic is transport, not depth (invariant 16) |
| `skips-tiers-into-tombstone.json` | `E_SKIPS_TIERS_EXCLUDED` | broken edge into a tombstone with non-empty skips_tiers; the edge is already flagged is_broken (invariant 16) |
| `skips-tiers-external-tier.json` | `E_SKIPS_TIERS_EXCLUDED` | target is a repository placed in tier external by config, not an external_service; external is not a depth whatever the kind (invariant 16) |
| `source-repo-unknown.json` | `E_SOURCE_REPO` | edge source.repo names a repo that is not in repos[] (invariant 19) |
| `duplicate-repo-name.json` | `E_DUPLICATE_ID` | repos[] lists the same repo name twice (invariant 1) |
| `self-parent.json` | `E_PARENT_CYCLE` | a node whose parent is itself; the parent chain must be a tree (invariant 20) |
| `unsorted-sources.json` | `E_CANONICAL_ORDER` | two spans equal on repo, path and line_start are ordered by line_end descending; the span sort key is total (invariant 17, §7.2) |
| `second-span-repo-unknown.json` | `E_SOURCE_REPO` | a multi-span node whose last span names a repo not in repos[] (named to sort last); invariant 19 applies to every element, not only sources[0] |
| `no-span-matches-id-path.json` | `E_ID_FORMAT` | a multi-span node where no span's path is the path in the id; the id must name the declaring file (invariant 18) |
| `wrong-type.json` | `E_TYPE` | is_entry_point is the string "yes" instead of a boolean |
| `unknown-key.json` | `E_UNKNOWN_KEY` | node carries a key the model does not define |
| `not-an-object.json` | `E_NOT_OBJECT` | a JSON array, not a graph object |
