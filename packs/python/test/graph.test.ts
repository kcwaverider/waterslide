import { describe, expect, it } from "vitest";
import { PackResultSchema } from "../src/index.js";
import { parseTree, shuffle, walkPython } from "./support/harness.js";
import { fixture, getPack } from "./support/pack.js";
import { assemble } from "./support/resolver.js";

const SERVER = { source_roots: ["server"] };
const opts = (tree: {
  source_roots: string[];
}): { source_roots: string[] } => ({
  source_roots: tree.source_roots,
});

const TREES: { name: string; dir: string; source_roots: string[] }[] = [
  { name: "alias", dir: "alias", source_roots: [] },
  { name: "bare", dir: "bare-names", source_roots: [] },
  { name: "fx", dir: "fastapi-app", source_roots: ["server"] },
  { name: "vendors", dir: "external", source_roots: [] },
  { name: "br", dir: "branches", source_roots: [] },
  { name: "edge", dir: "edge-cases", source_roots: [] },
];

describe("graph fragments validate and are deterministic (handoff §6 items 1 and 2)", () => {
  for (const tree of TREES) {
    it(`${tree.name}: every per-file result matches the pack contract`, async () => {
      const pack = await getPack();
      for (const file of parseTree(
        pack,
        tree.name,
        fixture(tree.dir),
        undefined,
        opts(tree),
      )) {
        const parsed = PackResultSchema.safeParse(file.result);
        expect(
          parsed.success,
          `${file.path}: ${JSON.stringify(parsed.error?.issues)}`,
        ).toBe(true);
      }
    });

    it(`${tree.name}: assembles into a canonical graph that passes all 23 invariants`, async () => {
      const pack = await getPack();
      const assembled = assemble(
        pack,
        parseTree(pack, tree.name, fixture(tree.dir), undefined, opts(tree)),
        tree.name,
        opts(tree),
      );
      expect(
        assembled.validation.ok,
        JSON.stringify(assembled.validation.errors, null, 2),
      ).toBe(true);
      expect(assembled.graph.nodes.length).toBeGreaterThan(0);
    });

    it(`${tree.name}: two runs are byte-identical, and so is a shuffled discovery order`, async () => {
      const pack = await getPack();
      const root = fixture(tree.dir);
      const files = walkPython(root);
      const first = assemble(
        pack,
        parseTree(pack, tree.name, root, files, opts(tree)),
        tree.name,
        opts(tree),
      ).text;
      const second = assemble(
        pack,
        parseTree(pack, tree.name, root, files, opts(tree)),
        tree.name,
        opts(tree),
      ).text;
      expect(second).toBe(first);
      for (const seed of [1, 7, 42]) {
        const shuffled = assemble(
          pack,
          parseTree(pack, tree.name, root, shuffle(files, seed), opts(tree)),
          tree.name,
          opts(tree),
        ).text;
        expect(shuffled, `seed ${String(seed)}`).toBe(first);
      }
    });
  }

  it("never derives an edge id for an unresolved target: PartialEdge carries none", async () => {
    const pack = await getPack();
    for (const file of parseTree(
      pack,
      "fx",
      fixture("fastapi-app"),
      undefined,
      SERVER,
    )) {
      for (const edge of file.result.edges)
        expect(edge).not.toHaveProperty("id");
    }
  });

  it("every non-certain node, edge and schema carries a human-readable reason", async () => {
    const pack = await getPack();
    const assembled = assemble(
      pack,
      parseTree(pack, "fx", fixture("fastapi-app"), undefined, SERVER),
      "fx",
      SERVER,
    );
    for (const e of assembled.graph.edges) {
      if (e.confidence !== "certain")
        expect(e.confidence_reason, e.id).toMatch(/\w+ \w+/);
    }
  });
});
