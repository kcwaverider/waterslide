import { describe, expect, it } from "vitest";
import { loadPackData } from "../src/data.js";
import { getPack } from "./support/pack.js";

const targets = (edges: { to: unknown }[]): string[] =>
  edges.map((e) =>
    typeof e.to === "string" ? e.to : (e.to as { value: string }).value,
  );

describe("noise (A10 item 1): calls that tell a reader nothing are dropped silently", () => {
  it("loads the three tables and keeps the ambiguous names out", () => {
    const { noise } = loadPackData();
    expect(noise.libraryModules.has("bson")).toBe(true);
    expect(noise.valueMethods.has("strip")).toBe(true);
    for (const ambiguous of [
      "get",
      "update",
      "add",
      "remove",
      "pop",
      "read",
      "write",
      "close",
      "send",
    ])
      expect(noise.valueMethods.has(ambiguous), ambiguous).toBe(false);
    expect(noise.modelMethods.has("dict")).toBe(true);
  });

  it("drops third-party helper calls, builtin value methods and model methods, with no diagnostic", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "r",
      "m.py",
      [
        "from bson import ObjectId",
        "from models.memory import MemoryDB",
        "from models.invitation import TEMPLATE",
        "import bcrypt",
        "def f(memory: MemoryDB, name):",
        "    oid = ObjectId(name)",
        "    ObjectId.is_valid(name)",
        "    bcrypt.hashpw(name, bcrypt.gensalt())",
        "    data = memory.dict(exclude={'id'})",
        "    memory.name.strip()",
        "    TEMPLATE.format(token=name)",
        "    return data",
        "",
      ].join("\n"),
    );
    expect(r.edges).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it("keeps real calls: an ambiguous method name, an in-file method named like a builtin, a plain service call", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "r",
      "m.py",
      [
        "from repositories.cache import cache",
        "from services import mailer",
        "class Report:",
        "    def format(self):",
        "        return 1",
        "def f(x):",
        "    cache.get(x)",
        "    mailer.send_receipt(x)",
        "    Report().format()",
        "",
      ].join("\n"),
    );
    expect(targets(r.edges).sort()).toEqual([
      "r:m.py#Report",
      "r:m.py#Report.format",
      "repositories.cache.cache.get",
      "services.mailer.send_receipt",
    ]);
  });

  it("a builtin return annotation on the producer makes the call result a value, by evidence not by name", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "r",
      "m.py",
      [
        "from typing import Dict, List",
        "from repositories.notes import NoteRepo",
        "def _names(ids) -> Dict[str, str]:",
        "    return {}",
        "def _docs() -> List[dict]:",
        "    return []",
        "def make() -> NoteRepo:",
        "    return NoteRepo()",
        "def f(x):",
        "    names = _names(x)",
        "    names.get(x)",
        "    _docs().append(x)",
        "    repo = make()",
        "    repo.get(x)",
        "",
      ].join("\n"),
    );
    // Only the unresolved targets matter here; calls to the in-file producers are real edges.
    const callEdges = r.edges.filter(
      (e) => e.from.endsWith("#f") && typeof e.to !== "string",
    );
    expect(targets(callEdges)).toEqual(["repositories.notes.NoteRepo.get"]);
    expect(r.diagnostics).toEqual([]);
  });
});
