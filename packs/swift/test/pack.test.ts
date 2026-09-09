import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PackResultSchema,
  edgeId,
  serializeCanonical,
  validate,
  toPerFileResult,
  type PartialEdge,
  type PerFileResult,
  type UnresolvedRef,
} from "@waterslide/core";
import {
  SwiftPack,
  applyPatch,
  compose,
  composeWithReport,
  pack,
  rePath,
  spanHash,
} from "../src/index.js";
import { assemble, shuffle } from "../scripts/run.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const kitchen = readFileSync(join(FIXTURES, "Kitchen.swift"), "utf8");
const swift = new SwiftPack();

async function fileResult(
  repo: string,
  path: string,
  content: string,
): Promise<PerFileResult> {
  return toPerFileResult(
    repo,
    path,
    await swift.parse(repo, path, content, {}),
  );
}

function ref(e: PartialEdge): UnresolvedRef | null {
  return typeof e.to === "string" ? null : e.to;
}

function httpHints(r: UnresolvedRef | null | undefined) {
  return r?.ref_kind === "http" ? r.hints : undefined;
}

describe("manifest and module export", () => {
  it("declares .swift and the SwiftUI/URLSession recognizers, at the current graph model version", () => {
    expect(pack.manifest.id).toBe("swift");
    expect(pack.manifest.extensions).toEqual([".swift"]);
    expect(pack.manifest.frameworks).toContain("swiftui");
  });

  it("returns the five contract returns plus file-level pack_data from parse()", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    expect(Object.keys(r).sort()).toEqual([
      "diagnostics",
      "edges",
      "nodes",
      "pack_data",
      "provides",
      "schemas",
    ]);
    expect(r.pack_data?.swift).toBeDefined();
    expect(r.nodes.every((n) => n.pack_data === undefined)).toBe(true);
    expect(PackResultSchema.safeParse(r).success).toBe(true);
  });
});

describe("language recognizers", () => {
  it("emits the module node, every type and function, with nesting as parent", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const ids = new Set(r.nodes.map((n) => n.id));
    expect(ids.has("k:Kitchen.swift")).toBe(true);
    expect(ids.has("k:Kitchen.swift#NoteService")).toBe(true);
    expect(ids.has("k:Kitchen.swift#NoteService.list")).toBe(true);
    const list = r.nodes.find(
      (n) => n.id === "k:Kitchen.swift#NoteService.list",
    );
    expect(list?.parent).toBe("k:Kitchen.swift#NoteService");
    expect(list?.kind).toBe("function");
    const type = r.nodes.find((n) => n.id === "k:Kitchen.swift#NoteService");
    expect(type?.parent).toBe("k:Kitchen.swift");
    expect(type?.kind).toBe("client_service");
  });

  it("disambiguates overloads by parameter labels, then ordinal, and provides the plain name for both", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const ids = r.nodes
      .map((n) => n.id)
      .filter((id) => id.includes("APIClient.request"));
    expect(ids.sort()).toEqual([
      "k:Kitchen.swift#APIClient.request(_:)[0]",
      "k:Kitchen.swift#APIClient.request(_:)[1]",
    ]);
    const plain = r.provides.filter((p) => p.name === "APIClient.request");
    expect(plain).toHaveLength(2);
    expect(
      plain.every((p) => p.scope === "global" && p.scope_path === null),
    ).toBe(true);
  });

  it("maps access modifiers to visibility: default module, private → private", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const multipart = r.provides.find(
      (p) => p.name === "NoteService.multipart",
    );
    expect(multipart?.visibility).toBe("private");
    const list = r.provides.find((p) => p.name === "NoteService.list");
    expect(list?.visibility).toBe("module");
  });

  it("merges a same-file extension into the declared type: one node, two spans, members parented", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const ns = r.nodes.find((n) => n.id === "k:Kitchen.swift#NoteService");
    expect(ns?.sources).toHaveLength(2);
    const archive = r.nodes.find(
      (n) => n.id === "k:Kitchen.swift#NoteService.archive",
    );
    expect(archive?.parent).toBe("k:Kitchen.swift#NoteService");
  });

  it("emits Codable types as schemas with declaration-order fields and in-file refs", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const note = r.schemas.find((s) => s.id === "sch:k:Kitchen.swift#Note");
    expect(note?.fields.map((f) => f.name)).toEqual([
      "id",
      "title",
      "author",
      "tags",
    ]);
    expect(note?.fields[1]?.optional).toBe(true);
    expect(note?.fields[2]?.ref_schema_id).toBe("sch:k:Kitchen.swift#Author");
  });

  it("resolves typealias, self context and in-file receivers to string targets", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const reload = r.edges.find((e) =>
      e.from.endsWith("#NotesViewModel.reload"),
    );
    expect(reload?.to).toBe("k:Kitchen.swift#NoteService.list");
    // P is a typealias for StubProvider, which is not declared: the ref is a candidate, not an edge.
    expect(r.edges.some((e) => e.from.endsWith("#NotesViewModel.track"))).toBe(
      false,
    );
  });

  it("marks @main App conformers as app_launch entry points", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const app = r.nodes.find((n) => n.id === "k:Kitchen.swift#KitchenApp");
    expect(app?.is_entry_point).toBe(true);
    expect(app?.entry_point_kind).toBe("app_launch");
  });
});

describe("SwiftUI entry points (items 8, 9)", () => {
  it("emits every handler closure as a ui_handler entry point with a stable ordinal id", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const handlers = r.nodes.filter((n) => n.kind === "ui_handler");
    expect(
      handlers.every(
        (n) => n.is_entry_point && n.entry_point_kind === "ui_handler",
      ),
    ).toBe(true);
    const ids = handlers.map((n) => n.id.split("#")[1]).sort();
    expect(ids).toEqual([
      "NotesView.Button[0]",
      "NotesView.Button[1]",
      "NotesView.Button[2]",
      "NotesView.onAppear[0]",
      "NotesView.onChange[0]",
      "NotesView.onDisappear[0]",
      "NotesView.onSubmit[0]",
      "NotesView.refreshable[0]",
      "NotesView.task[0]",
    ]);
    expect(handlers.find((n) => n.id.endsWith("Button[0]"))?.label).toBe(
      'NotesView "Reload" button',
    );
    expect(
      handlers.every((n) => n.parent === "k:Kitchen.swift#NotesView"),
    ).toBe(true);
  });

  it("marks a method passed as Button(action:) as the entry point", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const sync = r.nodes.find((n) => n.id === "k:Kitchen.swift#NotesView.sync");
    expect(sync?.is_entry_point).toBe(true);
    expect(sync?.entry_point_kind).toBe("ui_handler");
    const clear = r.nodes.find(
      (n) => n.id === "k:Kitchen.swift#NotesViewModel.clear",
    );
    expect(clear?.is_entry_point).toBe(true);
  });

  it("emits a direct http edge from a handler closure that sends its own request", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const e = r.edges.find(
      (x) =>
        x.from.endsWith("#NotesView.onDisappear[0]") &&
        x.kind === "http_request",
    );
    const to = e === undefined ? null : ref(e);
    expect(to?.value).toBe("/api/ping");
    expect(httpHints(to)?.base_url_expr).toBe('"https://x.example"');
    expect(e?.confidence).toBe("certain");
  });

  it("shares one handler counter across two extension blocks of the same type in a file", async () => {
    const src = `extension Detail { var a: some View { Text("a").task { await load() } } }\nextension Detail { var b: some View { Text("b").task { await load() } } }\n`;
    const r = await pack.parse("k", "Detail+Views.swift", src, {});
    const ids = r.nodes
      .filter((n) => n.kind === "ui_handler")
      .map((n) => n.id.split("#")[1])
      .sort();
    expect(ids).toEqual(["Detail.task[0]", "Detail.task[1]"]);
  });

  it("reports per-file state that fails the pack's own schema instead of dropping the file silently", async () => {
    const good = await fileResult("r", "A.swift", "class A {}\n");
    const bad = {
      ...good,
      path: "B.swift",
      pack_data: { swift: { version: 99 } },
    };
    const patch = compose([good, bad]);
    expect(
      patch.diagnostics.some(
        (d) => d.code === "recognizer_failure" && d.path === "B.swift",
      ),
    ).toBe(true);
  });

  it("attributes calls inside a handler closure to the handler, not the view", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const e = r.edges.find((x) => x.from.endsWith("#NotesView.task[0]"));
    expect(e?.to).toBe("k:Kitchen.swift#NotesViewModel.reload");
  });
});

describe("URL reconstruction (items 3, 10, 11)", () => {
  it("reads a literal path at the call site as certain, with method and base URL expression", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const e = r.edges.find(
      (x) => x.from.endsWith("#NoteService.login") && x.kind === "http_request",
    );
    const to = e === undefined ? null : ref(e);
    expect(to?.value).toBe("/api/auth/token");
    expect(httpHints(to)?.method).toBe("POST");
    expect(httpHints(to)?.base_url_expr).toBe("apiClient.baseURL");
    expect(e?.confidence).toBe("certain");
  });

  it("follows the Endpoint helper two hops and reports the path as inferred with a reason naming the hops", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const get = r.edges.find(
      (x) => x.from.endsWith("#NoteService.get") && x.kind === "http_request",
    );
    const to = get === undefined ? null : ref(get);
    expect(to?.value).toBe("/api/notes/{id}");
    expect(httpHints(to)?.method).toBe("GET");
    expect(get?.confidence).toBe("inferred");
    expect(get?.confidence_reason).toContain("Endpoint.request");
    const archive = r.edges.find(
      (x) =>
        x.from.endsWith("#NoteService.archive") && x.kind === "http_request",
    );
    expect(httpHints(ref(archive as PartialEdge))?.method).toBe("POST");
  });

  it("splits a query string out of the path into hints.query", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const list = r.edges.find(
      (x) => x.from.endsWith("#NoteService.list") && x.kind === "http_request",
    );
    const to = list === undefined ? null : ref(list);
    expect(to?.value).toBe("/api/notes");
    expect(httpHints(to)?.query).toBe("archived=false");
  });

  it("never guesses: a runtime URL is {unresolved} with a reason naming what stopped it", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const send = r.edges.find(
      (x) =>
        x.from.endsWith("#APIClient.request(_:)[1]") &&
        x.kind === "http_request",
    );
    const to = send === undefined ? null : ref(send);
    expect(to?.value).toBe("{unresolved}");
    expect(send?.confidence).toBe("inferred");
    expect(send?.confidence_reason).toContain("parameter");
    expect(r.diagnostics.some((d) => d.code === "url_unresolved")).toBe(true);
  });

  it("stops at the hop cap and leaves a symbol ref plus a diagnostic", async () => {
    const src = `
struct Endpoint { let path: String
  var request: URLRequest { URLRequest(url: URL(string: "https://x" + path)!) } }
class Client {
  func request(_ e: Endpoint) async throws -> Data { try await send(e.request) }
  func send(_ r: URLRequest) async throws -> Data { try await go(r) }
  func go(_ r: URLRequest) async throws -> Data { try await URLSession.shared.data(for: r).0 }
  func viaWrapper(_ e: Endpoint) async throws -> Data { try await request(e) }
}
class Svc { let c = Client()
  func deep() async throws { _ = try await c.viaWrapper(Endpoint(path: "/deep")) }
  func shallow() async throws { _ = try await c.request(Endpoint(path: "/shallow")) }
}`;
    const r = await pack.parse("k", "Hops.swift", src, {});
    const shallow = r.edges.find(
      (e) => e.from.endsWith("#Svc.shallow") && e.kind === "http_request",
    );
    expect(ref(shallow as PartialEdge)?.value).toBe("/shallow");
    const deep = r.edges.filter((e) => e.from.endsWith("#Svc.deep"));
    expect(deep.some((e) => e.kind === "http_request")).toBe(false);
    expect(
      deep.some(
        (e) => e.kind === "call" && e.to === "k:Hops.swift#Client.viaWrapper",
      ),
    ).toBe(true);
    expect(
      r.diagnostics.some((d) => d.code === "url_reconstruction_hop_cap"),
    ).toBe(true);
  });
});

describe("branch detection and the error-path table (§6)", () => {
  it("groups alternatives, numbers them in source order, and marks guard-else and catch limbs as error paths", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const login = r.edges.filter(
      (e) => e.from.endsWith("#NoteService.login") && e.kind === "call",
    );
    const guardElse = login.find((e) => e.condition?.expr.startsWith("guard"));
    expect(guardElse?.is_error_path).toBe(true);
    // The guard's continue limb holds only sites claimed by the nested if/else
    // and do/catch forks, so the guard has a single alternative left and forms
    // no group; the else edge keeps its condition and error-path flag.
    expect(guardElse?.exclusive_group).toBeNull();
    expect(guardElse?.condition?.expr).toContain("guard");
    const ifLimb = login.find((e) => e.condition?.expr === "if data.isEmpty");
    const elseLimb = login.find(
      (e) =>
        e.condition?.expr === "else" &&
        e.exclusive_group === ifLimb?.exclusive_group,
    );
    expect(ifLimb?.branch_ordinal).toBe(0);
    expect(elseLimb?.branch_ordinal).toBe(1);
    expect(ifLimb?.is_error_path).toBe(false);
    // A catch that throws is an error path outright: certain.
    const catchThrows = login.find((e) => e.condition?.expr === "catch");
    expect(catchThrows?.is_error_path).toBe(true);
    expect(catchThrows?.confidence).toBe("certain");
    // The do limb's only call is JSONDecoder, a cross-file candidate that is
    // never drawn, so catch is the sole definite alternative: ordinal 0.
    expect(catchThrows?.branch_ordinal).toBe(0);
    // A catch that only logs is the §10 open question: defaulted to true, said so.
    const upload = r.edges.filter((e) =>
      e.from.endsWith("#NoteService.upload"),
    );
    const catchLogs = upload.find((e) => e.condition?.expr === "catch");
    expect(catchLogs?.is_error_path).toBe(true);
    expect(catchLogs?.confidence).toBe("inferred");
    expect(catchLogs?.confidence_reason).toContain("catch");
    const doLimb = upload.filter((e) => e.condition?.expr === "do");
    // Settled ordinal rule: every edge in the limb carries the group and the
    // limb's ordinal; two edges from one limb are the same alternative.
    expect(doLimb.length).toBe(2);
    expect(
      doLimb.every(
        (e) =>
          e.exclusive_group === catchLogs?.exclusive_group &&
          e.branch_ordinal === 0,
      ),
    ).toBe(true);
    expect(catchLogs?.branch_ordinal).toBe(1);
    expect(doLimb.every((e) => !e.is_error_path)).toBe(true);
  });

  it("never shares an ordinal across limbs: same (group, ordinal) implies same condition and no mismatch diagnostic", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    expect(
      r.diagnostics.some((d) => d.code === "branch_ordinal_limb_mismatch"),
    ).toBe(false);
    const byPair = new Map<string, Set<string>>();
    for (const e of r.edges) {
      if (e.exclusive_group === null) continue;
      const key = `${e.exclusive_group} ${String(e.branch_ordinal)}`;
      const s = byPair.get(key) ?? new Set<string>();
      s.add(JSON.stringify(e.condition));
      byPair.set(key, s);
    }
    expect(byPair.size).toBeGreaterThan(0);
    for (const s of byPair.values()) expect(s.size).toBe(1);
    // The shared case exists in the fixture: two edges in upload's do limb.
    expect(
      [...byPair.keys()].some((k) =>
        k.endsWith("NoteService.upload/branch[0] 0"),
      ),
    ).toBe(true);
  });

  it("produces no group for a branch point whose edges sit in one limb only", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    const reload = r.edges.find((e) =>
      e.from.endsWith("#NotesViewModel.reload"),
    );
    expect(reload?.condition?.expr).toBe("do");
    expect(reload?.exclusive_group).toBeNull();
    expect(reload?.branch_ordinal).toBeNull();
  });
});

describe("a pack never throws (§9)", () => {
  it("returns a partial result plus a syntax_error diagnostic for a broken file", async () => {
    const r = await pack.parse(
      "k",
      "Broken.swift",
      "struct A { func f() { let x = }\nclass B { func g() {} }\n",
      {},
    );
    expect(
      r.diagnostics.some(
        (d) => d.code === "syntax_error" && d.severity === "error",
      ),
    ).toBe(true);
    expect(r.nodes.some((n) => n.id === "k:Broken.swift")).toBe(true);
  });

  it("emits only the module node and an empty_file diagnostic for an empty file", async () => {
    const r = await pack.parse("k", "Empty.swift", "", {});
    expect(r.nodes.map((n) => n.id)).toEqual(["k:Empty.swift"]);
    expect(r.diagnostics.some((d) => d.code === "empty_file")).toBe(true);
  });

  it("names a construct no recognizer handles and still emits what it understood", async () => {
    const r = await pack.parse(
      "k",
      "Odd.swift",
      "class C { func f() { let h = { print(1) }\n h()\n foo()() } }\n",
      {},
    );
    expect(r.nodes.some((n) => n.id === "k:Odd.swift#C.f")).toBe(true);
    expect(r.diagnostics.some((d) => d.code === "unsupported_construct")).toBe(
      true,
    );
  });

  it("survives garbage without throwing", async () => {
    await expect(
      pack.parse("k", "G.swift", " ￿{{{{, {}))) import", {}),
    ).resolves.toBeDefined();
  });
});

describe("compose: extensions across files and helper resolution across files", () => {
  const model = `struct Note: Codable { let id: String }\n`;
  const ext = `extension Note {\n    func toJSON() -> Data { Data() }\n}\nextension Color {\n    static let brand = Color.red\n}\n`;
  const ext2 = `extension Color {\n    static let accent = Color.blue\n}\n`;

  it("adds the extension span to the declaring type and parents extension members to it", async () => {
    const results = [
      await fileResult("r", "Extensions/Note+JSON.swift", ext),
      await fileResult("r", "Models/Note.swift", model),
    ];
    const patch = compose(results);
    const merged = applyPatch(results, patch);
    const note = merged.nodes.find((n) => n.id === "r:Models/Note.swift#Note");
    expect(note?.sources.map((s) => s.path).sort()).toEqual([
      "Extensions/Note+JSON.swift",
      "Models/Note.swift",
    ]);
    const toJSON = merged.nodes.find(
      (n) => n.id === "r:Extensions/Note+JSON.swift#Note.toJSON",
    );
    expect(toJSON?.parent).toBe("r:Models/Note.swift#Note");
    expect(
      merged.nodes.some(
        (n) => n.id.endsWith("#Note") && n.id !== "r:Models/Note.swift#Note",
      ),
    ).toBe(false);
  });

  it("mints a framework type at its first extension file and adds later extensions as spans", async () => {
    const results = [
      await fileResult("r", "Extensions/Note+JSON.swift", ext),
      await fileResult("r", "Theme/Color+Accent.swift", ext2),
    ];
    const merged = applyPatch(results, compose(results));
    const color = merged.nodes.find(
      (n) => n.id === "r:Extensions/Note+JSON.swift#Color",
    );
    expect(color?.sources.map((s) => s.path)).toEqual([
      "Extensions/Note+JSON.swift",
      "Theme/Color+Accent.swift",
    ]);
    expect(merged.nodes.filter((n) => n.label === "Color")).toHaveLength(1);
  });

  it("reconstructs a path through a helper declared in another file and reports the client_service change it cannot express", async () => {
    const client = `struct Endpoint { let path: String; let method: String
  var request: URLRequest { var r = URLRequest(url: URL(string: APIClient.shared.baseURL + path)!); r.httpMethod = method; return r } }
class APIClient { static let shared = APIClient(); var baseURL = "https://x"
  func request<T: Decodable>(_ e: Endpoint) async throws -> T { try await request(e.request) }
  func request<T: Decodable>(_ r: URLRequest) async throws -> T { let (d, _) = try await URLSession.shared.data(for: r); return try JSONDecoder().decode(T.self, from: d) } }`;
    const service = `struct Memory: Codable { let id: String }
class MemoryService { private let apiClient = APIClient.shared
  func getMemory(id: String) async throws -> Memory {
    let endpoint = Endpoint(path: "/api/memories/memory/\\(id)", method: "GET")
    return try await apiClient.request(endpoint) as Memory } }`;
    const results = [
      await fileResult("r", "Networking/APIClient.swift", client),
      await fileResult("r", "Services/MemoryService.swift", service),
    ];
    const patch = compose(results);
    const http = patch.edges.find((e) => e.kind === "http_request");
    const to = http === undefined ? null : ref(http);
    expect(to?.value).toBe("/api/memories/memory/{id}");
    expect(httpHints(to)?.method).toBe("GET");
    expect(httpHints(to)?.base_url_expr).toBe("APIClient.shared.baseURL");
    expect(http?.confidence).toBe("inferred");
    expect(http?.response_schema_id).toBe(
      "sch:r:Services/MemoryService.swift#Memory",
    );
    const merged = applyPatch(results, patch);
    expect(
      merged.nodes.find(
        (n) => n.id === "r:Services/MemoryService.swift#MemoryService",
      )?.kind,
    ).toBe("client_service");
    // The consumed Endpoint construction carries no edge of its own.
    expect(
      merged.edges.filter((e) => e.from.endsWith("#MemoryService.getMemory")),
    ).toHaveLength(1);
  });

  it("numbers a candidate-only fork limb after the definite alternatives, contiguously", async () => {
    const a = `class Logger { static let shared = Logger(); func log(_ s: String) {} }\n`;
    const b = `class Svc {\n  func f(x: Bool) {\n    if x {\n      Logger.shared.log("a")\n    } else {\n      helper()\n    }\n  }\n  func helper() {}\n}\n`;
    const results = [
      await fileResult("r", "A.swift", a),
      await fileResult("r", "B.swift", b),
    ];
    const merged = applyPatch(results, compose(results));
    const fork = merged.edges.filter(
      (e) => e.from === "r:B.swift#Svc.f" && e.exclusive_group !== null,
    );
    expect(fork).toHaveLength(2);
    const helper = fork.find((e) => e.to === "r:B.swift#Svc.helper");
    const log = fork.find((e) => ref(e)?.value === "Logger.log");
    // The definite limb (else) is numbered per-file as 0; the candidate-only
    // limb (if) is appended by compose as 1: contiguous, drawn alternatives only.
    expect(helper?.branch_ordinal).toBe(0);
    expect(log?.branch_ordinal).toBe(1);
    expect(log?.exclusive_group).toBe(helper?.exclusive_group);
  });

  it("drops calls on framework types with a visible count and keeps calls on declared types as symbol refs", async () => {
    const a = `class Logger { static let shared = Logger(); func log(_ s: String) {} }\n`;
    const b = `class Svc { func f() { Logger.shared.log("x"); JSONEncoder().encode(1) } }\n`;
    const results = [
      await fileResult("r", "A.swift", a),
      await fileResult("r", "B.swift", b),
    ];
    const patch = compose(results);
    expect(patch.edges.map((e) => ref(e)?.value)).toEqual(["Logger.log"]);
    expect(
      patch.diagnostics.some(
        (d) =>
          d.code === "external_type_reference" &&
          d.message.includes("JSONEncoder"),
      ),
    ).toBe(true);
  });
});

describe("noise: calls that tell a reader nothing are not drawn (data/noise.json)", () => {
  const models = `struct Note: Codable { let id: String }\nenum Kind: CaseIterable { case a, b }\nenum Failure: Error { case network(Error?), decoding }\n`;

  it("treats a call on a collection of a user type as a Standard Library call, not a member of the type", async () => {
    const svc = `class Svc {\n  var notes: [Note] = []\n  func f(items: [Note]) -> [String] {\n    let ids = items.map { $0.id }\n    notes.append(Note(id: "x"))\n    let extra = Note(id: "y")\n    return ids + notes.filter { $0.id != "" }.map(\\.id)\n  }\n}\n`;
    const results = [
      await fileResult("r", "Models.swift", models),
      await fileResult("r", "Svc.swift", svc),
    ];
    const merged = applyPatch(results, compose(results));
    const values = merged.edges.map((e) =>
      typeof e.to === "string" ? e.to : e.to.value,
    );
    expect(values.some((v) => /^Note\.(map|append|filter)$/.test(v))).toBe(
      false,
    );
    // A construction that is not consumed as an argument is still drawn.
    expect(values.some((v) => v.endsWith("#Note") || v === "Note")).toBe(true);
  });

  it("keeps a user type's own filter method: membership is checked before any name", async () => {
    const svc = `class Svc {\n  func g(n: Note) { n.filter() }\n}\nextension Note { func filter() {} }\n`;
    const results = [
      await fileResult("r", "Models.swift", models),
      await fileResult("r", "Svc.swift", svc),
    ];
    const merged = applyPatch(results, compose(results));
    expect(
      merged.edges.some(
        (e) => typeof e.to !== "string" && e.to.value === "Note.filter",
      ),
    ).toBe(true);
  });

  it("does not draw an enum case construction, a SwiftUI modifier on a user view, a subscript, or a synthesized static", async () => {
    const src = `struct Row: View { var body: some View { Text("x") } }\nclass Svc {\n  var rows: [Row] = []\n  func h() throws {\n    let r = rows[0]\n    Row().padding()\n    let k = Kind.allCases.enumerated()\n    throw Failure.network(nil)\n  }\n}\n`;
    const results = [
      await fileResult("r", "Models.swift", models),
      await fileResult("r", "Svc.swift", src),
    ];
    const merged = applyPatch(results, compose(results));
    const values = merged.edges
      .filter((e) => e.from.endsWith("#Svc.h"))
      .map((e) => (typeof e.to === "string" ? e.to : e.to.value));
    expect(values.filter((v) => !v.endsWith("#Row") && v !== "Row")).toEqual(
      [],
    );
    expect(
      merged.diagnostics.filter(
        (d) => d.severity === "warning" && d.path === "Svc.swift",
      ),
    ).toEqual([]);
  });

  it("never applies the stdlib-name guard to a protocol requirement", async () => {
    const src = `protocol Session { func append(_ b: Int) }\nclass Rec {\n  let s: Session\n  init(s: Session) { self.s = s }\n  func push() { s.append(1) }\n}\n`;
    const results = [await fileResult("r", "Rec.swift", src)];
    const merged = applyPatch(results, compose(results));
    // The requirement is declared in this file, so the call resolves to it directly.
    expect(
      merged.edges.some((e) => e.to === "r:Rec.swift#Session.append"),
    ).toBe(true);
  });

  it("does not guess that an undeclared static member is a singleton instance", async () => {
    const src = `enum Theme: CaseIterable { case warm, cold }\nclass Svc {\n  func t() { Theme.registry.render(); Theme.allCases.enumerated() }\n}\n`;
    const results = [await fileResult("r", "Svc.swift", src)];
    const merged = applyPatch(results, compose(results));
    expect(
      merged.edges.some(
        (e) => typeof e.to !== "string" && /^Theme\./.test(e.to.value),
      ),
    ).toBe(false);
  });
});

describe("protocol requirements, dispatch fan-out and closure slots (item 2)", () => {
  const proto = `protocol Backend {\n  var isReady: Bool { get }\n  func send(_ x: Int) async throws\n  func stop()\n}\n`;
  const live = `struct LiveBackend: Backend {\n  var isReady: Bool { true }\n  func send(_ x: Int) async throws {}\n  func stop() {}\n}\n`;
  const stub = `final class StubBackend: Backend {\n  var isReady: Bool { false }\n  func send(_ x: Int) async throws {}\n  func stop() {}\n}\n`;
  const user = `class VM {\n  let backend: Backend\n  init(backend: Backend = LiveBackend()) { self.backend = backend }\n  func go() async throws { try await backend.send(1); backend.stop() }\n}\n`;

  it("emits a certain node and a provide for each protocol requirement, and a call on a protocol-typed value resolves to it", async () => {
    const results = [
      await fileResult("r", "Backend.swift", proto),
      await fileResult("r", "Live.swift", live),
      await fileResult("r", "Stub.swift", stub),
      await fileResult("r", "VM.swift", user),
    ];
    const merged = applyPatch(results, compose(results));
    const req = merged.nodes.find(
      (n) => n.id === "r:Backend.swift#Backend.send",
    );
    expect(req?.kind).toBe("function");
    expect(req?.confidence).toBe("certain");
    expect(req?.label).toBe("Backend.send (requirement)");
    expect(
      merged.provides.some(
        (p) => p.name === "Backend.send" && p.node_id === req?.id,
      ),
    ).toBe(true);
    const call = merged.edges.find(
      (e) =>
        e.from === "r:VM.swift#VM.go" &&
        typeof e.to !== "string" &&
        e.to.value === "Backend.send",
    );
    expect(call).toBeDefined();
  });

  it("fans each requirement out to every conformer's implementation, inferred, with the conformer count in the reason", async () => {
    const results = [
      await fileResult("r", "Backend.swift", proto),
      await fileResult("r", "Live.swift", live),
      await fileResult("r", "Stub.swift", stub),
    ];
    const { patch, report } = composeWithReport(results);
    const fan = patch.edges.filter(
      (e) => e.from === "r:Backend.swift#Backend.send",
    );
    expect(fan.map((e) => e.to).sort()).toEqual([
      "r:Live.swift#LiveBackend.send",
      "r:Stub.swift#StubBackend.send",
    ]);
    expect(
      fan.every(
        (e) =>
          e.confidence === "inferred" &&
          e.exclusive_group === null &&
          e.source === null,
      ),
    ).toBe(true);
    expect(fan[0]?.confidence_reason).toContain("2 conformers of Backend");
    expect(report.dispatch.get("Backend")).toBe(2);
    expect(report.dispatch_edges).toBe(4);
  });

  it("gives a closure-typed stored property a slot node so calls on it resolve, instance and static", async () => {
    const src = `struct Scene {\n  let onExit: () -> Void\n  var onUpdate: ((Int) -> Void)?\n  class Coordinator {\n    let parent: Scene\n    init(parent: Scene) { self.parent = parent }\n    func done() { parent.onExit(); parent.onUpdate?(1); Services.make() }\n  }\n}\nenum Services {\n  static var make: () -> Int = { 1 }\n}\n`;
    const r = await pack.parse("r", "Scene.swift", src, {});
    const slot = r.nodes.find((n) => n.id === "r:Scene.swift#Scene.onExit");
    expect(slot?.kind).toBe("function");
    expect(slot?.label).toBe("Scene.onExit (closure property)");
    const targets = r.edges
      .filter((e) => e.from === "r:Scene.swift#Scene.Coordinator.done")
      .map((e) => e.to);
    expect(targets).toEqual(
      expect.arrayContaining([
        "r:Scene.swift#Scene.onExit",
        "r:Scene.swift#Scene.onUpdate",
        "r:Scene.swift#Services.make",
      ]),
    );
  });

  it("drops a SwiftUI modifier on a UIViewRepresentable, which is a View too", async () => {
    const src = `struct SceneView: UIViewRepresentable { func makeUIView(context: Context) -> UIView { UIView() } }\nstruct Host: View { var body: some View { SceneView().ignoresSafeArea() } }\n`;
    const results = [await fileResult("r", "SceneView.swift", src)];
    const merged = applyPatch(results, compose(results));
    expect(
      merged.edges.some(
        (e) =>
          typeof e.to !== "string" &&
          e.to.value === "SceneView.ignoresSafeArea",
      ),
    ).toBe(false);
    expect(
      merged.nodes.find((n) => n.id === "r:SceneView.swift#SceneView")?.kind,
    ).toBe("ui_view");
  });
});

describe("review of #24: Self in extensions, cross-file static properties, table validation", () => {
  it("resolves a static call through `Self` inside a cross-file extension", async () => {
    const decl = `struct Config {\n  static func probe(_ s: String) -> Bool { true }\n}\n`;
    const ext = `extension Config {\n  func detect() { _ = Self.probe("x") }\n}\n`;
    const results = [
      await fileResult("r", "Config.swift", decl),
      await fileResult("r", "Config+Detect.swift", ext),
    ];
    const merged = applyPatch(results, compose(results));
    const e = merged.edges.find(
      (x) => x.from === "r:Config+Detect.swift#Config.detect",
    );
    expect(e).toBeDefined();
    expect(typeof e?.to === "string" ? e?.to : e?.to.value).toMatch(
      /Config\.probe$/,
    );
  });

  it("resolves a call through a static property declared in another file's extension of an in-file type", async () => {
    const a = `final class Svc {\n  func run() {}\n  func go() { Svc.shared.run() }\n}\n`;
    const b = `extension Svc {\n  static let shared = Svc()\n}\n`;
    const results = [
      await fileResult("r", "Svc.swift", a),
      await fileResult("r", "Svc+Shared.swift", b),
    ];
    const merged = applyPatch(results, compose(results));
    const e = merged.edges.find((x) => x.from === "r:Svc.swift#Svc.go");
    expect(e).toBeDefined();
    expect(typeof e?.to === "string" ? e?.to : e?.to.value).toMatch(
      /Svc\.run$/,
    );
  });

  it("still does not guess when the static member is declared nowhere", async () => {
    const a = `final class Svc {\n  func run() {}\n  func go() { Svc.mystery.run() }\n}\n`;
    const results = [await fileResult("r", "Svc.swift", a)];
    const merged = applyPatch(results, compose(results));
    expect(merged.edges.some((x) => x.from === "r:Svc.swift#Svc.go")).toBe(
      false,
    );
  });
});

describe("rePath (amendment B3)", () => {
  it("recomputes every path-derived field and nothing else", async () => {
    const before = await fileResult("k", "Old/Kitchen.swift", kitchen);
    const after = rePath(before, "k", "New/Dir/Kitchen.swift");
    const fresh = await fileResult("k", "New/Dir/Kitchen.swift", kitchen);
    expect(JSON.stringify(after)).toBe(JSON.stringify(fresh));
  });
});

describe("spanHash (item 6c)", () => {
  it("is sha256: plus 16 hex over the NFC text", () => {
    expect(spanHash("")).toBe("sha256:e3b0c44298fc1c14");
    expect(spanHash("é")).toBe(spanHash("é"));
  });
});

describe("determinism and the validator (handoff §6 items 1 and 2)", () => {
  async function parseAll(order: "sorted" | number): Promise<PerFileResult[]> {
    let files = readdirSync(FIXTURES)
      .filter((f) => f.endsWith(".swift"))
      .sort();
    if (order !== "sorted") files = shuffle(files, order);
    const out: PerFileResult[] = [];
    for (const f of files)
      out.push(
        await fileResult("fx", f, readFileSync(join(FIXTURES, f), "utf8")),
      );
    return out;
  }

  it("assembles a canonical graph that passes every invariant", async () => {
    const { graph } = assemble(await parseAll("sorted"), "fx", "0".repeat(40));
    const bytes = serializeCanonical(graph);
    const v = validate(JSON.parse(bytes), { shape: "canonical" });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("is byte-identical across runs and under shuffled discovery order", async () => {
    const a = serializeCanonical(
      assemble(await parseAll("sorted"), "fx", "0".repeat(40)).graph,
    );
    const b = serializeCanonical(
      assemble(await parseAll("sorted"), "fx", "0".repeat(40)).graph,
    );
    const c = serializeCanonical(
      assemble(await parseAll(7), "fx", "0".repeat(40)).graph,
    );
    const d = serializeCanonical(
      assemble(await parseAll(12345), "fx", "0".repeat(40)).graph,
    );
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(d).toBe(a);
  });

  it("never emits an edge id itself: PartialEdge carries no id, so core derives them", async () => {
    const r = await pack.parse("k", "Kitchen.swift", kitchen, {});
    expect(r.edges.every((e) => !("id" in e))).toBe(true);
    const e = r.edges.find((x) => typeof x.to === "string");
    expect(e).toBeDefined();
    if (e !== undefined && typeof e.to === "string") {
      expect(edgeId({ from: e.from, to: e.to, kind: e.kind })).toMatch(
        /^e_[0-9a-f]{16}$/,
      );
    }
  });
});
