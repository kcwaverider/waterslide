# UI & Layout Spec

Covers layout, the two zoom concepts, visual encoding, view modes, and animation.

---

## 0. The animation model (read this first)

**The graph is drawn once and stays put. Animation is objects travelling along
fixed edges.**

This matters because it removes a whole class of problems that would otherwise
need solving. The animation is not a traversal that discovers and draws the
graph, so:

- **Cycles need no limit.** A loop is two objects moving back and forth along a
  line you can already see. Watching it repeat is informative.
- **Depth needs no limit.** The end of the chain is already visible; you can
  follow paths independently over several play cycles.
- **Breadth needs no cap.** High fan-out means many objects moving at once, which
  is the map correctly reporting that something is over-connected. That's a code
  smell worth seeing, not a rendering bug.

- **Branches need no prompting.** Every branch is *drawn*; only one is *travelled*.
  The animation picks a default and plays straight through, and you flip a fork by
  clicking it. See §7.5.

The only residual concern is legibility at very high fan-out, addressed with
speed control and by dimming inactive edges — never by limiting what animates.

**Rejected alternatives, recorded so they don't come back.** Animating every
reachable branch — spiderwebs into uselessness within two forks. Asking the user
which way to go at each fork — an interrogation, not a visualisation. Asking the
user for the output of each transform node so forks resolve from real values —
makes the tool's problem the user's problem, and there may be ten such nodes in
one flow. Evaluating conditions in a sandbox — needs faithful Python and Swift
semantics plus stubs for everything a function touches, which is two interpreters
and still guesses at the boundary.

---

## 1. Layout

### 1.1 Layered, not force-directed

Force-directed layout is physics: add one node and the whole arrangement
reshuffles, so the map looks unfamiliar after every parse. Unacceptable when the
tool's purpose is building a durable mental model.

Layered layout pins nodes to horizontal bands and optimises only left-to-right
ordering within each band. Depth on screen means depth in the stack.

### 1.2 Bands

Top to bottom, per graph model §6: `ui`, `ui_logic`, `api`, `domain`,
`data_access`, `store`. Band order and membership come from `config.yaml`.

### 1.3 The external column

`external` is not a depth layer. It renders as a vertical column down one side,
because external services aren't *deeper* — they're *outside*.

Consequences that fall out for free:

- A Swift view calling S3 directly draws a long horizontal edge from the top band.
- A Python worker calling Anthropic draws a short one from the middle.
- Edge length indicates how deep in the stack the call originated.

### 1.4 Within-band ordering

Minimise edge crossings, then keep siblings adjacent. Ordering must be
deterministic — the same graph always produces the same arrangement, so an
un-nudged map is still stable between parses.

### 1.5 Band-skipping edges

Edges with a non-empty `skips_tiers` get a badge. A `ui_view` writing straight to
a collection is usually something you want to know about. Counted as a coupling
metric with no extra config required.

---

## 2. Two zoom concepts

These are separate and must be named separately in the UI, or scrolling will
accidentally re-render the whole map.

| Concept | Control | Persistence | Effect |
|---|---|---|---|
| **Magnification** | Preferences setting | Persistent | Base text and node size everything scales from |
| **Zoom** | Scroll wheel | Per session | Google Maps behaviour: changes what's rendered |

### 2.1 Magnification

An accessibility setting. Sets a base size so nodes and labels render larger at
*every* zoom level. Set once, then forgotten.

Because high magnification fits fewer nodes on screen, offscreen indicators (§4)
become more important for these users, not less.

### 2.2 Semantic zoom

Zoom changes the semantic level — services, then modules, then functions — the
way Google Maps swaps country names for cities for streets. You never ask for
more detail; magnification triggers it.

**Trigger: target node size, not fixed thresholds.** Step to the next level when
the average on-screen node exceeds a target pixel width; step back when it drops
below. Adaptive, so it works at any magnification setting and adjusts to graph
density instead of breaking on sparse or dense maps.

Requirements:

- **Hysteresis** on both thresholds, so it doesn't flicker at the boundary.
- **A brief transition label** — "now showing modules" — so the change is never
  surprising.
- Aggregation is computed, not merely visual: at service level, forty calls to
  Mongo are one thick edge and the animation shows one object, not forty.

---

## 3. Visual encoding

Each property gets its own visual channel. Channels must not collide.

| Channel | Encodes | Why |
|---|---|---|
| Hue | Node `kind` | Permanent property, read constantly |
| Saturation | Change state | Transient — true for one parse |
| Outline | `new` (double outline) | Dashes are reserved for confidence |
| Line style | Edge confidence | Solid / dashed / dotted |
| Red + icon | `is_broken` | Icon, not colour alone |
| Badge | `skips_tiers`, stale annotation | Actionable, click-through |

### 3.1 Hue — node kind

Colour carries the permanent property, because that's what you're scanning for.
Model, view, controller — or in this stack, view, service, endpoint, repository,
collection.

**Decision:** hue by *kind group* — six groups, listed below. All kinds within a
group share the same colour, and that is accepted for now.

Noted as a future possibility, not a day-one requirement: adding node shape or a
small icon as a second channel to disambiguate within a group. Revisit only if
real maps prove it necessary.

| Group | Kinds |
|---|---|
| Presentation | `ui_view`, `ui_handler` |
| Client logic | `client_service` |
| Interface | `endpoint`, `middleware` |
| Logic | `function`, `class`, `service`, `module` |
| Data | `repository`, `collection`, `table`, `topic` |
| Boundary | `external_service` |

### 3.2 Saturation — change state

| State | Treatment |
|---|---|
| `unchanged` | Pastel — desaturated version of the kind hue |
| `modified` | Vivid — full-saturation kind hue |
| `new` | Vivid **plus double outline** |
| `removed` | Ghosted outline only, no fill |

Saturation keeps hue free for kind while still reading instantly. New nodes get a
double outline rather than a dashed one, because dashes mean uncertainty on edges
and the vocabulary must not say two things depending on whether you're looking at
a line or a border.

### 3.3 Line style — confidence

Solid for `certain`, dashed for `inferred`, dotted for `annotated`. Per graph
model §5. Line style encodes confidence and nothing else.

**Conditional edges do not use line style.** All three styles are spent on
confidence, and an edge can be both `inferred` *and* conditional, so conditions
need a separate channel. They get a text label (`event.type == 'charge.refunded'`)
and optionally a small fork marker where the branch splits.

### 3.4 Broken edges

Red, plus a clickable warning icon at the edge midpoint. Icon rather than colour
alone so it survives colourblindness and greyscale. Clicking gives the
`broken_reason` — e.g. "pointed at topic `note.indexed`, which no longer exists
after your change".

### 3.5 Stale annotations

Obvious icon and colour treatment reading clearly as "click me". Never a modal or
blocking prompt. Clicking opens the remedy list per persisted-files spec §4.3.

---

## 4. Offscreen indicators

When magnification or panning puts nodes off screen, an arrow appears at that
edge of the viewport.

| Property | Behaviour |
|---|---|
| Count | **Shallow** — nodes at the current semantic level only |
| Colour | **Deep** — inherited from the most significant change state among all nested descendants |

The asymmetry is deliberate. At service level, "4 services" is actionable;
"312 functions" tells you nothing. But a modified function three levels down
inside an offscreen service is exactly what the arrow should warn you about.

Precedence for inherited colour: `new` > `modified` > `unchanged`.

---

## 5. View modes

Two modes, orthogonal to zoom. Zoom manages *granularity*; mode manages
*relevance*. Conflating them would hurt — you can be at function level and still
want only the email flow.

### 5.1 Whole-system mode

The full map. Zoom manages detail. This is the default, and the POC should ship
it before any filtering work.

### 5.2 Flow mode

Pick an entry point; the map narrows to its reachable set — the **blast radius**,
computed from graph reachability rather than declared. Everything outside dims or
hides.

Nearly free, since reachability is already computed for the animation.

### 5.3 The hub problem

Some nodes appear in every blast radius: auth middleware, the logger, the user
collection. They don't help you narrow.

This is the same set already marked `is_infrastructure`, so middleware collapse
and flow mode reinforce each other. No separate mechanism needed.

### 5.4 Deliberately deferred

Further filtering is deferred until the tool has been pointed at a real codebase
and the hairball has been seen. Render everything first — the filter can't be
designed against a hypothetical.

---

## 6. Entry point sidebar

Every node with `is_entry_point: true` becomes a sidebar item — a playable story.
The app opens on a list of "things a user or system can do" rather than a wall of
graph.

Grouped by `entry_point_kind`: UI handlers, HTTP routes, webhooks, queue
subscribers, cron, app launch. Selecting one enters flow mode and plays it.

---

## 7. Animation

### 7.1 Playback

| Control | Default |
|---|---|
| Play / pause | **Play on select** |
| Speed | Adjustable, persisted |
| Step | Available — advance one hop at a time |

Play is the default; step is what you'll actually use when trying to understand
something specific.

### 7.2 Timing

Timing is invented, not measured, so optimise for legibility over realism.

- Fixed duration per hop as the baseline.
- Parallel edges fire **simultaneously**, so fan-out reads correctly — one click
  hitting two APIs is two objects leaving the same node together. This applies to
  independent edges only. Edges sharing an `exclusive_group` are alternatives, and
  exactly one of them animates (§7.5).
- `external_call` hops get a **longer duration**. Those calls genuinely are slow
  and metered, and that's useful intuition to build.

### 7.3 Payload inspection

Objects travelling the edges are clickable. Clicking opens the referenced schema:
field names, types, optionality, classification labels.

Shapes, not values — per scope.

### 7.4 Middleware

Nodes marked `is_infrastructure` collapse into a single step the animation glides
past. Expandable on click.

Rationale specific to agentic coding: middleware is usually the boilerplate the
agent got right. Business logic is where attention belongs.

### 7.5 Branch selection

**The animation never asks a question.** It picks a branch, plays through, and
leaves the fork visible so you can change your mind.

At every `exclusive_group` (graph model §3.2) the default is:

1. The first branch with `is_error_path: false`, by source line — the *happy path
   heuristic*.
2. If every branch is an error path, the lowest source line.

The heuristic works because of how people write code: the error case is a couple
of lines and the real work continues below it. "The branch that doesn't dead-end"
is usually the branch you meant to watch. Where both branches genuinely continue
— a commercial-versus-enterprise threshold, say — the heuristic has nothing to
say and source order decides.

**Interaction:**

| Element | Behaviour |
|---|---|
| Fork marker | Always visible at the branch point, whether or not it's the active path |
| Untravelled branch | Drawn, dimmed. Not hidden — you need to see it exists |
| Click a fork | Switches the active branch and replays from that point |
| Condition label | Shown on each branch, verbatim from `condition.expr` |

Because selection is deterministic, the same graph always animates the same way.
Nothing is persisted and there is no state to get out of sync.

**What this deliberately does not do.** It doesn't claim the chosen branch is the
one that would really fire. There is no interpreter, and the value driving the
comparison isn't known. The fork marker is the honest signal: a choice was made on
your behalf, here, and you can change it.

Error branches get no special treatment beyond the heuristic. If a branch raises
and unwinds, clicking it shows you a one-hop stub, which is itself the useful
information. If it fans out into an audit write and a failure event, you've found
plumbing worth reviewing. Either way it's just a branch.

**Road map:** *pinning* — remembering that you always want the enterprise branch
at a given fork. Out of the first pass because it needs somewhere personal to
live, and the default is cheap to re-flip.

---

## 8. Inspection panel

Clicking any node, edge, or travelling object opens a panel showing:

- Label, kind, tier
- Source location, with a link that opens the file at that line
- Confidence and, when not `certain`, the `confidence_reason` verbatim
- Attached schema, expanded
- Any hand-written note
- Change state, and what changed if `modified`

The `confidence_reason` is the highest-value thing here. "Matched publish topic
literal `note.indexed` to subscriber in `api/workers/indexer.py`" tells you
exactly how much to trust the line.

---

## 9. Data egress view

A filter, not a separate feature: every edge terminating at an `external_service`
node, with its schema fields listed and classification labels applied.

Active policy regime from `config.yaml` drives highlighting. Switching from GDPR
to HIPAA re-colours; it never re-annotates.

---

## 10. Open questions

- ~~Conditional-edge dashes vs confidence dashes.~~ **Resolved:** line style is
  confidence only; conditions get a label and fork marker.
- ~~Are 6 hue groups enough?~~ **Resolved:** yes for now. Shape or icon as a
  second channel is a future possibility, not day one.
- ~~How does the animation resolve a fork?~~ **Resolved:** happy path heuristic,
  source order as tie-break, click to flip. No prompting, no input values, no
  toggles. See §7.5.
- ~~Should there be a "run the error case" toggle?~~ **Resolved:** no. Error
  branches are ordinary branches; a toggle would imply there's something to see
  where usually there isn't.
- Does flow mode hide non-reachable nodes or merely dim them? Dimming preserves
  spatial memory; hiding is less cluttered.
- Does the animation replay on loop, or stop at the end of the reachable set?
- Where does the concurrent-write road map item surface visually, when it arrives?
