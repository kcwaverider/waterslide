# What the Map Shows

> **Read this first.** This document is descriptive, not a work list. Every row
> below is derivable from the graph model as already specified; nothing here is
> a feature request. It authorises no capability that is not listed in
> `01-scope.md`. Where a row needs something the model does not have, that row
> is road map, and it stays road map until a human moves it.

A catalog of the observations waterslide makes legible. Written for two
purposes: as a check that the graph model already supports each one, and as the
answer to "why not just use a sequence diagram."

**None of these are new features.** Every row is derivable from the model as
specced. Where a row needs something the model doesn't have, it says so and it's
road map — not a licence to add fields.

## Two columns worth reading carefully

- **Flagged** — the tool emits a finding or badge. Small list: the policy
  findings are all in `06`; the rest are flags the model already carries
  (`skips_tiers`, `is_broken`, change state) and parser diagnostics
- **Reader-observed** — the tool draws it accurately and a person notices.
  Most of this document, and per scope §*the hard line* that's deliberate

---

## 1. Things in the wrong place

| Observation | What you see | Flagged? |
|---|---|---|
| **A transport service doing more than transporting** — e.g. a client `ApiService` that owns auth decisions rather than just making the call | Outbound edges to kinds other than `http_request`; fork markers on it; edges into several domain services | Reader |
| **Logic in the route handler** | An `api`-band node that is a **terminus** — no outbound edges. Dead end on a layered map | Reader |
| **Route reaching the store directly** | Edge from `api` to `collection`, crossing two bands | **Yes** — `skips_tiers` |
| **Vendor call from the wrong layer** | `external_call` originating in `ui` or `api` rather than `domain` | Reader — edge length carries it |
| **A missing service** | No `AuthService` node exists at all; its responsibilities are absorbed elsewhere | Reader — absence, not presence |

The first row is the canonical case. A sequence diagram lists the same
participants and nothing about the list looks wrong; on a layered graph the
arrangement is visibly off before you can articulate why.

## 2. Duplication and sprawl

| Observation | What you see | Flagged? |
|---|---|---|
| **Two services doing one job** | Two parallel paths of the same shape between the same bands | Reader — **and must stay that way**, per scope §what-it-is |
| **A flow scattered across folders** | In module-level zoom, a flow zigzagging between many `parent` boxes instead of running down one | Reader |
| **One service under many aliases** | Six files importing one module under four names, collapsed to one node | **Yes** — free diagnostic, parser §3.5 |
| **A hub in every flow** | The same node in every blast radius. Solved for display by `is_infrastructure` | Reader |

## 3. Shape of a node's responsibilities

| Observation | What you see | Flagged? |
|---|---|---|
| **Orchestrating rather than forwarding** | Outbound edges to three or more distinct domain services | Reader |
| **Making decisions** | Fork markers on a node that should be a pipe | Reader |
| **Doing everything inline** | Terminus node — no outbound edges | Reader |
| **Wide fan-out** | Many outbound edges from one point. Deliberately never capped | Reader |
| **Cycles** | A loop in the graph, visible without playing the animation | Reader |

`skips_tiers` and fork markers already render, so two of these need no new work.

## 4. Cross-repo and cross-language

The strongest column, and the one sequence diagram tools essentially don't do.

| Observation | What you see | Flagged? |
|---|---|---|
| **A client call landing on a server route** | An edge crossing from Swift into Python | Reader — this is M2 |
| **A renamed route with a caller still on the old path** | Red edge, warning icon, tombstone node where the target was | **Yes** — `is_broken` |
| **An orphaned subscriber** | Topic edge with no matching publisher | **Yes** — dangling edge |
| **A dropped field another service reads** | Broken edge whose target still exists | **Yes** — `is_broken`, no tombstone |
| **Ambiguous resolution** | Edges to every candidate, all `inferred`, reason naming the ambiguity | **Yes** |

## 5. Policy and compliance

All of `06`. The only genuinely prescriptive part of the tool.

| Observation | Flagged? |
|---|---|
| A route missing a capability its siblings have | **Yes** — `missing_middleware` |
| User content leaving for an external vendor | **Yes** — `egress`, filtered by active regime |
| Fields reaching a vendor with no classification | **Yes** — `info`, one per edge |
| Band-skipping | **Yes** — `info` by default, promotable |

## 6. Change and impact

| Observation | What you see | Flagged? |
|---|---|---|
| **What's new since I last looked** | Saturation and double outline, from a personal baseline | **Yes** |
| **Blast radius of a change** | Flow mode: the reachable set from an entry point | Reader |
| **The map as it *would* be** | Parse a dirty working tree before opening a PR | Reader |
| **What a user or system can actually do** | The entry point sidebar — an index of every way control enters | Reader |

## 7. Deliberately absent

| Not shown | Why |
|---|---|
| A cohesion or complexity score | An opinion. Linters and CodeScene do this |
| "This flow touches 14 folders" as a metric | Counting is defensible and may come later; scoring never |
| Whether logic is correct | Premise 3 |
| Whether error handling is adequate | Permanent non-goal |
| Whether two similar paths *are* duplicates | The tool draws structure; the reader concludes |
| Race conditions | Road map, and only as **concurrent-write detection**: two unordered writes to one node from one entry point. Never a claim about interleaving |

---

## Versus a sequence diagram

Honest version, because someone will ask.

| | Sequence diagram | waterslide |
|---|---|---|
| One flow, in order | **Better.** Compact, standard, widely generated | Adequate |
| Several flows at once | No | Yes |
| Position carries meaning | No — participant order is cosmetic | Yes — band is depth |
| Identity across runs | No, stateless render | Yes — enables change state and `is_broken` |
| Cross-repo, cross-language | Rarely | Foundational |
| Index of what exists | No, you must know the flow | Yes — entry points |

**The claim is not that sequence diagrams hide these things.** Most of §1 would
appear on one. The claim is that a single flow provides no context to judge
against, so nothing on it looks wrong. Every observation in §1–3 depends on
comparison — to sibling flows, to band position, to the same node's role
elsewhere — and comparison needs more than one flow on screen.
