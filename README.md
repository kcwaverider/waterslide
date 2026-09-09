# waterslide

A static-analysis tool that renders a codebase as an **animated data flow map** —
front end through API and business logic to the datastore and back out.

Pick something a user can do. Watch the data travel.

**Status: in development.** The design is complete and lives in [`docs/`](./docs);
the implementation is in progress. Commands shown below describe the intended
surface — see Install for what actually runs today.

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

## Install

Not yet published. To run from source:

```bash
git clone https://github.com/kcwaverider/waterslide.git
cd waterslide
npm install
npm run build
```

Requires Node 20+.

> **Not working yet.** The CLI lands with M3. Until then `npm test` is the only
> thing worth running.

## Usage

Point it at one or more repos:

```bash
waterslide parse /path/to/myrepo
waterslide parse /path/to/api /path/to/ios-client
```

That writes `.waterslide/graph.json`, then:

```bash
waterslide dump        # summary: node and edge counts, unresolved references
waterslide validate    # check a graph against the schema
waterslide view        # open the map in a browser
```

Configuration is optional — `waterslide parse` with no config produces the full
map. A `.waterslide/config.yaml` lets you declare band assignment, mark
infrastructure, and turn on policy checks. See
[`docs/03-persisted-files.md`](./docs/03-persisted-files.md).

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

## Stack

TypeScript, tree-sitter, Zod, D3.

## Not in scope

Runtime tracing. Real payload values. Whether your logic is correct. Whether your
error handling is any good. Naming and formatting — a linter does that better.

## License

MIT. See [`LICENSE`](./LICENSE).
