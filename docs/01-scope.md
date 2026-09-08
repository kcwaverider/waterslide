# waterslide — Scope

## What it is

A static analysis engine plus a local web app that renders a codebase as an
animated data flow map. It answers the question: *when this thing happens, what
data moves where?*

Everything the tool knows comes from static inputs in the repos it is pointed at:
**source code, project and framework configuration, its own `config.yaml` and
`annotations.yaml`, and VCS metadata** (commit hash per repo, whether the working
tree is dirty).

Nothing is executed, nothing is instrumented, no running system is observed. That
restriction is absolute and is the point — see *The hard line* below.

The problem it solves: when most code is written by agents, you stop reading all
of it. The map restores comprehension of the parts you didn't write, and shows
how a change you're about to make alters the system's plumbing.

Three things it is for, and they are all the same kind of question:

1. **Comprehension** — how does this work, given I didn't write it.
2. **Change impact** — what does my next change touch.
3. **Maintainability judgement** — is this organised in a way that survives the
   next six months of road map.

The third one is the origin of the tool. Two services doing substantially the
same job in different parts of the app is invisible in code review, because no
single file looks wrong. On a map, a person looking at it notices.

**The tool does not detect this, and must not try.** It draws the structure
accurately; the reader draws the conclusion. Similarity detection, shape
comparison and duplicate-path analysis are all out of scope — there is no node or
edge field for them, and none should be added.

**This is a tool for reading shape, not for checking correctness.** Whether the
business logic is *organised* well is in scope. Whether it *computes* the right
answer is not, and never will be.

## Who reads the map

Three audiences. The design bends most for the first.

| Reader | Can read the source? | Needs the map to be |
|---|---|---|
| Technical product / program manager | No | Legible on its own |
| Engineering manager | Could, hasn't the time | Fast to get a feel from |
| Software engineer | Yes | A quick sniff test before reading the diff |

Engineers don't need this tool to understand their system; they need it to be
faster than reading. The other two readers need it to be understandable at all,
which is the stricter requirement, so it's the one the design targets.

**Constraints this imposes.** These are requirements on presentation, not new
features — nothing in this section authorises a capability that isn't already
listed under *In scope*.

- **Node ids are addresses, not labels.** `tapistree:api/routers/notes.py#update_note`
  is correct and unreadable. Every node needs a display label that means something
  to someone who has never opened the file.
- **The map must render with no configuration.** Config requires knowing what a
  decorator is. If the tool is unusable before someone writes `config.yaml`, the
  non-engineer reader never sees it. Empty config must produce the full map.
- **Two personas, one artefact.** An engineer writes the config and annotations;
  everyone consumes the map. Assume the reader and the configurer are different
  people.
- **Uncertainty must be self-explaining.** A reader who can't check the source
  against the map has no way to sanity-check a wrong edge. This is why every
  non-`certain` entity carries a human-readable reason, and why ambiguous matches
  emit all candidates rather than a guess. Those rules exist for this reader.

The failure mode to design against: a non-engineer sees something alarming,
raises it, and an engineer says "that's fine, you're misreading it." Twice is
enough to lose the audience. Accuracy about what the tool *doesn't* know is what
prevents it.

## In scope for the POC

- **Stacks:** Swift (client), FastAPI/Python (server), MongoDB (store)
- **Boundaries:** Cohere and Anthropic as external service nodes
- **Multi-repo:** parses several repos in one pass, records commit hash per repo
- **Local working tree:** can parse uncommitted changes and diff against last parse
- Layered layout, semantic zoom, entry-point-driven animation
- Confidence levels on every node and edge
- Hand-written annotations and config, committed to the repo
- Persistent node positions, local to each developer — layout is personal
- Default branch selection at forks, flippable by click (see UI spec §7.5)
- Middleware collapse, and the inverted check for routes missing expected middleware
- Data egress view from boundary edges, with field-level classification

## Non-goals

These are deliberately excluded. Some are road map, some are permanently out.

| Non-goal | Status |
|---|---|
| Runtime tracing / instrumentation | Out for POC |
| Real payload values (shapes only) | Out for POC |
| MongoDB schema drift detection (sampling stored docs) | Road map |
| Concurrent-write detection ("candidate races") | Road map |
| Production observability, latency, error rates | Out |
| Evaluating error handling — whether failures are caught or recovered from | Permanently out |
| Logic correctness — the map shows plumbing, not whether values are right | Permanently out |

Error handling deserves its own line because it looks like it belongs and doesn't.
An error branch that raises and unwinds is a one-hop stub on the map: there is
nothing to see, and no toggle or dedicated view would make there be something to
see. Error paths that *do* real work — an audit write, a failure event, a retry
queue — are plumbing, and appear as ordinary edges like anything else.

To be precise, since "no special handling" was overstated: error paths are drawn,
animated, inspected and counted exactly like any other edge. The single place
`is_error_path` is consulted is picking which branch the animation plays *by
default* at a fork (graph model §3.2) — a legibility choice about where to start,
not an evaluation of the error handling. Nothing is hidden, dimmed, or excluded.

## The hard line

If a fact cannot be derived from source code or a config file in a repo the tool
has been pointed at, it does not appear on the map — unless a human wrote it
into the annotations file by hand, in which case it is labelled as such.

Scope creep on a tool like this is relentless. When in doubt, check against the
line above.

## Known static-analysis blind spots

These are accepted limitations, surfaced honestly on the map rather than hidden:

- **Event bus links** — publisher and subscriber are connected only by a matching
  string; reconstructed by indexing both sides. Marked `inferred`.
- **Dependency injection** — resolved by reading config where config declares the
  live implementation. Marked `inferred` with the config source as the reason.
- **Dynamic dispatch** — a handler map keyed by a payload field is readable if the
  map is a literal. Rendered as a labelled fan-out of possible destinations.
- **Runtime registration** — handlers registered by looping over a directory have no
  literal keys anywhere. Requires manual annotation.
- **ORM / ODM writes** — the target collection and read-vs-write are inferred from
  entity class and method name. Cascading writes may be undercounted.
