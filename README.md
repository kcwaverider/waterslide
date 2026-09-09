# waterslide

A static-analysis tool that renders a codebase as an **animated data flow map** —
front end through API and business logic to the datastore and back out.

Pick something a user can do. Watch the data travel.

**Status: in development.** The design is complete and lives in [`docs/`](./docs).
The parser, the cross-language resolver and a first renderer run today; see
Usage. Persistence, the committed config file and the policy checks are still
to come.

---

## Why

When most of your code is written by an agent, you stop reading all of it. A diff
tells you what changed; it doesn't tell you what the change did to the shape of
the system.

waterslide answers three questions:

- **Comprehension** — how does this work, given I didn't write it?
- **Change impact** — what does my next change touch?
- **Maintainability** — is this organised in a way that survives the next quarter
  of road map?

It reads **source and config only**. Nothing is executed, nothing is
instrumented, no running system is observed. That means it can tell you the
plumbing is intact, and can't tell you whether the water goes down the right
pipe.

## What makes it different

Most code visualization produces a static diagram. Most animated flow
visualization — service maps, traffic graphs — is fed by runtime telemetry.

waterslide animates from **static analysis alone**. You pick an entry point (a
button tap, an HTTP route, a scheduled job) and watch a payload travel the real
call path, with branches you can click to flip.

## Supported

| | |
|---|---|
| Client | Swift / SwiftUI |
| Server | Python / FastAPI |
| Store | MongoDB |
| External | Cohere, Anthropic |
| Repos | Multi-repo in a single pass |

Measured on the reference codebase, a 177-file monorepo with a SwiftUI client
and a FastAPI server: 2655 nodes and 2776 edges, of which 54 are HTTP edges
resolved from Swift call sites to Python routes. A cold parse takes about
three seconds and a warm one under half a second. Those are one measurement on
one codebase, not a guarantee.

## Install

Not yet published. To run from source:

```bash
git clone https://github.com/kcwaverider/waterslide.git
cd waterslide
npm install
npm run build
```

Requires Node 20+. `npm run build` compiles the core, both language packs, the
CLI and the viewer. There is no global command yet; the CLI is invoked through
`node`, as shown below.

## Usage

Point `parse` at a checkout of the codebase you want mapped. The name on the
left of the `=` is the repo name that appears in node ids; the path is wherever
that checkout lives on your machine.

```bash
node cli/dist/src/index.js parse myrepo=/path/to/myrepo \
  --pack-option python.source_roots=<import-root>
```

`--pack-option python.source_roots=<import-root>` tells the Python pack which
repo-relative directory your imports are written relative to, which is
whatever is on `sys.path` when the app runs. Without it every module is named
from the repo root, most call sites match nothing, and the client-to-route
join is lost with them. For a FastAPI app whose imports are written relative
to `api/`, the value is `api`. If your app imports relative to the repo root,
omit the flag. Several roots are comma-separated.

That writes `.waterslide/graph.json` in the current directory and prints a
summary: node and edge counts, resolution figures, unresolved references by
kind, and diagnostics by code. A second run over an unchanged tree is served
from `.waterslide/cache/`. Then:

```bash
node cli/dist/src/index.js view --open                      # write .waterslide/graph.html and open it
node cli/dist/src/index.js dump                             # summary of the last parse
node cli/dist/src/index.js validate .waterslide/graph.json  # check a graph against the schema
node cli/dist/src/index.js --help                           # every command and flag
```

Several repos go in one command:
`parse api=/path/to/api ios-client=/path/to/ios-client`.

**Configuration.** No config produces the full map, and there is no config file
to write yet. What can be declared today is declared as flags on `parse`:
`--infrastructure <glob>` marks the nodes under a repo-relative glob as
infrastructure, `--exclude <name>:<glob>` and `--include <name>:<glob>` narrow
which files are read, `--include-tests` brings test files in, and
`--pack-option` is repeatable. The committed `.waterslide/config.yaml` for
tiers, infrastructure and pack options, and the policy checks, are designed in
[`docs/03-persisted-files.md`](./docs/03-persisted-files.md) and
[`docs/06-policy-checks.md`](./docs/06-policy-checks.md) but nothing reads them
yet. Writing that file today does nothing.

## How it works

Six stages, strictly ordered: **Discover → Hash → Parse → Resolve → Derive →
Emit**. Parsing is cached by file content hash; resolution never is, because
renaming a symbol in one repo breaks an edge in an unchanged file elsewhere.

Language support is a plugin: a shared graph model in the middle, language packs
emitting into it. Framework recognition is separate from language recognition, so
adding Django wouldn't touch the Python pack.

Full detail in [`docs/05-parser-pipeline.md`](./docs/05-parser-pipeline.md).

## Confidence, not certainty

Static analysis has blind spots and the map says so rather than hiding them.
Every node and edge carries one of three levels:

| Level | Rendered as | Meaning |
|---|---|---|
| `certain` | Solid | Read directly from source |
| `inferred` | Dashed | Derived by convention, with a stated reason |
| `annotated` | Dotted | A human wrote it into the annotations file |

Anything not `certain` must carry a human-readable reason. Where a reference is
ambiguous, every candidate is drawn — the tool never picks one arbitrarily.

Known blind spots are listed in
[`docs/01-scope.md`](./docs/01-scope.md#known-static-analysis-blind-spots).

## Docs

Design documents, written before any code. Start with
[`docs/README.md`](./docs/README.md).

| Doc | Covers |
|---|---|
| `00-handoff.md` | Build order, stack, milestones, parallel tracks |
| `01-scope.md` | Purpose, audience, non-goals, blind spots |
| `02-graph-model.md` | Nodes, edges, schemas, identity, confidence |
| `03-persisted-files.md` | What's written where, and who owns it |
| `04-ui-layout.md` | Animation model, layout, visual encoding |
| `05-parser-pipeline.md` | Pipeline stages, language pack interface |
| `06-policy-checks.md` | Missing middleware, data egress, band-skipping |
| `07-what-it-shows.md` | What the map makes legible, and why not a sequence diagram |

## Stack

TypeScript, tree-sitter, Zod, D3.

## Not in scope

Runtime tracing. Real payload values. Whether your logic is correct. Whether your
error handling is any good. Naming and formatting — a linter does that better.

## License

MIT. See [`LICENSE`](./LICENSE).
