# @waterslide/pack-python

The Python language pack plus its FastAPI framework recognizer (handoff §6,
parser pipeline §3, §6, §8). Called once per file with
`(repo, path, content, options)`; returns the five contract items — `nodes`,
`edges`, `schemas`, `provides`, `diagnostics` — and never throws.

## Layout

| Path                                   | What                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                         | `pack` (named export), `createPythonPack`, `manifest`. Wires language → recognizers → emit.                                       |
| `src/tree-sitter/runtime.ts`           | web-tree-sitter init, the Python grammar, `.scm` query loading, node helpers.                                                     |
| `queries/*.scm`                        | Every tree-sitter query. No query text lives in code (handoff §2).                                                                |
| `src/language/`                        | **Language recognition only**: imports and aliases, definitions, scopes, `self`, call sites, branch limbs, `is_error_path`.       |
| `src/frameworks/fastapi/`              | Routes, routers, `include_router` mounts, `Depends`, startup and middleware; `compose.ts` does cross-file prefix composition.      |
| `src/frameworks/{pydantic,mongo,external}.ts` | Pydantic schemas, Motor collection access, vendor SDK calls (Anthropic, Cohere, Voyage, boto3).                              |
| `data/*.json`                          | The `is_error_path` construct table, vendor table, Mongo read/write table, builtins and stdlib lists. Validated on load.           |
| `test/support/resolver.ts`             | **Test-only** stage-4 stand-in, fenced per decision item 8. Never ships.                                                          |
| `scripts/run-tree.ts`                  | Run the pack over a directory and print the M1 gate report.                                                                       |

Language recognition and framework recognition are separate on purpose: a
recognizer reads the `FileModel` and writes through the `Emitter`; it never
re-parses and never changes an id. Adding Django is one more directory under
`src/frameworks/` and one entry in `RECOGNIZERS`.

## What the pack resolves, and what it leaves to stage 4

Inside the file (parser §3.5): import aliases (`import x as y`, `from x import y as z`),
bare from-imported names, module-level and local constructor bindings,
`self.<attr>` through `__init__` assignments and annotations, factory return
annotations, dispatch tables with literal keys. Every imported binding also
becomes a file-scoped alias `provides` entry (§3.4), and every module-level
import a global re-export alias (so `auth.get_current_user` reaches
`auth.oauth2.get_current_user`).

Everything else leaves as an `UnresolvedRef`:

| `ref_kind`  | `value`                                       | notes                                                                                              |
| ----------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `symbol`    | alias-resolved qualified name                 | `get_svc().run` when the receiver is a call whose return type is not visible here ; the reason names the call |
| `datastore` | collection attribute (`db.notes` → `notes`)   | `hints: { operation, store: "mongo", namespace: null }`; always `inferred`; the pack never mints `mongo:`; a method outside the read/write table goes out without hints plus a diagnostic |
| `external`  | `vendor/surface`, e.g. `anthropic/messages`   | `certain` when the receiver traces to an SDK constructor in the same file                          |
| `topic`     | SQS `QueueUrl` literal, or its expression     | `publish` edge; non-literal names stay unresolved, never guessed                                   |

Standard-library and builtin calls are skipped silently: they are not on the map.
Exceptions constructed under `raise` are not call sites.

## Route composition

Per file: the handler node becomes an `endpoint` entry point with the **local**
decorator path in its label, a `route` edge links it to its router node, and
each `include_router(...)` becomes a mount edge. The facts compose needs — a
route's methods and local path, a router's own prefix, a mount's prefix — travel
in `pack_data.fastapi` (typed by `FastApiPackDataSchema`), never in label text;
`fastapi:app`, `fastapi:router` and `fastapi:route` remain as filter tags. Core
strips `pack_data` after compose.
`compose(results, options)` then walks mounts from every `FastAPI()` app,
resolves imported router names through the pack's own `provides` (alias chains
included, PEP 562 `__getattr__` maps too), rewrites labels to the composed path,
and emits one `http` provide per method: `{ ref_kind: "http", name: "PUT /api/notes/{id}" }`.
Ids never change. An unmounted or unresolvable router is diagnosed, not guessed.

## Running it

```sh
npx --yes tsx --tsconfig packs/python/tsconfig.json packs/python/scripts/run-tree.ts \
  ~/Code/tapistree --repo tapistree --root server --only server/ --out /tmp/graph.json
```

Prints node and edge counts, entry points, the validator verdict, diagnostics by
code, and every unresolved reference grouped by `ref_kind` — the coverage metric
from handoff §6 item 6. `npm test` runs the same gate against a `../tapistree`
checkout when one is present (`WATERSLIDE_TAPISTREE=/path` overrides).
