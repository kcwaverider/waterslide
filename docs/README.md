# Specs

Design documents for **waterslide**, a static-analysis tool that renders an
animated data flow map of a codebase — front end through API and business logic
to the datastore and back.

These were written before any code, deliberately. The build is driven from them.

**Naming.** The tool is `waterslide`; the CLI is invoked as `waterslide`, and
generated state lives in `.waterslide/`. Earlier drafts used "dataflow" as a
working name — if you find it anywhere, it's a leftover and should be changed.

## Running it

From the repo root, on a fresh checkout:

```sh
npm install
npm run build
```

`npm run build` runs `tsc -b` and compiles `core`, both packs, the CLI and the
viewer. The CLI is not linked as a global command, so it is invoked through
`node`. Point `parse` at a checkout of the codebase you want mapped. The name
on the left of the `=` is the repo name that appears in node ids; the path is
wherever that checkout lives on your machine.

```sh
node cli/dist/src/index.js parse myrepo=/path/to/myrepo \
  --pack-option python.source_roots=<import-root>
```

That writes `.waterslide/graph.json` in the current directory, fills
`.waterslide/cache/`, and prints the summary: node and edge counts, resolution
figures, unresolved references by `ref_kind`, and diagnostics by code. A second
run over an unchanged tree serves every file from the cache.

`--pack-option python.source_roots=<import-root>` names the repo-relative
directory that Python imports are written relative to, so that a call site's
`from services.x import y` matches the `provides` entry of
`<import-root>/services/x.py`. Without it every module is named from the repo
root, most Python call sites match nothing, and the resolved count drops
sharply. The client-to-route join goes with it: an `include_router` mount is
an import reference too, and when it fails to resolve its routes keep their
local paths, so the client's full URLs match nothing. For a FastAPI app whose
imports are written relative to `api/`, the value is `api`; use whatever
directory your own layout puts on `sys.path`.
`examples/example-repo/config.yaml` shows the same value as a config block.

```sh
node cli/dist/src/index.js view --open
```

Writes `.waterslide/graph.html`, one self-contained file, and opens it. Pan and
zoom with the mouse; hover a node or edge for its id, confidence and reason.
Any other `graph.json` can be dropped onto the page.

Other commands:

```sh
node cli/dist/src/index.js dump
node cli/dist/src/index.js validate .waterslide/graph.json
node cli/dist/src/index.js --help
```

Flags worth knowing on `parse`: `--canonical` writes the canonical shape for
byte comparisons, `--no-cache` forces a full parse, `--state-dir <dir>` writes
somewhere other than `./.waterslide`, and `--pack-option` is repeatable.

For a bare `waterslide` command, run `npm link -w cli` from the repo root.

## Reading order

Start with `00-handoff.md`. It stages the rest, so you don't read all of it at
once.

| Doc | What it covers | When to read |
|---|---|---|
| `00-handoff.md` | Build order, milestones, parallel tracks, PR structure | First, in full |
| `01-scope.md` | What this is for, what's out, known blind spots | First, in full |
| `02-graph-model.md` | Nodes, edges, schemas, identity, confidence, tiers | First, in full |
| `03-persisted-files.md` | The five files in `.waterslide/`, who writes what | M3 |
| `04-ui-layout.md` | Animation model, layout, zoom, visual encoding, view modes | M2 and M4 |
| `05-parser-pipeline.md` | Six-stage pipeline, language pack interface, recognizers | M1 |
| `06-policy-checks.md` | Missing middleware, data egress, band-skipping | M5 |
| `07-what-it-shows.md` | The observations the map makes legible. Descriptive, not a work list | When asking what the tool is for, or why not a sequence diagram. Not tied to a milestone |

## Ground rules

- **The specs are authoritative.** Where code and spec disagree, the code is a
  bug — unless the spec is wrong, in which case fix the spec first.
- **Open questions are open on purpose.** Each doc ends with a list of things
  deliberately unresolved. They are not a backlog and not authorisation to build.
- **Rejected alternatives are recorded.** `04-ui-layout.md` §0 keeps a block of
  approaches that were considered and dropped, with reasons, so they don't
  resurface. Read it before proposing a change to the animation model.

## Three things the docs assume you know

**Static analysis only.** No runtime tracing, no instrumentation, no sampling.
The tool reads what's in the repo — source, configuration, annotations, and commit
metadata — and never observes a running system. Everything it cannot see is listed
in `01-scope.md`.

**The graph is drawn once and fixed.** Animation moves objects along edges that
already exist. It does not discover or reveal the graph. Several early design
errors came from assuming otherwise.

**Shape, not correctness.** The tool shows how data moves and whether the
connections are intact. It has no opinion on whether the logic is right. The
plumbing may be sound while the water still goes down the wrong pipe.
