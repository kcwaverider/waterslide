# Specs

Design documents for **waterslide**, a static-analysis tool that renders an
animated data flow map of a codebase — front end through API and business logic
to the datastore and back.

These were written before any code, deliberately. The build is driven from them.

**Naming.** The tool is `waterslide`; the CLI is invoked as `waterslide`, and
generated state lives in `.waterslide/`. Earlier drafts used "dataflow" as a
working name — if you find it anywhere, it's a leftover and should be changed.

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
The tool reads source and nothing else. Everything it cannot see is listed in
`01-scope.md`.

**The graph is drawn once and fixed.** Animation moves objects along edges that
already exist. It does not discover or reveal the graph. Several early design
errors came from assuming otherwise.

**Shape, not correctness.** The tool shows how data moves and whether the
connections are intact. It has no opinion on whether the logic is right. The
plumbing may be sound while the water still goes down the wrong pipe.
