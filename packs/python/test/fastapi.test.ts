import { describe, expect, it } from "vitest";
import type { PerFileResult } from "@waterslide/core";
import { parseTree } from "./support/harness.js";
import { fixture, getPack } from "./support/pack.js";
import { assemble } from "./support/resolver.js";

const SERVER = { source_roots: ["server"] };

const REPO = "fx";
const ROOT = fixture("fastapi-app");

async function parsed(): Promise<PerFileResult[]> {
  const pack = await getPack();
  return parseTree(pack, REPO, ROOT, undefined, SERVER);
}

describe("FastAPI per-file recognizers (parser §8)", () => {
  it("marks every route as an http_route entry point with the LOCAL path in the label", async () => {
    const results = await parsed();
    const notes = results.find(
      (r) => r.path === "server/api/endpoints/notes.py",
    )?.result;
    const routes = notes?.nodes.filter((n) => n.is_entry_point) ?? [];
    expect(routes.map((n) => [n.label, n.kind, n.entry_point_kind])).toEqual([
      ["POST ", "endpoint", "http_route"],
      ["GET /{note_id}", "endpoint", "http_route"],
      ["PUT /{note_id}", "endpoint", "http_route"],
      ["DELETE /{note_id}", "endpoint", "http_route"],
      ["POST, PATCH /{note_id}/archive", "endpoint", "http_route"],
    ]);
    // Handler functions that are not routes stay plain functions.
    expect(
      notes?.nodes.find((n) => n.id.endsWith("#require_admin"))?.is_entry_point,
    ).toBe(false);
  });

  it("emits a router node with its own prefix as a tag, a provide, and a route edge per handler", async () => {
    const results = await parsed();
    const notes = results.find(
      (r) => r.path === "server/api/endpoints/notes.py",
    )?.result;
    const router = notes?.nodes.find((n) => n.tags.includes("fastapi:router"));
    expect(router).toMatchObject({
      id: "fx:server/api/endpoints/notes.py#router",
      kind: "class",
      tier: "domain",
    });
    expect(router?.tags).toEqual(["fastapi:prefix=/notes", "fastapi:router"]);
    expect(notes?.provides).toContainEqual({
      ref_kind: "symbol",
      name: "api.endpoints.notes.router",
      node_id: router?.id,
      alias_of: null,
      visibility: "public",
      scope: "global",
      scope_path: null,
    });
    const routeEdges = notes?.edges.filter((e) => e.label === "route") ?? [];
    expect(routeEdges).toHaveLength(5);
    expect(routeEdges.every((e) => e.from === router?.id)).toBe(true);
    // No `module → fastapi.APIRouter` noise: the constructor is configuration.
    expect(
      notes?.edges.some(
        (e) => typeof e.to !== "string" && e.to.value === "fastapi.APIRouter",
      ),
    ).toBe(false);
  });

  it("carries request and response schemas on the route edge when the models live in the file", async () => {
    const results = await parsed();
    const notes = results.find(
      (r) => r.path === "server/api/endpoints/notes.py",
    )?.result;
    const create = notes?.edges.find(
      (e) => e.label === "route" && e.to.toString().endsWith("#create_note"),
    );
    expect(create?.schema_id).toBe(
      "sch:fx:server/api/endpoints/notes.py#NoteCreate",
    );
    expect(create?.response_schema_id).toBe(
      "sch:fx:server/api/endpoints/notes.py#NoteOut",
    );
    const schemas = notes?.schemas ?? [];
    expect(schemas.map((s) => s.name)).toEqual([
      "Author",
      "NoteCreate",
      "NoteOut",
    ]);
    const noteCreate = schemas.find((s) => s.name === "NoteCreate");
    expect(noteCreate?.fields).toEqual([
      {
        name: "body",
        type: "str",
        optional: false,
        classification: ["free_text", "may_contain_pii"],
        ref_schema_id: null,
      },
      {
        name: "tags",
        type: "list[str]",
        optional: true,
        classification: [],
        ref_schema_id: null,
      },
      {
        name: "author",
        type: "Optional[Author]",
        optional: true,
        classification: [],
        ref_schema_id: "sch:fx:server/api/endpoints/notes.py#Author",
      },
    ]);
    expect(schemas.find((s) => s.name === "Author")?.fields[0]).toMatchObject({
      name: "user_id",
      optional: false,
      classification: ["identifier"],
    });
    expect(
      schemas.find((s) => s.name === "NoteOut")?.fields.map((f) => f.optional),
    ).toEqual([false, false, false]);
  });

  it("emits a Depends edge for signature dependencies and decorator dependencies", async () => {
    const results = await parsed();
    const notes = results.find(
      (r) => r.path === "server/api/endpoints/notes.py",
    )?.result;
    const depends = notes?.edges.filter((e) => e.label === "Depends") ?? [];
    const summary = depends.map((e) => [
      e.from.split("#")[1],
      typeof e.to === "string" ? e.to : e.to.value,
    ]);
    expect(summary).toContainEqual(["create_note", "auth.get_current_user"]);
    expect(summary).toContainEqual(["require_admin", "auth.get_current_user"]);
    expect(summary).toContainEqual([
      "delete_note",
      "fx:server/api/endpoints/notes.py#require_admin",
    ]);
    expect(
      depends.every((e) => e.confidence === "certain" && e.kind === "call"),
    ).toBe(true);
    const hints = depends.find((e) => typeof e.to !== "string")?.to;
    expect(typeof hints === "string" ? null : hints?.hints).toEqual({
      arity: null,
      receiver_type: "auth.get_current_user",
    });
  });

  it("emits mount edges with the prefix in the label and, for imported routers, in hints", async () => {
    const results = await parsed();
    const main = results.find((r) => r.path === "server/main.py")?.result;
    const mount = main?.edges.find((e) =>
      e.label?.startsWith("include_router"),
    );
    expect(mount?.label).toBe('include_router(prefix="/api")');
    expect(mount?.from).toBe("fx:server/main.py#app");
    expect(mount?.to).toEqual({
      ref_kind: "symbol",
      value: "api.api_router",
      hints: { arity: null, receiver_type: null },
      source_line: 21,
    });

    const api = results.find(
      (r) => r.path === "server/api/__init__.py",
    )?.result;
    const labels = api?.edges
      .filter((e) => e.label?.startsWith("include_router"))
      .map((e) => e.label);
    expect(labels).toEqual([
      'include_router(prefix="")',
      'include_router(prefix="/users")',
    ]);
  });

  it("app object, startup handler and middleware (decision item 9)", async () => {
    const results = await parsed();
    const main = results.find((r) => r.path === "server/main.py")?.result;
    expect(main?.nodes.find((n) => n.id.endsWith("#app"))).toMatchObject({
      kind: "service",
      tags: ["fastapi:app"],
    });
    expect(main?.nodes.find((n) => n.id.endsWith("#startup"))).toMatchObject({
      is_entry_point: true,
      entry_point_kind: "app_launch",
    });
    expect(main?.nodes.find((n) => n.id.endsWith("#shutdown"))).toMatchObject({
      is_entry_point: false,
      entry_point_kind: null,
    });
    const mw = main?.nodes.find((n) => n.kind === "middleware");
    expect(mw).toMatchObject({
      id: "fx:server/main.py#CORSMiddleware",
      sources: [],
      is_infrastructure: false,
      confidence: "certain",
    });
    expect(main?.edges.find((e) => e.label === "add_middleware")).toMatchObject(
      { from: "fx:server/main.py#app", to: "fx:server/main.py#CORSMiddleware" },
    );
    expect(
      main?.diagnostics.filter((d) => d.code === "unsupported_construct"),
    ).toEqual([]);
  });

  it("re-exports through a PEP 562 dict literal become alias_of provides (decision item 3)", async () => {
    const results = await parsed();
    const init = results.find(
      (r) => r.path === "server/api/endpoints/__init__.py",
    )?.result;
    const aliases = init?.provides.filter(
      (p) => p.alias_of !== null && p.scope === "global",
    );
    expect(aliases).toEqual([
      {
        ref_kind: "symbol",
        name: "api.endpoints.notes_router",
        node_id: null,
        alias_of: "api.endpoints.notes.router",
        visibility: "public",
        scope: "global",
        scope_path: null,
      },
      {
        ref_kind: "symbol",
        name: "api.endpoints.users_router",
        node_id: null,
        alias_of: "api.endpoints.users.router",
        visibility: "public",
        scope: "global",
        scope_path: null,
      },
    ]);
  });

  it("diagnoses a non-literal PEP 562 map instead of guessing", async () => {
    const pack = await getPack();
    const r = pack.parse(
      "r",
      "pkg/__init__.py",
      "_ROUTER_MODULES = build_map()\n\ndef __getattr__(name):\n    return _ROUTER_MODULES[name]\n",
    );
    expect(r.provides.filter((p) => p.alias_of !== null)).toEqual([]);
    expect(r.diagnostics.map((d) => d.code)).toContain("unsupported_construct");
  });
});

describe("compose: cross-file prefix composition (decision items 1 and 2)", () => {
  it("composes prefixes at both levels plus the router's own prefix, and emits http provides per method", async () => {
    const pack = await getPack();
    const results = parseTree(pack, REPO, ROOT, undefined, SERVER);
    const assembled = assemble(pack, results, REPO, SERVER);
    expect(
      assembled.validation.ok,
      JSON.stringify(assembled.validation.errors),
    ).toBe(true);

    const labels = assembled.graph.nodes
      .filter((n) => n.entry_point_kind === "http_route")
      .map((n) => n.label)
      .sort();
    expect(labels).toEqual([
      "DELETE /api/notes/{note_id}",
      "GET /api/notes/{note_id}",
      "GET /api/users",
      "GET /api/users/{user_id}",
      "GET /health",
      "POST /api/notes",
      "POST, PATCH /api/notes/{note_id}/archive",
      "PUT /api/notes/{note_id}",
    ]);
    const http = assembled.patch.provides
      .filter((p) => p.ref_kind === "http")
      .map((p) => [p.name, p.node_id?.split("#")[1]]);
    expect(http.sort()).toEqual([
      ["DELETE /api/notes/{note_id}", "delete_note"],
      ["GET /api/notes/{note_id}", "get_note"],
      ["GET /api/users", "list_users"],
      ["GET /api/users/{user_id}", "get_user"],
      ["GET /health", "health"],
      ["PATCH /api/notes/{note_id}/archive", "archive_note"],
      ["POST /api/notes", "create_note"],
      ["POST /api/notes/{note_id}/archive", "archive_note"],
      ["PUT /api/notes/{note_id}", "update_note"],
    ]);
    expect(
      assembled.patch.provides.every(
        (p) =>
          p.scope === "global" &&
          p.visibility === "public" &&
          p.alias_of === null,
      ),
    ).toBe(true);
    // Ids never change: the composed URL is label plus provide only.
    expect(
      assembled.graph.nodes.every(
        (n) => !n.id.includes("/api/notes") && !n.id.includes("/api/users"),
      ),
    ).toBe(true);
    expect(
      assembled.patch.diagnostics.filter((d) => d.severity !== "info"),
    ).toEqual([]);
  });

  it("is unaffected by result order beyond the (repo, path) sort core guarantees", async () => {
    const pack = await getPack();
    const results = parseTree(pack, REPO, ROOT, undefined, SERVER);
    const a = assemble(pack, results, REPO, SERVER).text;
    const b = assemble(pack, [...results].reverse(), REPO, SERVER).text;
    expect(b).toBe(a);
  });

  it("reports an unmounted router and an unresolvable mount instead of guessing a path", async () => {
    const pack = await getPack();
    const orphan = pack.parse(
      "r",
      "orphan.py",
      'from fastapi import APIRouter\nrouter = APIRouter()\n\n@router.get("/x")\ndef x():\n    return 1\n',
    );
    const main = pack.parse(
      "r",
      "main.py",
      'from fastapi import FastAPI\nfrom elsewhere import ghost_router\napp = FastAPI()\napp.include_router(ghost_router, prefix="/g")\n',
    );
    const patch = pack.compose([
      { repo: "r", path: "main.py", result: main },
      { repo: "r", path: "orphan.py", result: orphan },
    ]);
    expect(patch.diagnostics.map((d) => d.code).sort()).toEqual([
      "router_not_mounted",
      "unresolved_mount",
    ]);
    expect(patch.provides).toEqual([]);
    expect(patch.nodes).toEqual([]);
    expect(patch.node_updates).toEqual([]);
  });
});
