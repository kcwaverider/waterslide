# Malformed fixtures

Every file here is **deliberately invalid**. Each breaks exactly one rule so the
validator can be tested against known-bad input with a specific expected error.
`expected.json` maps each file to the error code and JSON path the validator must
report; the test in `core/test/validate.test.ts` asserts both.

All but `not-an-object.json` are single mutations of `fixtures/valid/derived-ids.json`.
Their edge ids are therefore not re-derived after mutation, which is fine: the
validator checks uniqueness and resolution, not derivation (graph model §3.3.1).

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
| `tombstone-with-source.json` | `E_TOMBSTONE_SOURCE` | tombstone node that still carries a source (invariant 10) |
| `missing-key.json` | `E_MISSING_KEY` | broken_reason key omitted instead of null (invariant 12, §2.5) |
| `source-count-mismatch.json` | `E_SOURCE_COUNT` | source non-null but source_count 0 (invariant 13) |
| `branch-ordinal-without-group.json` | `E_BRANCH_ORDINAL` | branch_ordinal set on an edge with no exclusive_group (invariant 14) |
| `duplicate-branch-ordinal.json` | `E_BRANCH_ORDINAL_DUPLICATE` | two alternatives in one exclusive_group share branch_ordinal 0 (invariant 15) |
| `skips-tiers-into-external.json` | `E_SKIPS_TIERS_EXCLUDED` | external_call edge with non-empty skips_tiers; external is not a depth (invariant 16) |
| `wrong-schema-version.json` | `E_SCHEMA_VERSION` | schema_version 2 against a version 1 model; must fail loudly (handoff §5.2) |
| `canonical-with-volatile.json` | `E_VOLATILE_SHAPE` | parsed_at present in a graph validated as canonical shape (graph model §7.3) |
| `line-start-zero.json` | `E_TYPE` | line_start 0; line numbers are 1-based, so the model's positive lower bound rejects it |
| `unknown-key.json` | `E_UNKNOWN_KEY` | node carries a key the model does not define |
| `not-an-object.json` | `E_NOT_OBJECT` | a JSON array, not a graph object |
