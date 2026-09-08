# Policy Checks Spec

Everything else in these specs is **descriptive** — here is your system, here is
how data moves through it. This document covers the **prescriptive** part: rules
you declare, checked against what the parser found.

The map shows what *is* connected. A policy check shows what *should* be connected
and isn't. That inversion is where the original motivating worry lives: an agent
adds an endpoint, forgets the auth dependency, review doesn't catch it, and no
single file looks wrong.

**Ownership split with the persisted-files spec.** Doc 03 owns the *file format* —
where these blocks live in `config.yaml` and what the YAML looks like. This doc
owns the *semantics* — what each check means, how it evaluates, and how findings
surface. Where the two overlap, doc 03 is authoritative on shape and this doc is
authoritative on behaviour.

---

## 0. Policy is entirely opt-in

**With an empty config, every policy check is inert and the tool works.** You get
the full map, the animation, the egress *view*, all of it. Nothing about the core
value proposition depends on writing a single rule.

This is a requirement, not a courtesy. A tool that demands configuration before
it shows you anything doesn't get adopted, and the comprehension use case — the
reason this exists — needs no policy at all.

Setup cost, honestly stated:

| Block | Effort | Changes over time? |
|---|---|---|
| `infrastructure` globs | Minutes. A handful of paths | Rarely |
| `capabilities` (§2.1) | Once per capability. Maybe five | Rarely |
| `expected_middleware` rules | One rule per *class* of route, not per route | Occasionally |
| `policy` regimes | Pick one, or ship with defaults | Rarely |
| Egress report | **Zero.** Derived from existing edges | n/a |

The real cost isn't setup, it's the first run. You will get findings you disagree
with and spend an hour sorting genuine problems from cases needing an exemption.
That's true of every linter and worth saying out loud rather than discovering.

---

## 1. The finding model

Every check emits the same shape, so the UI renders one list and the road map can
add checks without new display code.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable per finding. Hash of `check` + `subject` + `rule_id` |
| `check` | enum | yes | `missing_middleware` \| `egress` \| `band_skip` |
| `rule_id` | string \| null | yes | Which declared rule produced it. Null for derived checks |
| `subject` | string | yes | Node or edge id the finding is about |
| `severity` | enum | yes | `info` \| `warn` \| `error` |
| `message` | string | yes | Human-readable, specific. See below |
| `detail` | object \| null | no | Check-specific payload |
| `exempted` | bool | yes | True when silenced by an exemption. Still emitted |
| `exemption_reason` | string \| null | if exempted | Verbatim from config |

**Messages must name the comparison, not just the failure.** Not "missing auth" —
"`create_admin_user` has no `auth` capability; 14 of 15 routes under
`api/routers/admin/**` have one." The second tells you it's an outlier. The first
tells you to go read the rule.

**Exempted findings are emitted, not dropped.** They render collapsed and muted,
but they exist, because a list of everything you've decided to ignore is a useful
artefact and a silently-suppressed check is one you stop trusting.

### 1.1 Severity semantics

| Severity | Meaning | POC behaviour |
|---|---|---|
| `info` | Worth knowing. No action implied | Badge only |
| `warn` | Probably wrong. Default for declared rules | Badge plus sidebar count |
| `error` | Definitely wrong | Badge plus sidebar count, sorted first |

In the POC, severity drives **display only**. There is no exit code, no CI gate,
no blocking. A CLI mode that fails a build on `error` is road map — the check
semantics are designed to support it, but shipping the gate before the rules have
been tuned against a real codebase would produce a tool people disable.

---

## 2. Check: missing middleware

The inverted check. The valuable half of the middleware story.

### 2.1 Capabilities: the missing link

Doc 03 §3.3 declares `require: [auth, request_logging]`. Nothing yet says what
`auth` *is*. That mapping needs to exist, and it is language- and
framework-specific, so it is declared rather than inferred.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `name` | string | yes | Logical capability name, referenced by `require` |
| `satisfied_by` | Matcher[] | yes | Any one match satisfies it |
| `description` | string | no | Shown in the finding message |

Matcher kinds:

| Matcher | Matches |
|---|---|
| `decorator` | A decorator on the node, by qualified name |
| `dependency` | A `Depends(...)` argument, by qualified name |
| `middleware_node` | An `is_infrastructure` node upstream of this one in the graph |
| `annotation` | A hand-written tag in `annotations.yaml` |
| `tag` | A value in the node's `tags` array |

```yaml
# ILLUSTRATIVE ONLY
capabilities:
  - name: auth
    description: "authenticated caller"
    satisfied_by:
      - { dependency: "api.deps.auth.get_current_user" }
      - { dependency: "api.deps.auth.require_admin" }
      - { decorator: "api.deps.auth.authenticated" }
  - name: request_logging
    satisfied_by:
      - { middleware_node: "tapistree:api/middleware/logging.py#LoggingMiddleware" }
```

The `middleware_node` matcher is the interesting one, because it's satisfied
*graphically* rather than syntactically — a route is covered if a logging
middleware node sits upstream of it, regardless of how that was wired. That's the
one case where the check reads the graph rather than the source.

> **Note on a gap.** This block did not exist in the earlier draft of doc 03. The
> `require` list referenced capability names with nothing defining them. Adding
> `capabilities` closes that, and doc 03 §3.3 should gain a pointer here.

### 2.2 Evaluation

For each `expected_middleware` rule, in declaration order:

1. Resolve `applies_to` to a node set. Glob against `source.path`, intersected
   with `is_entry_point: true` — the check is about entry points, since middleware
   guards the boundary and an internal function has no boundary to guard.
2. For each node in the set, for each name in `require`, test every matcher for
   that capability. Any single match satisfies it.
3. Unsatisfied capability → one finding, at the rule's severity.

Rules are **additive**, not first-match-wins. A route matched by two rules must
satisfy the union of both `require` lists. This differs deliberately from tier
assignment (doc 03 §3.1), which *is* first-match-wins — tiers are exclusive
placement, requirements accumulate.

### 2.3 Why declared, not inferred

Majority-inference — "most routes here have auth, so flag the ones that don't" —
is tempting and wrong. It gets the direction backwards: it treats the current
state of the code as the specification. On a codebase where auth was forgotten on
half the admin routes, inference concludes auth is optional there.

A rule is a statement of intent. It stays correct while the code drifts, which is
the entire point.

The *comparison* is still worth reporting, though — hence the message format in
§1. "14 of 15 siblings have this" is useful evidence attached to a finding, and
useless as the basis for one.

### 2.4 Exemptions

Resolving doc 03's open question: exemptions live **inline in the rule**, keyed by
node id, and a reason is mandatory.

```yaml
expected_middleware:
  - applies_to: { glob: "api/routers/**" }
    require: [auth, request_logging]
    severity: warn
    exempt:
      - node: "tapistree:api/routers/health.py#healthz"
        reason: "load balancer probe; must answer before auth is initialised"
      - node: "tapistree:api/routers/webhooks.py#stripe_webhook"
        reason: "authenticated by signature verification, not session auth"
```

Three reasons for inline over a separate exemptions file. It sits next to the rule
it modifies, so you read both together. It's committed, so an exemption is
reviewable in a pull request — which is where you want the argument about whether
it's legitimate. And the mandatory `reason` becomes the message on the muted
finding, so the answer to "why is this one allowed" is always one click away.

An exemption naming a node that no longer exists is a **stale reference**, handled
exactly like a stale annotation per doc 03 §4. Same remedy UI, no special case.

---

## 3. Check: data egress

### 3.1 The view is free; the check is the policy layer

The egress *view* needs no configuration: filter the graph to every edge whose
target is an `external_service` node, expand the referenced schema, list the
fields. That's UI spec §9 and it works out of the box.

The *check* applies the active policy regime (doc 03 §3.5) and produces findings
for fields whose classification is flagged under that regime.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `subject` | string | yes | The edge id terminating at the external node |
| `detail.vendor` | string | yes | e.g. `cohere` |
| `detail.surface` | string | yes | e.g. `embed` |
| `detail.flagged_fields` | object[] | yes | `{ schema_id, field, classification[] }` |
| `detail.regime` | string | yes | Active regime name at evaluation time |

### 3.2 Unclassified fields

A field with no classification is **not** clean — it's unknown, and there's a real
difference. Emit those as `info` findings, separately: "12 fields reaching external
services have no classification."

That number is a coverage metric, and it should be visible. A green egress report
over a schema nobody has classified is the most dangerous possible output of this
tool, because it looks like an answer.

### 3.3 Switching regimes never re-annotates

Restating the load-bearing property from doc 03 §3.5, because it constrains the
implementation here: classification labels are neutral and descriptive
(`identifier`, `email`, `free_text`, `may_contain_pii`, `health_data`,
`financial`). The regime maps labels to rules. Switching from GDPR to HIPAA
re-evaluates and re-colours; it never asks you to relabel a field.

This is why classification belongs next to the type in the Pydantic model — it's a
property of the data, not of the regulation.

### 3.4 Why this check exists at all

The reference codebase sends user note content to Cohere for embeddings and to
Anthropic for summarisation. That is a compliance question whether or not anyone
has asked it, and it is invisible in code review because each individual call
looks like an ordinary API call.

This check turns "what user content leaves our infrastructure" from an
investigation into a filter.

---

## 4. Check: band-skipping

Free, in the sense that `skips_tiers` is already populated during derivation
(graph model §3.3) and needs no config.

| Setting | Default |
|---|---|
| Enabled | Yes |
| Severity | `info` |
| Threshold | More than one band |

A `ui_view` writing straight to a collection is the canonical case. Severity is
`info` rather than `warn` because legitimate reasons exist and the tool has no way
to know which is which — but the count over time is the useful signal. Rising
band-skip count means coupling is increasing.

Configurable to `warn` for teams that want it enforced. Exemptions use the same
inline mechanism as §2.4.

---

## 5. Middleware collapse

Not a check — an *affordance* the same config enables, listed here because it
shares `infrastructure`.

Nodes with `is_infrastructure: true` collapse into a single animation step
(UI spec §7.4). Set by glob declaration only, never inferred.

Two things it does beyond tidying:

- Keeps attention on business logic, which is where agentic coding goes wrong.
  Middleware is usually the boilerplate the agent got right.
- Solves the hub problem in flow mode (UI spec §5.3). Auth, logging and the user
  collection appear in every blast radius; marking them infrastructure is what
  stops flow mode being useless.

One config block, three consumers. Worth noting so nobody refactors it into three.

---

## 6. Where findings surface

| Location | What appears |
|---|---|
| Node badge | Icon on any node with a non-exempted finding. Click for detail |
| Edge badge | Same, for edge-subject findings |
| Sidebar counter | Total by severity. Click to open the findings list |
| Findings list | Grouped by check, sorted by severity. Exempted collapsed at the bottom |
| Inspection panel | Findings for the selected node, with `message` verbatim |
| Egress view | Its own findings inline, per field |

Badges use an **icon plus colour, never colour alone** — same rule as broken
edges, per UI spec §3.4. Colour alone fails for colourblind users and in
greyscale, and a findings badge is exactly the thing you'd screenshot into a pull
request.

Findings do not block, do not modal, and do not interrupt the animation. They are
always something you go and look at.

---

## 7. Not policy checks

Deliberately excluded, and the boundary matters because this is the section of the
tool most likely to accumulate scope.

| Not checked | Why |
|---|---|
| Error handling — is this failure caught, is it recovered from | Correctness, not shape. Permanently out per scope |
| Logic correctness — is the threshold right, is the value right | Permanently out per scope |
| Naming conventions, formatting, complexity | A linter's job, done better by linters |
| Test coverage | Different tool, different graph |
| Whether a policy rule is *itself* correct | Human judgement. The tool checks conformance to your rule, not your rule |

The last row is the one to remember. This tool will tell you eleven routes don't
match the rule you wrote. It has no opinion on whether the rule should have been
written, and shouldn't develop one.

---

## 8. Open questions

- Does `applies_to` need to match on something other than path? A rule like
  "every route accepting a `user_id` parameter requires auth" is more precise than
  a path glob and much harder to express. Path is probably enough for the POC.
- Should `middleware_node` matching be transitive through the whole upstream
  chain, or only direct predecessors? Transitive is more correct and risks
  false-satisfying via a long unrelated path.
- Egress: is per-field classification workable at scale, or does it need
  inheritance — classify a schema once, override per field? Depends on how many
  schemas `tapistree` actually has.
- Where do findings live between runs? Nowhere, currently — they recompute every
  parse, which is right. But "this finding is new since I last looked" would need
  them in `baseline.json`.
