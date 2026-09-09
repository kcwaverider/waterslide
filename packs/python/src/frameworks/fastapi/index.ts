import type {
  Node as GraphNode,
  PackData,
  PackNode,
  UnresolvedRef,
} from "@waterslide/core";
import { z } from "zod";
import type { Node } from "web-tree-sitter";
import { codeNodeId } from "../../language/ids.js";
import { qualify } from "../../language/analyze.js";
import type {
  Binding,
  CallSite,
  Definition,
  FileModel,
} from "../../language/model.js";
import type { Emitter } from "../../emitter.js";
import {
  attributeChain,
  keywordArguments,
  lineStart,
  positionalArguments,
  stringLiteral,
} from "../../tree-sitter/runtime.js";
import { pydanticModels } from "../pydantic.js";
import type { FrameworkRecognizer } from "../types.js";

/**
 * FastAPI recognition (parser §8), per file. Emits:
 *
 * - a node per `X = FastAPI(...)` / `X = APIRouter(...)` object, with a
 *   `provides` entry and its own prefix in `pack_data.fastapi`;
 * - route nodes: the handler annotated `endpoint`, `is_entry_point`, with the
 *   **local** decorator path in the label, plus a `route` edge router → handler;
 * - one mount edge per `include_router(...)`, the prefix in `pack_data.fastapi`;
 * - `Depends(...)` edges, startup handlers as `app_launch`, middleware nodes.
 *
 * Cross-file prefix composition is `compose.ts`; nothing here looks past the file.
 */

const APP_SYMBOLS = new Set([
  "fastapi.FastAPI",
  "fastapi.applications.FastAPI",
]);
const ROUTER_SYMBOLS = new Set([
  "fastapi.APIRouter",
  "fastapi.routing.APIRouter",
]);
const DEPENDS_SYMBOLS = new Set([
  "fastapi.Depends",
  "fastapi.params.Depends",
  "fastapi.Security",
]);
const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
]);

/** Framework roles, for filtering (tags are the user-facing filter channel). */
export const TAG_APP = "fastapi:app";
export const TAG_ROUTER = "fastapi:router";
export const TAG_ROUTE = "fastapi:route";
/** Display label of the router → handler edge. */
export const LABEL_ROUTE = "route";
/** Display label of an `include_router` edge; the prefix travels in `pack_data`. */
export const LABEL_MOUNT = "include_router";

/**
 * What the per-file pass hands to `compose` through `pack_data.fastapi`
 * (parser §3.3, "pack_data"): a route's methods and LOCAL path, a router's own
 * prefix, a mount's prefix. Never label text, never tags, never hints. Core
 * strips it after compose. `prefix: null` means "written, but not a literal".
 */
export const FastApiPackDataSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("app"), prefix: z.string().nullable() }),
  z.strictObject({ kind: z.literal("router"), prefix: z.string().nullable() }),
  z.strictObject({
    kind: z.literal("route"),
    /** One entry per stacked route decorator, in source order. */
    routes: z.array(
      z.strictObject({
        methods: z.array(z.string()),
        path: z.string(),
        /** False when the decorator path is not a string literal: nothing can match it. */
        path_literal: z.boolean(),
      }),
    ),
  }),
  z.strictObject({ kind: z.literal("route_edge") }),
  z.strictObject({ kind: z.literal("mount"), prefix: z.string().nullable() }),
]);
export type FastApiPackData = z.infer<typeof FastApiPackDataSchema>;

export function fastapiData(d: FastApiPackData): PackData {
  return { fastapi: d };
}

/** The FastAPI part of a node's or edge's `pack_data`, or null when absent or not ours. */
export function readFastApi(pd: PackData | undefined): FastApiPackData | null {
  if (!pd || typeof pd !== "object") return null;
  const parsed = FastApiPackDataSchema.safeParse(pd["fastapi"]);
  return parsed.success ? parsed.data : null;
}

/** Route labels are `METHOD /path` or `GET, POST /path` — display text only. */
export function routeLabel(methods: readonly string[], path: string): string {
  return `${methods.join(", ")} ${path}`;
}

interface RouterObject {
  readonly name: string;
  readonly id: string;
  readonly isApp: boolean;
  readonly prefix: string | null;
}

export const fastapiRecognizer: FrameworkRecognizer = {
  id: "fastapi",
  run(model, em) {
    const routers = emitRouterObjects(model, em);
    const models = pydanticModels(model);
    emitRoutes(model, em, routers, models);
    emitDepends(model, em);
    emitMountsAndMiddleware(model, em, routers);
    emitLifespan(model, em, routers);
  },
};

// ---------------------------------------------------------------------------
// App and router objects
// ---------------------------------------------------------------------------

function emitRouterObjects(
  model: FileModel,
  em: Emitter,
): Map<string, RouterObject> {
  const routers = new Map<string, RouterObject>();
  for (const [name, binding] of model.moduleScope.bindings) {
    if (binding.kind !== "variable" || !binding.value) continue;
    const callee = binding.value.callee;
    if (callee.kind !== "symbol") continue;
    const isApp = APP_SYMBOLS.has(callee.value);
    const isRouter = ROUTER_SYMBOLS.has(callee.value);
    if (!isApp && !isRouter) continue;

    const call = binding.value.call;
    const kwargs = keywordArguments(call.childForFieldName("arguments"));
    let prefix: string | null = "";
    const prefixNode = kwargs.get("prefix");
    if (prefixNode) {
      prefix = stringLiteral(prefixNode);
      if (prefix === null) {
        em.unsupported(
          `${name} = ${isApp ? "FastAPI" : "APIRouter"}(prefix=...) has a non-literal prefix: ${prefixNode.text}; routes under it cannot be composed`,
          lineStart(call),
        );
      }
    }
    const statement = call.parent?.parent ?? call; // call → assignment → expression_statement
    const id = codeNodeId(model.file.repo, model.file.path, name);
    const node: PackNode = {
      id,
      kind: isApp ? "service" : "class",
      label: `${name} (${isApp ? "FastAPI" : "APIRouter"})`,
      tier: em.defaultTier(isApp ? "service" : "class"),
      parent: em.moduleId,
      sources: [em.span(statement)],
      confidence: "certain",
      confidence_reason: null,
      is_entry_point: false,
      entry_point_kind: null,
      is_infrastructure: false,
      tags: [isApp ? TAG_APP : TAG_ROUTER],
      pack_data: fastapiData({ kind: isApp ? "app" : "router", prefix }),
    };
    em.addNode(node);
    em.addProvide({
      ref_kind: "symbol",
      name: qualify(model.file, name),
      node_id: id,
      alias_of: null,
      visibility: "public",
      scope: "global",
      scope_path: null,
    });
    routers.set(name, { name, id, isApp, prefix });
    // The constructor call is configuration, not plumbing.
    const ctorSite = model.callSites.find((s) => s.call.id === call.id);
    if (ctorSite) em.claim(ctorSite);
  }
  return routers;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function emitRoutes(
  model: FileModel,
  em: Emitter,
  routers: Map<string, RouterObject>,
  models: Map<string, string>,
): void {
  for (const def of model.definitions) {
    if (def.kind !== "function") continue;
    for (const deco of def.decorators) {
      if (deco.type !== "call") continue;
      const fn = deco.childForFieldName("function");
      const chain = fn ? attributeChain(fn) : null;
      if (!chain || chain.length !== 2) continue;
      const [routerName, verb] = chain as [string, string];
      const methods = methodsOf(verb, deco, em);
      if (!methods) continue;

      const router = routers.get(routerName);
      const binding = model.moduleScope.bindings.get(routerName);
      if (
        !router &&
        !(
          binding &&
          (binding.kind === "name_import" || binding.kind === "module_import")
        )
      )
        continue;

      const pathNode =
        positionalArguments(deco.childForFieldName("arguments"))[0] ??
        keywordArguments(deco.childForFieldName("arguments")).get("path") ??
        null;
      const literal = stringLiteral(pathNode);
      const path = literal ?? (pathNode ? pathNode.text : "");
      if (literal === null) {
        em.unsupported(
          `route ${def.qualifiedName} has a non-literal path ${pathNode ? pathNode.text : "(missing)"}; it cannot be matched to clients`,
          lineStart(deco),
        );
      }

      const routeId = em.nodeIdFor(def);
      // A handler may carry several route decorators; keep every one, label by the first.
      const prior = readFastApi(em.getNode(routeId)?.pack_data);
      const routes = [
        ...(prior?.kind === "route" ? prior.routes : []),
        { methods, path, path_literal: literal !== null },
      ];
      const head = routes[0] as (typeof routes)[number];
      em.annotateNode(routeId, {
        kind: "endpoint",
        label: routeLabel(head.methods, head.path),
        tier: em.defaultTier("endpoint"),
        is_entry_point: true,
        entry_point_kind: "http_route",
        tags: [TAG_ROUTE],
        pack_data: fastapiData({ kind: "route", routes }),
      });

      if (!router) {
        em.unsupported(
          `route ${def.qualifiedName} is registered on ${routerName}, a router imported from ${bindingQualified(binding)}; its mount prefix cannot be composed from this file`,
          lineStart(deco),
        );
        continue;
      }
      if (prior?.kind === "route") continue; // one router → handler edge per handler; the decorators are in pack_data

      const kwargs = keywordArguments(deco.childForFieldName("arguments"));
      const responseModel = kwargs.get("response_model");
      const responseChain = responseModel
        ? attributeChain(responseModel)
        : null;
      const response_schema_id =
        responseChain && responseChain.length === 1
          ? (models.get(responseChain[0] as string) ?? null)
          : null;
      em.edgePlain(deco, router.id, {
        to: routeId,
        kind: "call",
        label: LABEL_ROUTE,
        confidence: "certain",
        confidence_reason: null,
        schema_id: requestSchemaId(def, models),
        response_schema_id,
        pack_data: fastapiData({ kind: "route_edge" }),
      });
    }
  }
}

function methodsOf(verb: string, deco: Node, em: Emitter): string[] | null {
  if (HTTP_METHODS.has(verb)) return [verb.toUpperCase()];
  if (verb === "websocket") return ["WEBSOCKET"];
  if (verb === "api_route" || verb === "route") {
    const methodsNode = keywordArguments(
      deco.childForFieldName("arguments"),
    ).get("methods");
    if (methodsNode && methodsNode.type === "list") {
      const methods = methodsNode.namedChildren
        .map((n) => stringLiteral(n))
        .filter((s): s is string => s !== null)
        .map((s) => s.toUpperCase());
      if (methods.length > 0) return methods;
    }
    em.unsupported(
      `${verb}(...) without a literal methods list; defaulted to GET`,
      lineStart(deco),
    );
    return ["GET"];
  }
  return null;
}

/** The first parameter annotated with an in-file Pydantic model is the request body. */
function requestSchemaId(
  def: Definition,
  models: Map<string, string>,
): string | null {
  const params = def.node.childForFieldName("parameters");
  for (const p of params?.namedChildren ?? []) {
    const type = p.childForFieldName("type");
    if (!type) continue;
    const id = models.get(type.text.replace(/^["']|["']$/g, ""));
    if (id) return id;
  }
  return null;
}

function bindingQualified(binding: Binding | undefined): string {
  return binding &&
    (binding.kind === "name_import" || binding.kind === "module_import")
    ? binding.qualified
    : "elsewhere";
}

// ---------------------------------------------------------------------------
// Depends
// ---------------------------------------------------------------------------

function emitDepends(model: FileModel, em: Emitter): void {
  for (const def of model.definitions) {
    if (def.kind !== "function") continue;
    const scope = model.scopeFor(def);
    const params = def.node.childForFieldName("parameters");
    for (const p of params?.namedChildren ?? []) {
      const value = p.childForFieldName("value");
      if (value) emitDependsCall(model, em, def, value, scope);
      // `Annotated[T, Depends(x)]`: the dependency sits in the type, not the default.
      const type = p.childForFieldName("type");
      if (type && /^Annotated\[/.test(type.text)) {
        for (const call of type.descendantsOfType("call"))
          emitDependsCall(model, em, def, call, scope);
      }
    }
    for (const deco of def.decorators) {
      if (deco.type !== "call") continue;
      const deps = keywordArguments(deco.childForFieldName("arguments")).get(
        "dependencies",
      );
      if (deps && deps.type === "list") {
        for (const item of deps.namedChildren)
          emitDependsCall(model, em, def, item, scope);
      }
    }
  }
}

function emitDependsCall(
  model: FileModel,
  em: Emitter,
  def: Definition,
  value: Node,
  scope: ReturnType<FileModel["scopeFor"]>,
): void {
  // `Annotated[T, Depends(x)]` is inside the type, which classify() skips; `= Depends(x)` is here.
  if (value.type !== "call") return;
  const fn = value.childForFieldName("function");
  const fnChain = fn ? attributeChain(fn) : null;
  if (!fnChain) return;
  const dependsCallee = model.resolveChain(fnChain, scope, def);
  if (
    dependsCallee.kind !== "symbol" ||
    !DEPENDS_SYMBOLS.has(dependsCallee.value)
  )
    return;
  const target =
    positionalArguments(value.childForFieldName("arguments"))[0] ??
    keywordArguments(value.childForFieldName("arguments")).get("dependency");
  if (!target) return; // `Depends()` with the type as the dependency: not modelled
  const targetChain = attributeChain(target);
  if (!targetChain) {
    em.unsupported(
      `Depends(${target.text}) in ${def.qualifiedName}: dependency is not a name`,
      lineStart(value),
    );
    return;
  }
  const resolved = model.resolveChain(targetChain, scope, def);
  const from = em.nodeIdFor(def);
  if (resolved.kind === "in_file") {
    em.edgePlain(value, from, {
      to: em.nodeIdFor(resolved.def),
      kind: "call",
      label: "Depends",
      confidence: "certain",
      confidence_reason: null,
    });
  } else if (resolved.kind === "symbol") {
    const ref: UnresolvedRef = {
      ref_kind: "symbol",
      value: resolved.value,
      hints: { arity: null, receiver_type: resolved.root.qualified },
      source_line: lineStart(value),
    };
    em.edgePlain(value, from, {
      to: ref,
      kind: "call",
      label: "Depends",
      confidence: resolved.uncertainty ? "inferred" : "certain",
      confidence_reason: resolved.uncertainty,
    });
  } else {
    em.unsupported(
      `Depends(${target.text}) in ${def.qualifiedName}: dependency does not resolve in this file`,
      lineStart(value),
    );
  }
}

// ---------------------------------------------------------------------------
// include_router, add_middleware, on_event
// ---------------------------------------------------------------------------

function emitMountsAndMiddleware(
  model: FileModel,
  em: Emitter,
  routers: Map<string, RouterObject>,
): void {
  for (const site of model.callSites) {
    if (em.isClaimed(site)) continue;
    const chain = site.chain;
    if (!chain || chain.length !== 2) continue;
    const [receiver, method] = chain as [string, string];
    const router = routers.get(receiver);
    if (!router) continue;
    switch (method) {
      case "include_router":
        em.claim(site);
        emitMount(model, em, site, router, routers);
        break;
      case "add_middleware":
        em.claim(site);
        emitMiddleware(model, em, site, router);
        break;
      case "mount":
      case "add_api_route":
      case "add_event_handler":
      case "add_api_websocket_route":
        em.claim(site);
        em.unsupported(
          `${receiver}.${method}(...) is not modelled; routes or handlers registered this way are missing from the map`,
          site.line,
        );
        break;
      default:
        break;
    }
  }
}

function emitMount(
  model: FileModel,
  em: Emitter,
  site: CallSite,
  parent: RouterObject,
  routers: Map<string, RouterObject>,
): void {
  const args = positionalArguments(site.argumentList);
  const kwargs = keywordArguments(site.argumentList);
  const target = args[0] ?? kwargs.get("router");
  if (!target) {
    em.unsupported(
      `${parent.name}.include_router(...) without a router argument`,
      site.line,
    );
    return;
  }
  let prefix: string | null = "";
  const prefixNode = kwargs.get("prefix");
  if (prefixNode) {
    prefix = stringLiteral(prefixNode);
    if (prefix === null)
      em.unsupported(
        `${parent.name}.include_router(..., prefix=${prefixNode.text}) has a non-literal prefix; routes under it cannot be composed`,
        site.line,
      );
  }
  const chain = attributeChain(target);
  if (!chain) {
    em.unsupported(
      `${parent.name}.include_router(${target.text}): router argument is not a name`,
      site.line,
    );
    return;
  }
  const local =
    chain.length === 1 ? routers.get(chain[0] as string) : undefined;
  let to: string | UnresolvedRef;
  if (local) {
    to = local.id;
  } else {
    const resolved = model.resolveChain(
      chain,
      model.scopeFor(site.owner),
      site.owner,
    );
    if (resolved.kind !== "symbol") {
      em.unsupported(
        `${parent.name}.include_router(${target.text}): router does not resolve to an imported name`,
        site.line,
      );
      return;
    }
    to = {
      ref_kind: "symbol",
      value: resolved.value,
      hints: { arity: null, receiver_type: null },
      source_line: site.line,
    };
  }
  em.edgePlain(site.call, parent.id, {
    to,
    kind: "call",
    label: LABEL_MOUNT,
    confidence: "certain",
    confidence_reason: null,
    pack_data: fastapiData({ kind: "mount", prefix }),
  });
}

function emitMiddleware(
  model: FileModel,
  em: Emitter,
  site: CallSite,
  app: RouterObject,
): void {
  const target =
    positionalArguments(site.argumentList)[0] ??
    keywordArguments(site.argumentList).get("middleware_class");
  const chain = target ? attributeChain(target) : null;
  if (!chain) {
    em.unsupported(
      `${app.name}.add_middleware(...): middleware class is not a name`,
      site.line,
    );
    return;
  }
  const name = chain[chain.length - 1] as string;
  const resolved = model.resolveChain(
    chain,
    model.scopeFor(site.owner),
    site.owner,
  );
  const id =
    resolved.kind === "in_file"
      ? em.nodeIdFor(resolved.def)
      : codeNodeId(model.file.repo, model.file.path, name);
  if (resolved.kind === "in_file") {
    em.annotateNode(id, {
      kind: "middleware",
      tier: em.defaultTier("middleware"),
      tags: ["fastapi:middleware"],
    });
  } else if (!em.hasNode(id)) {
    // A third-party class: no definition in this repo, so no sources (graph model §2.4).
    em.addNode({
      id,
      kind: "middleware",
      label: name,
      tier: em.defaultTier("middleware"),
      parent: em.moduleId,
      sources: [],
      confidence: "certain",
      confidence_reason: null,
      is_entry_point: false,
      entry_point_kind: null,
      is_infrastructure: false,
      tags: ["fastapi:middleware"],
    });
  }
  em.edgePlain(site.call, app.id, {
    to: id,
    kind: "call",
    label: "add_middleware",
    confidence: "certain",
    confidence_reason: null,
  });
}

function emitLifespan(
  model: FileModel,
  em: Emitter,
  routers: Map<string, RouterObject>,
): void {
  for (const def of model.definitions) {
    if (def.kind !== "function") continue;
    for (const deco of def.decorators) {
      if (deco.type !== "call") continue;
      const fn = deco.childForFieldName("function");
      const chain = fn ? attributeChain(fn) : null;
      if (!chain || chain.length !== 2 || !routers.has(chain[0] as string))
        continue;
      const verb = chain[1];
      const arg = stringLiteral(
        positionalArguments(deco.childForFieldName("arguments"))[0] ?? null,
      );
      if (verb === "on_event" && arg === "startup") {
        em.annotateNode(em.nodeIdFor(def), {
          is_entry_point: true,
          entry_point_kind: "app_launch",
          tags: ["fastapi:startup"],
        });
      } else if (verb === "middleware") {
        em.annotateNode(em.nodeIdFor(def), {
          kind: "middleware",
          tier: em.defaultTier("middleware"),
          tags: ["fastapi:middleware"],
        });
      }
    }
  }
  // `FastAPI(lifespan=fn)`: the lifespan context manager runs at launch.
  for (const [, binding] of model.moduleScope.bindings) {
    if (
      binding.kind !== "variable" ||
      !binding.value ||
      binding.value.callee.kind !== "symbol" ||
      !APP_SYMBOLS.has(binding.value.callee.value)
    )
      continue;
    const lifespan = keywordArguments(
      binding.value.call.childForFieldName("arguments"),
    ).get("lifespan");
    if (!lifespan) continue;
    const chain = attributeChain(lifespan);
    const resolved = chain
      ? model.resolveChain(chain, model.moduleScope, null)
      : null;
    if (resolved && resolved.kind === "in_file") {
      em.annotateNode(em.nodeIdFor(resolved.def), {
        is_entry_point: true,
        entry_point_kind: "app_launch",
        tags: ["fastapi:lifespan"],
      });
    } else {
      em.unsupported(
        `FastAPI(lifespan=${lifespan.text}) does not resolve to a function in this file`,
        lineStart(lifespan),
      );
    }
  }
}
