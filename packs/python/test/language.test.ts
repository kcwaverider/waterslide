import { describe, expect, it } from "vitest";
import type { UnresolvedRef } from "@waterslide/core";
import {
  moduleNameForPath,
  resolveRelativeModule,
} from "../src/language/module-name.js";
import { parseTree } from "./support/harness.js";
import { fixture, getPack } from "./support/pack.js";
import { assemble } from "./support/resolver.js";

const SERVER = { source_roots: ["server"] };

const refOf = (to: string | UnresolvedRef): UnresolvedRef => {
  if (typeof to === "string")
    throw new Error(`expected an UnresolvedRef, got ${to}`);
  return to;
};

describe("module names (parser §3.4)", () => {
  it("maps paths to importable names relative to a source root", () => {
    expect(
      moduleNameForPath("server/api/endpoints/memory.py", ["server"]),
    ).toEqual({ module: "api.endpoints.memory", package: "api.endpoints" });
    expect(
      moduleNameForPath("server/api/endpoints/__init__.py", ["server"]),
    ).toEqual({ module: "api.endpoints", package: "api.endpoints" });
    expect(moduleNameForPath("server/main.py", ["server"])).toEqual({
      module: "main",
      package: "",
    });
    expect(moduleNameForPath("scripts/tool.py", ["server"])).toEqual({
      module: "scripts.tool",
      package: "scripts",
    });
    expect(moduleNameForPath("a/b.py", [])).toEqual({
      module: "a.b",
      package: "a",
    });
  });

  it("resolves relative imports against the current package", () => {
    expect(resolveRelativeModule("api.endpoints", 1, "memory")).toBe(
      "api.endpoints.memory",
    );
    expect(resolveRelativeModule("api.endpoints", 2, "models")).toBe(
      "api.models",
    );
    expect(resolveRelativeModule("api.endpoints", 1, "")).toBe("api.endpoints");
    expect(resolveRelativeModule("api", 3, "x")).toBeNull();
  });
});

describe("import aliases die inside the pack (parser §3.5, handoff §6.4)", () => {
  it("six files, four aliases, one target reference", async () => {
    const pack = await getPack();
    const results = parseTree(pack, "aliasrepo", fixture("alias"));
    const callers = results.filter((r) => /^a\d\.py$/.test(r.path));
    expect(callers).toHaveLength(6);
    const values = callers.map((r) => {
      const edge = r.result.edges.find((e) => e.kind === "call");
      expect(edge, r.path).toBeDefined();
      return refOf((edge as { to: string | UnresolvedRef }).to).value;
    });
    expect(new Set(values)).toEqual(
      new Set(["services.memory_service.display"]),
    );

    const assembled = assemble(pack, results, "aliasrepo");
    expect(
      assembled.validation.ok,
      JSON.stringify(assembled.validation.errors),
    ).toBe(true);
    const targets = new Set(
      assembled.graph.edges
        .filter((e) => e.label === "display")
        .map((e) => e.to),
    );
    expect(targets).toEqual(
      new Set(["aliasrepo:services/memory_service.py#display"]),
    );
    expect(
      assembled.graph.edges.filter((e) => e.label === "display"),
    ).toHaveLength(6);
    expect(assembled.unresolved).toEqual([]);
  });

  it("emits a file-scoped alias provide for every renamed or from-imported binding", async () => {
    const pack = await getPack();
    const a1 = pack.parse(
      "aliasrepo",
      "a1.py",
      "import services.memory_service as mem\n",
    );
    expect(a1.provides.filter((p) => p.scope === "file")).toEqual([
      {
        ref_kind: "symbol",
        name: "mem",
        node_id: null,
        alias_of: "services.memory_service",
        visibility: "public",
        scope: "file",
        scope_path: "a1.py",
      },
    ]);
    const a5 = pack.parse(
      "aliasrepo",
      "a5.py",
      "import services.memory_service\n",
    );
    expect(a5.provides.filter((p) => p.scope === "file")).toEqual([]); // binds `services` to itself: not an alias
  });
});

describe("bare names are file-scoped (parser §3.4)", () => {
  it("two files importing different functions under one bare name do not collide", async () => {
    const pack = await getPack();
    const results = parseTree(pack, "bare", fixture("bare-names"));
    const notes = results.find((r) => r.path === "notes.py");
    const reports = results.find((r) => r.path === "reports.py");
    expect(notes?.result.provides.filter((p) => p.scope === "file")).toEqual([
      {
        ref_kind: "symbol",
        name: "display",
        node_id: null,
        alias_of: "memory_service.display",
        visibility: "public",
        scope: "file",
        scope_path: "notes.py",
      },
    ]);
    expect(reports?.result.provides.filter((p) => p.scope === "file")).toEqual([
      {
        ref_kind: "symbol",
        name: "display",
        node_id: null,
        alias_of: "report_renderer.display",
        visibility: "public",
        scope: "file",
        scope_path: "reports.py",
      },
    ]);
    // The reference itself is already qualified: the bare name never leaves the pack.
    expect(
      refOf((notes?.result.edges[0] as { to: string | UnresolvedRef }).to)
        .value,
    ).toBe("memory_service.display");
    expect(
      refOf((reports?.result.edges[0] as { to: string | UnresolvedRef }).to)
        .value,
    ).toBe("report_renderer.display");

    const assembled = assemble(pack, results, "bare");
    expect(
      assembled.validation.ok,
      JSON.stringify(assembled.validation.errors),
    ).toBe(true);
    expect(assembled.ambiguous).toEqual([]);
    const byFrom = Object.fromEntries(
      assembled.graph.edges.map((e) => [e.from, e.to]),
    );
    expect(byFrom["bare:notes.py#render_note"]).toBe(
      "bare:memory_service.py#display",
    );
    expect(byFrom["bare:reports.py#render_report"]).toBe(
      "bare:report_renderer.py#display",
    );
  });
});

describe("definitions, scope and self (parser §3.5)", () => {
  const src = `
from repositories.note_repo import NoteRepository
from utils import helper as h

class Base:
    pass

class NoteService(Base):
    def __init__(self, cfg):
        self.repo = NoteRepository()
        self.cfg = cfg

    def _private(self):
        return 1

    async def update(self, note):
        self._private()
        local = h.build(note)
        local.run()
        return await self.repo.save(note)

def top(x):
    def inner(y):
        return NoteService(y)
    return inner(x)
`;

  it("emits module, class and method nodes with parents, and provides for each", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "repo",
      "server/services/note_service.py",
      src,
      SERVER,
    );
    expect(r.nodes.map((n) => [n.id, n.kind, n.parent])).toEqual([
      ["repo:server/services/note_service.py", "module", null],
      [
        "repo:server/services/note_service.py#Base",
        "class",
        "repo:server/services/note_service.py",
      ],
      [
        "repo:server/services/note_service.py#NoteService",
        "class",
        "repo:server/services/note_service.py",
      ],
      [
        "repo:server/services/note_service.py#NoteService.__init__",
        "function",
        "repo:server/services/note_service.py#NoteService",
      ],
      [
        "repo:server/services/note_service.py#NoteService._private",
        "function",
        "repo:server/services/note_service.py#NoteService",
      ],
      [
        "repo:server/services/note_service.py#NoteService.update",
        "function",
        "repo:server/services/note_service.py#NoteService",
      ],
      [
        "repo:server/services/note_service.py#top",
        "function",
        "repo:server/services/note_service.py",
      ],
    ]);
    const names = r.provides
      .filter((p) => p.scope === "global")
      .map((p) => [p.name, p.visibility]);
    expect(names).toContainEqual(["services.note_service", "public"]);
    expect(names).toContainEqual([
      "services.note_service.NoteService.update",
      "public",
    ]);
    expect(names).toContainEqual([
      "services.note_service.NoteService._private",
      "module",
    ]);
    for (const n of r.nodes) {
      const span = n.sources[0];
      expect(span?.hash).toMatch(/^sha256:[0-9a-f]{16}$/);
      expect((span?.line_end ?? 0) >= (span?.line_start ?? 1)).toBe(true);
    }
  });

  it("resolves self.method in-file, self.attr through its constructor, and names call-result receivers", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "repo",
      "server/services/note_service.py",
      src,
      SERVER,
    );
    const update = r.edges.filter((e) =>
      e.from.endsWith("#NoteService.update"),
    );
    const summary = update
      .map((e) =>
        typeof e.to === "string" ? e.to : `${e.to.ref_kind}:${e.to.value}`,
      )
      .sort();
    expect(summary).toEqual([
      "repo:server/services/note_service.py#NoteService._private",
      "symbol:repositories.note_repo.NoteRepository.save",
      "symbol:utils.helper.build",
      "symbol:utils.helper.build().run",
    ]);
    // `local = h.build(note); local.run()`: the receiver is a call result whose
    // type is not visible here, so the reference is named after the call.
    const viaCall = r.edges.find(
      (e) =>
        typeof e.to !== "string" && e.to.value === "utils.helper.build().run",
    );
    expect(viaCall?.confidence).toBe("inferred");
    expect(viaCall?.confidence_reason).toMatch(
      /result of utils\.helper\.build\(\)/,
    );
  });

  it("folds nested functions into the enclosing definition and resolves in-file constructors", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "repo",
      "server/services/note_service.py",
      src,
      SERVER,
    );
    expect(r.nodes.some((n) => n.id.includes("inner"))).toBe(false);
    const top = r.edges.filter((e) => e.from.endsWith("#top"));
    expect(top.map((e) => e.to)).toEqual([
      "repo:server/services/note_service.py#NoteService",
    ]);
    const init = r.edges.filter((e) =>
      e.from.endsWith("#NoteService.__init__"),
    );
    expect(
      init.map((e) => (typeof e.to === "string" ? e.to : e.to.value)),
    ).toEqual(["repositories.note_repo.NoteRepository"]);
  });

  it("names an un-annotated self attribute rather than guessing (parser §10 cheap version)", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "repo",
      "svc.py",
      "class S:\n    def run(self):\n        return self.repo.save()\n",
    );
    const edge = r.edges[0];
    expect(edge?.confidence).toBe("inferred");
    expect(edge?.confidence_reason).toMatch(
      /self\.repo has no annotation or constructor assignment/,
    );
    expect(refOf((edge as { to: string | UnresolvedRef }).to).value).toBe(
      "svc.S.repo.save",
    );
  });

  it("skips the standard library and builtins silently", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "repo",
      "m.py",
      "import os\nimport json\ndef f(x):\n    print(len(x))\n    return json.dumps(os.getenv('A'))\n",
    );
    expect(r.edges).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });
});

describe("factory calls: receiver types from return annotations", () => {
  const src = [
    "from services import get_s3_service",
    "from repositories.note_repo import NoteRepo",
    "from typing import Any",
    "",
    "def make() -> NoteRepo:",
    "    return NoteRepo()",
    "",
    "def opaque() -> Any:",
    "    return {}",
    "",
    "def f(x):",
    "    s = get_s3_service()",
    "    s.upload(x)",
    "    get_s3_service().delete(x)",
    "    r = make()",
    "    r.save(x)",
    "    opaque().get(x)",
    "",
  ].join("\n");

  it("resolves through an in-file factory's return annotation, and names the call otherwise", async () => {
    const pack = await getPack();
    const r = pack.parse("repo", "m.py", src);
    const f = r.edges
      .filter((e) => e.from.endsWith("#f"))
      .map((e) => [typeof e.to === "string" ? e.to : e.to.value, e.confidence]);
    expect(f).toEqual([
      ["services.get_s3_service", "certain"],
      ["services.get_s3_service().upload", "inferred"],
      ["services.get_s3_service", "certain"],
      ["services.get_s3_service().delete", "inferred"],
      ["repo:m.py#make", "certain"],
      ["repositories.note_repo.NoteRepo.save", "certain"],
      ["repo:m.py#opaque", "certain"],
      ["m.opaque().get", "inferred"],
    ]);
    const reason = r.edges.find(
      (e) => typeof e.to !== "string" && e.to.value.includes("().upload"),
    )?.confidence_reason;
    expect(reason).toMatch(
      /result of services\.get_s3_service\(\); its return type is not visible/,
    );
  });

  it("emits a `fn()` alias for a return annotation that names a type, never for stdlib types", async () => {
    const pack = await getPack();
    const r = pack.parse("repo", "m.py", src);
    const aliases = r.provides.filter((p) => p.name.endsWith("()"));
    expect(aliases).toEqual([
      {
        ref_kind: "symbol",
        name: "m.make()",
        node_id: null,
        alias_of: "repositories.note_repo.NoteRepo",
        visibility: "public",
        scope: "global",
        scope_path: null,
      },
    ]);
  });
});
