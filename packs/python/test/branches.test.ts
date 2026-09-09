import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PartialEdge } from "@waterslide/core";
import { fixture, getPack } from "./support/pack.js";
import { parseTree } from "./support/harness.js";
import { assemble } from "./support/resolver.js";

const target = (e: PartialEdge): string =>
  typeof e.to === "string" ? e.to : e.to.value;

describe("branch detection and is_error_path (parser §6, data table)", () => {
  async function flow(): Promise<PartialEdge[]> {
    const pack = await getPack();
    const r = pack.parse(
      "b",
      "flow.py",
      readFileSync(fixture("branches", "flow.py"), "utf8"),
    );
    return r.edges;
  }

  it("if/elif/else: one group, ordinals in source order, error paths from shape", async () => {
    const edges = (await flow()).filter(
      (e) => e.exclusive_group === "flow.py:handle:L7",
    );
    // The `if` limb only raises: constructing the exception is not a call the
    // map draws, so the limb gates no edge and ordinals start at the elif.
    expect(
      edges.map((e) => [
        target(e),
        e.branch_ordinal,
        e.condition?.expr,
        e.is_error_path,
      ]),
    ).toEqual([
      ["services.audit.record", 0, "elif note.locked", true], // early return, function continues below
      ["services.mailer.send", 1, "else", false],
    ]);
    expect(
      edges.every(
        (e) => e.source !== null && e.condition?.source_line !== null,
      ),
    ).toBe(true);
  });

  it("edges from one limb share an ordinal; limbs that gate nothing are skipped, ordinals stay contiguous", async () => {
    const pack = await getPack();
    const src = [
      "from services import audit, mailer",
      "def h(x):",
      "    if x.a:",
      "        audit.record(x)",
      "        mailer.send(x)",
      "    elif x.b:",
      "        pass",
      "    else:",
      "        audit.skip(x)",
      "",
    ].join("\n");
    const edges = pack.parse("b", "h.py", src).edges;
    expect(edges.map((e) => [target(e), e.branch_ordinal])).toEqual([
      ["services.audit.record", 0],
      ["services.mailer.send", 0],
      ["services.audit.skip", 1], // the else limb is index 2, renumbered to 1
    ]);
    expect(new Set(edges.map((e) => e.exclusive_group)).size).toBe(1);
  });

  it("try/except is a fork; the except limb is uncertain and says so", async () => {
    const edges = (await flow()).filter(
      (e) => e.exclusive_group === "flow.py:handle:L15",
    );
    expect(
      edges.map((e) => [
        target(e),
        e.branch_ordinal,
        e.condition?.expr,
        e.is_error_path,
        e.confidence,
      ]),
    ).toEqual([
      ["services.mailer.deliver", 0, "try", false, "certain"],
      [
        "services.retry_queue.enqueue",
        1,
        "except TimeoutError",
        true,
        "inferred",
      ],
    ]);
    expect(edges[1]?.confidence_reason).toMatch(
      /except handler.*retries may be the happy path/,
    );
  });

  it("ternary and match are forks too", async () => {
    const edges = await flow();
    const ternary = edges.filter(
      (e) => e.exclusive_group === "flow.py:handle:L19",
    );
    expect(
      ternary.map((e) => [target(e), e.branch_ordinal, e.condition?.expr]),
    ).toEqual([
      ["services.audit.record", 0, "if note.big"],
      ["services.audit.skip", 1, "else"],
    ]);
    const match = edges.filter(
      (e) => e.exclusive_group === "flow.py:handle:L20",
    );
    expect(
      match.map((e) => [target(e), e.branch_ordinal, e.condition?.expr]),
    ).toEqual([
      ["services.audit.a", 0, 'case "a"'],
      ["services.audit.other", 1, "case _"],
    ]);
  });

  it("a call outside any branch has no fork fields; a branch gating no edges produces nothing", async () => {
    const edges = await flow();
    const receipt = edges.find(
      (e) => target(e) === "services.mailer.send_receipt",
    );
    expect(receipt).toMatchObject({
      exclusive_group: null,
      branch_ordinal: null,
      condition: null,
      is_error_path: false,
    });
    expect(edges.some((e) => e.from.endsWith("#local_only"))).toBe(false);
  });

  it("a literal dispatch table fans out with one alternative per key (parser §6.4)", async () => {
    const edges = (await flow()).filter((e) => e.from.endsWith("#dispatch"));
    expect(
      edges.map((e) => [
        target(e),
        e.exclusive_group,
        e.branch_ordinal,
        e.condition?.expr,
      ]),
    ).toEqual([
      ["services.audit.record", "flow.py:dispatch:L32:dispatch", 0, '"create"'],
      ["services.audit.purge", "flow.py:dispatch:L32:dispatch", 1, '"delete"'],
    ]);
  });

  it("return of an error response and an early return both read as error paths", async () => {
    const pack = await getPack();
    const src = [
      "from fastapi.responses import JSONResponse",
      "from services import audit",
      "def h(x):",
      "    if x.bad:",
      "        audit.warn(x)",
      "        return JSONResponse(status_code=422, content={})",
      "    if x.other:",
      "        audit.note(x)",
      "        return JSONResponse(status_code=200, content={})",
      "    audit.ok(x)",
      "    return 1",
      "",
    ].join("\n");
    const r = pack.parse("b", "h.py", src);
    const byTarget = new Map(r.edges.map((e) => [target(e), e]));
    expect(byTarget.get("services.audit.warn")?.is_error_path).toBe(true); // 422 response
    expect(byTarget.get("services.audit.note")?.is_error_path).toBe(true); // early return: `audit.ok` follows the branch
    expect(byTarget.get("services.audit.ok")?.exclusive_group).toBeNull();
  });

  it("assembled fork edges satisfy invariants 9, 14 and 15", async () => {
    const pack = await getPack();
    const results = parseTree(pack, "b", fixture("branches"));
    const assembled = assemble(pack, results, "b");
    expect(
      assembled.validation.ok,
      JSON.stringify(assembled.validation.errors),
    ).toBe(true);
    const groups = new Map<string, number[]>();
    for (const e of assembled.graph.edges) {
      if (e.exclusive_group === null) continue;
      groups.set(e.exclusive_group, [
        ...(groups.get(e.exclusive_group) ?? []),
        e.branch_ordinal as number,
      ]);
    }
    expect(groups.size).toBeGreaterThanOrEqual(5);
    // Contiguous from 0; repeats are legal (one alternative, several edges).
    for (const ords of groups.values()) {
      const distinct = [...new Set(ords)].sort((a, b) => a - b);
      expect(distinct).toEqual(distinct.map((_, i) => i));
    }
  });
});
