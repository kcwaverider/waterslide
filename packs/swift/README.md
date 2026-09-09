# @waterslide/pack-swift

Swift language pack with SwiftUI and URLSession framework recognizers
(parser pipeline §3, §7). Emits the five contract returns per file, plus a
cross-file `compose` pass for extensions and helper-routed URL reconstruction.

## Layout

| Path | What |
|---|---|
| `grammar/tree-sitter-swift.wasm` | Pinned grammar (0.7.3, from the grammar's GitHub release). Sidecar `.wasm.json` records version, source URL and sha256; `npm run grammar:fetch -w @waterslide/pack-swift` refetches and verifies |
| `queries/*.scm` | Every tree-sitter query. Never string literals in code (handoff §2) |
| `data/error-paths.json` | The Swift `is_error_path` construct table (parser §6.2). Data, not code |
| `src/analyze.ts` | Per-file pass: `(repo, path, content)` → `PackResult` + pack-private state |
| `src/recognizers/declarations.ts` | Types, functions, extensions, imports, typealias, Codable schemas, provides |
| `src/recognizers/scope.ts` | Local scope, `self` context, receiver typing; unresolved chains for compose |
| `src/recognizers/calls.ts` | Call sites → in-file edges or cross-file candidates |
| `src/recognizers/network.ts` | URL/URLRequest reconstruction, direct sends, the 2-hop helper walk |
| `src/recognizers/swiftui.ts` | `ui_handler` entry points: the §7 modifiers plus decisions item 9 |
| `src/recognizers/branches.ts` | Forks: `exclusive_group`, `branch_ordinal`, `condition`, `is_error_path` |
| `src/compose.ts` | Cross-file pass (item 1): extension merge, candidate resolution, `client_service` |
| `src/repath.ts` | `rePath` for cache hits on moved files (amendment B3) |
| `src/state.ts` | The JSON-serializable per-file state compose consumes; cache it with the result |
| `scripts/run.ts` | Dev driver: walk a tree, parse, compose, assemble, validate, print the summary |
| `scripts/ensure-core-shim.mjs` | Temporary: core's package exports point at a file its build does not emit |

## Running against a tree

```bash
npx tsc -b && node packs/swift/scripts/ensure-core-shim.mjs
node packs/swift/dist/scripts/run.js --repo tapistree --path ~/Code/tapistree/iOS --out /tmp/swift.json
node packs/swift/dist/scripts/run.js --repo tapistree --path ~/Code/tapistree/iOS --shuffle 42 --quiet
```

The driver prints the per-run summary (handoff §6 item 6): HTTP call sites
with and without a resolved path, every `UnresolvedRef` grouped by `ref_kind`,
what was not drawn and why, and the diagnostics by code. Stand-in target nodes
for unresolved refs are minted by the driver only; core mints the real
`unknown` nodes at stage 4.

## What is not drawn, deliberately

- Calls on receivers whose type is not declared in any file of the pack
  (SwiftUI, Foundation, other packages). Counted per file in an
  `external_type_reference` diagnostic and in the summary.
- Closure invocations, implicit member calls (`.success(x)`), and calls whose
  receiver type the file cannot determine. Each has its own `info` code.
- A construction whose value feeds a call (`Endpoint(path:)` handed to
  `request`) carries no edge of its own; the call it feeds carries the
  reconstructed `http` edge.

## Known gaps

- **Grammar.** tree-sitter-swift 0.7.3 cannot parse `await` inside an
  `if let` / `while let` condition, and its recovery flattens the enclosing
  type. `parser.ts` retries such files with `await` blanked to spaces (same
  offsets) and reads node text from the original; a `grammar_workaround`
  diagnostic records it. Remaining `syntax_error` diagnostics are genuine
  grammar gaps (operator continuation lines, `as? [K: V] ?? [:]`).
- **Visibility.** Access modifiers only; no module boundary (parser §10 open
  question). `project.pbxproj` is not read.
- **Protocol-typed receivers.** `provider.load()` with `provider: Providing`
  emits a symbol ref to `Providing.load`; conformers are not fanned out.
