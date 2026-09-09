import type { UnresolvedRef } from "@waterslide/core";
import type { Node } from "web-tree-sitter";
import type { Boto3Service, HttpClient, Vendor } from "../data.js";
import type { Emitter } from "../emitter.js";
import type {
  Callee,
  CallSite,
  FileModel,
  ValueInfo,
} from "../language/model.js";
import {
  attributeChain,
  keywordArguments,
  positionalArguments,
  stringLiteral,
  unwrapExpression,
} from "../tree-sitter/runtime.js";
import type { FrameworkRecognizer } from "./types.js";

/**
 * External vendor calls (parser §4.1 `external`, decision items 4 and 7). The
 * vendor table is data; this file only traces receivers. A receiver traced to an
 * SDK constructor within the same file is `certain` — that is reading source.
 * boto3 splits by service: S3 is an external service, SQS/SNS sends are
 * `publish` edges to topics.
 */
export const externalRecognizer: FrameworkRecognizer = {
  id: "external",
  run(model, em) {
    const { vendors, boto3, http_clients } = em.data.vendors;
    const vendorByModule = new Map(vendors.map((v) => [v.module, v] as const));
    const clientByModule = new Map(
      http_clients.clients.map((c) => [c.module, c] as const),
    );

    const claimedCalls = new Set<number>();
    for (const site of model.callSites) {
      if (em.isClaimed(site)) continue;
      if (isSdkConstructor(site, vendorByModule, boto3, clientByModule)) {
        em.claim(site);
        continue;
      }
      const http = httpOrigin(site, clientByModule, http_clients.methods);
      if (http) {
        em.claim(site);
        claimedCalls.add(site.call.id);
        emitHttp(em, model, site, http);
        continue;
      }
      const origin = sdkOrigin(model, site, vendorByModule, boto3);
      if (!origin) continue;
      em.claim(site);
      claimedCalls.add(site.call.id);
      emitOrigin(em, site, origin);
    }

    // `client.get_function_configuration(...).get(...)`, `response.json()`: a
    // call on an SDK response is a value operation, not a further edge.
    let grew = true;
    while (grew) {
      grew = false;
      for (const site of model.callSites) {
        if (em.isClaimed(site) || site.callee.kind !== "symbol") continue;
        const inner = site.callee.root.constructor?.call;
        if (inner && claimedCalls.has(inner.id)) {
          em.claim(site);
          claimedCalls.add(site.call.id);
          grew = true;
        }
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Generic HTTP clients (A10 item 2)
// ---------------------------------------------------------------------------

interface HttpOrigin {
  readonly client: HttpClient;
  /** The call name: `post`, `request`, ... */
  readonly call: string;
  /** The HTTP method from the table, or null when it is the call's first argument. */
  readonly method: string | null;
  readonly certainReceiver: boolean;
  readonly receiverNote: string | null;
}

/** A call through httpx / aiohttp / requests: the receiver traces to a client constructor, or the module verb is called directly. */
function httpOrigin(
  site: CallSite,
  clientByModule: Map<string, HttpClient>,
  methods: Record<string, string | null>,
): HttpOrigin | null {
  if (site.callee.kind !== "symbol") return null;
  const callee = site.callee;
  const ctor = callee.root.constructor;
  const ctorValue =
    ctor && ctor.callee.kind === "symbol" ? ctor.callee.value : null;
  const spelled =
    ctorValue && clientByModule.has(ctorValue.split(".")[0] as string)
      ? [ctorValue, ...callee.rest].join(".")
      : callee.value;
  const segments = spelled.split(".");
  const client = clientByModule.get(segments[0] as string);
  if (!client) return null;
  const call = segments[segments.length - 1] as string;
  if (!(call in methods)) return null;
  // Exactly module.Constructor.method: a call on the client itself. Anything
  // deeper (`response.json().get(...)`) is a value operation on a response.
  const viaConstructor =
    segments.length === 3 &&
    client.constructors.includes(segments[1] as string);
  const viaModule = segments.length === 2 && client.module_functions;
  if (!viaConstructor && !viaModule) return null;
  return {
    client,
    call,
    method: methods[call] ?? null,
    certainReceiver: callee.uncertainty === null,
    receiverNote: callee.uncertainty,
  };
}

interface RecoveredUrl {
  readonly value: string;
  readonly base_url_expr: string | null;
  readonly query: string | null;
  readonly certain: boolean;
  readonly reason: string | null;
}

/** Split an absolute URL literal into `scheme://host` and the rest. */
function splitAbsolute(url: string): { base: string; path: string } | null {
  const m = /^(https?:\/\/[^/?#]+)(.*)$/.exec(url);
  return m ? { base: m[1] as string, path: (m[2] as string) || "/" } : null;
}

function splitQuery(path: string): { path: string; query: string | null } {
  const q = path.indexOf("?");
  return q === -1
    ? { path, query: null }
    : { path: path.slice(0, q), query: path.slice(q + 1) };
}

/**
 * What the call site says about its URL, by local evidence only. A literal is
 * certain. An f-string or concatenation whose head resolves to exactly one
 * module or class constant is rebuilt; several candidates are named in the
 * reason and the path template is emitted alone; anything else is
 * `{unresolved}` with `base_url_expr` naming the expression (parser §3.6).
 */
function recoverUrl(
  model: FileModel,
  site: CallSite,
  urlNode: Node | null,
): RecoveredUrl {
  if (!urlNode) {
    return {
      value: "{unresolved}",
      base_url_expr: null,
      query: null,
      certain: false,
      reason: "the call passes no URL argument the pack can see",
    };
  }
  const scope = model.scopeFor(site.owner);
  const e = unwrapExpression(urlNode);

  const fromBase = (
    baseExpr: Node,
    pathTemplate: string,
    pathCertain: boolean,
  ): RecoveredUrl => {
    const candidates = model.stringConstants(baseExpr, scope, site.owner);
    const { path, query } = splitQuery(pathTemplate);
    if (candidates && candidates.length === 1) {
      return {
        value: `${candidates[0] as string}${path}`,
        base_url_expr: baseExpr.text,
        query,
        certain: pathCertain,
        reason: pathCertain
          ? null
          : `path is not fully literal; base ${baseExpr.text} resolves to ${candidates[0] as string}`,
      };
    }
    if (candidates && candidates.length > 1) {
      return {
        value: path,
        base_url_expr: baseExpr.text,
        query,
        certain: false,
        reason: `base ${baseExpr.text} resolves to one of ${candidates.join(" or ")}, chosen at runtime; path template shown without a host`,
      };
    }
    return {
      value: path,
      base_url_expr: baseExpr.text,
      query,
      certain: false,
      reason: `base ${baseExpr.text} is not a literal or constant this file can see${describeBinding(model, scope, site, baseExpr)}`,
    };
  };

  if (e.type === "string") {
    const parts = e.namedChildren.filter(
      (c) => c.type !== "string_start" && c.type !== "string_end",
    );
    const interpolations = parts.filter((p) => p.type === "interpolation");
    if (interpolations.length === 0) {
      const lit = stringLiteral(e) ?? "";
      const abs = splitAbsolute(lit);
      const { path, query } = splitQuery(abs ? abs.path : lit);
      return {
        value: abs ? `${abs.base}${path}` : path,
        base_url_expr: null,
        query,
        certain: true,
        reason: null,
      };
    }
    const template = (ps: readonly Node[]): string =>
      ps
        .map((p) =>
          p.type === "interpolation"
            ? `{${p.namedChildren[0]?.text ?? "?"}}`
            : p.text,
        )
        .join("");
    const first = parts[0] as Node;
    if (first.type === "interpolation") {
      const head = first.namedChildren[0];
      if (head) return fromBase(head, template(parts.slice(1)), true);
    }
    const lit = template(parts);
    const abs = splitAbsolute(lit);
    const { path, query } = splitQuery(abs ? abs.path : lit);
    return {
      value: abs ? `${abs.base}${path}` : path,
      base_url_expr: null,
      query,
      certain: true,
      reason: null,
    };
  }
  if (e.type === "binary_operator") {
    const left = e.childForFieldName("left");
    const right = e.childForFieldName("right");
    const op = e.children.find((c) => !c.isNamed)?.text;
    if (left && right && op === "+") {
      const rightLit = stringLiteral(unwrapExpression(right));
      return fromBase(left, rightLit ?? "{unresolved}", rightLit !== null);
    }
  }
  if (e.type === "identifier" || e.type === "attribute") {
    const candidates = model.stringConstants(e, scope, site.owner);
    if (candidates && candidates.length === 1) {
      const lit = candidates[0] as string;
      const abs = splitAbsolute(lit);
      const { path, query } = splitQuery(abs ? abs.path : lit);
      return {
        value: abs ? `${abs.base}${path}` : path,
        base_url_expr: e.text,
        query,
        certain: true,
        reason: null,
      };
    }
    if (candidates && candidates.length > 1) {
      return {
        value: "{unresolved}",
        base_url_expr: e.text,
        query: null,
        certain: false,
        reason: `URL ${e.text} resolves to one of ${candidates.join(" or ")}, chosen at runtime`,
      };
    }
    return {
      value: "{unresolved}",
      base_url_expr: e.text,
      query: null,
      certain: false,
      reason: `URL ${e.text} is not a literal or constant this file can see${describeBinding(model, scope, site, e)}`,
    };
  }
  return {
    value: "{unresolved}",
    base_url_expr: e.text,
    query: null,
    certain: false,
    reason: `URL is computed by ${e.type.replace(/_/g, " ")} ${e.text.slice(0, 60)}`,
  };
}

/** `; it is a constructor parameter of Api.__init__` and similar, when the pack can say. */
function describeBinding(
  model: FileModel,
  scope: ReturnType<FileModel["scopeFor"]>,
  site: CallSite,
  expr: Node,
): string {
  const chain = attributeChain(expr);
  if (!chain) return "";
  if (chain.length === 2 && site.owner?.parent) {
    const info = model.classes.get(site.owner.parent.name);
    const attr = info?.attributes.get(chain[1] as string);
    if (attr?.assigned) {
      const a = unwrapExpression(attr.assigned);
      if (a.type === "identifier")
        return `; ${chain.join(".")} is assigned from ${a.text}, a constructor parameter of ${site.owner.parent.name}`;
      return `; ${chain.join(".")} is assigned from ${a.text.slice(0, 60)}`;
    }
    return "";
  }
  const b = scope.bindings.get(chain[0] as string);
  return b?.kind === "parameter"
    ? `; ${chain[0] as string} is a parameter`
    : "";
}

function emitHttp(
  em: Emitter,
  model: FileModel,
  site: CallSite,
  origin: HttpOrigin,
): void {
  const positional = positionalArguments(site.argumentList);
  const kwargs = keywordArguments(site.argumentList);
  let method = origin.method;
  let urlNode: Node | null;
  if (method === null) {
    // request(method, url, ...) / stream(method, url, ...)
    const m = positional[0]
      ? stringLiteral(unwrapExpression(positional[0]))
      : null;
    method = m
      ? m.toUpperCase()
      : kwargs.get("method")
        ? stringLiteral(kwargs.get("method") ?? null)
        : null;
    urlNode = positional[1] ?? kwargs.get("url") ?? null;
  } else {
    urlNode = positional[0] ?? kwargs.get("url") ?? null;
  }
  const url = recoverUrl(model, site, urlNode);
  const notes = [url.reason, origin.receiverNote].filter(
    (n): n is string => n !== null,
  );
  const certain = url.certain && origin.certainReceiver;
  const ref: UnresolvedRef = {
    ref_kind: "http",
    value: url.value,
    hints: { method, base_url_expr: url.base_url_expr, query: url.query },
    source_line: site.line,
  };
  em.edgeFromSite(site, {
    to: ref,
    kind: "http_request",
    label: method ?? origin.call,
    confidence: certain ? "certain" : "inferred",
    confidence_reason: certain
      ? null
      : `${origin.client.module} ${origin.call}(): ${notes.length > 0 ? notes.join("; ") : "target not fully recoverable"}`,
  });
}

type Origin =
  | {
      kind: "vendor";
      vendor: Vendor;
      sdkSymbol: string;
      tail: string[];
      certain: boolean;
      reason: string | null;
    }
  | {
      kind: "boto3";
      service: string;
      config: Boto3Service | null;
      method: string;
      sdkSymbol: string;
      site: CallSite;
      certain: boolean;
      reason: string | null;
      factoryCall: Node | null;
    };

type Boto3Table = {
  module: string;
  factories: string[];
  services: Record<string, Boto3Service>;
};

function sdkOrigin(
  model: FileModel,
  site: CallSite,
  vendorByModule: Map<string, Vendor>,
  boto3: Boto3Table,
): Origin | null {
  // Shape A: an attribute chain whose root traces to an SDK constructor or factory.
  if (site.chain && site.callee.kind === "symbol") {
    const callee = site.callee;
    const ctor = callee.root.constructor;
    const ctorValue =
      ctor && ctor.callee.kind === "symbol" ? ctor.callee.value : null;
    const method =
      callee.rest.length > 0
        ? (callee.rest[callee.rest.length - 1] as string)
        : (site.chain[site.chain.length - 1] as string);

    // The receiver was built by a boto3 factory in this file.
    if (ctor && ctorValue && ctorValue.split(".")[0] === boto3.module) {
      const service = boto3ServiceOf(ctor.call, boto3, ctor.chain);
      if (!service) return null;
      return {
        kind: "boto3",
        service,
        config: boto3.services[service] ?? null,
        method,
        sdkSymbol: `boto3.${service}.${method}`,
        site,
        certain: true,
        reason: null,
        factoryCall: ctor.call,
      };
    }

    // The receiver was built by a vendor SDK constructor in this file, or the
    // call is spelled through the SDK module directly. Both are read from
    // source, so both are certain (decision item 7).
    const spelled =
      ctorValue && vendorByModule.has(ctorValue.split(".")[0] as string)
        ? [ctorValue, ...callee.rest].join(".")
        : callee.value;
    const segments = spelled.split(".");
    const vendor = vendorByModule.get(segments[0] as string);
    if (!vendor) return null;
    const ctorIndex = segments.findIndex(
      (seg, i) => i >= 1 && vendor.constructors.includes(seg),
    );
    if (ctorIndex === -1 || segments.length <= ctorIndex + 1) return null; // a constructor or module function, not a call surface
    return {
      kind: "vendor",
      vendor,
      sdkSymbol: spelled,
      tail: segments.slice(ctorIndex + 1),
      certain: true,
      reason: null,
    };
  }

  // Shape B: `boto3.client("sqs").send_message(...)` — the receiver is itself the factory call.
  if (!site.chain && site.calleeNode.type === "attribute") {
    const object = site.calleeNode.childForFieldName("object");
    const attr = site.calleeNode.childForFieldName("attribute");
    if (object && attr && object.type === "call") {
      const fn = object.childForFieldName("function");
      const chain = fn ? attributeChain(fn) : null;
      if (chain) {
        const resolved = model.resolveChain(
          chain,
          model.scopeFor(site.owner),
          site.owner,
        );
        if (
          resolved.kind === "symbol" &&
          resolved.value.split(".")[0] === boto3.module
        ) {
          const service = boto3ServiceOf(object, boto3, chain);
          if (service) {
            return {
              kind: "boto3",
              service,
              config: boto3.services[service] ?? null,
              method: attr.text,
              sdkSymbol: `boto3.${service}.${attr.text}`,
              site,
              certain: true,
              reason: null,
              factoryCall: object,
            };
          }
        }
      }
    }
  }
  return null;
}

/** `anthropic.AsyncAnthropic(...)`, `boto3.client(...)`: building a client is configuration, not a call surface. */
function isSdkConstructor(
  site: CallSite,
  vendorByModule: Map<string, Vendor>,
  boto3: Boto3Table,
  clientByModule: Map<string, HttpClient>,
): boolean {
  if (site.callee.kind !== "symbol") return false;
  const segments = site.callee.value.split(".");
  if (segments.length !== 2) return false;
  const [moduleName, name] = segments as [string, string];
  if (moduleName === boto3.module) return boto3.factories.includes(name);
  const client = clientByModule.get(moduleName);
  if (client?.constructors.includes(name)) return true;
  const vendor = vendorByModule.get(moduleName);
  return vendor !== undefined && vendor.constructors.includes(name);
}

/** The service literal of `boto3.client("s3", ...)` / `boto3.resource("sqs")`, or null. */
function boto3ServiceOf(
  call: Node,
  boto3: Boto3Table,
  chain: readonly string[] | null,
): string | null {
  const factory = chain ? chain[chain.length - 1] : undefined;
  if (!factory || !boto3.factories.includes(factory)) return null;
  const args = positionalArguments(call.childForFieldName("arguments"));
  const literal = stringLiteral(args[0] ?? null);
  if (literal) return literal;
  const kw = keywordArguments(call.childForFieldName("arguments")).get(
    "service_name",
  );
  return stringLiteral(kw ?? null);
}

function emitOrigin(em: Emitter, site: CallSite, origin: Origin): void {
  const method = site.chain
    ? (site.chain[site.chain.length - 1] as string)
    : "call";
  if (origin.kind === "vendor") {
    const surface =
      origin.vendor.surface === "first_attribute" && origin.tail.length > 1
        ? (origin.tail[0] as string)
        : (origin.tail[origin.tail.length - 1] as string);
    const ref: UnresolvedRef = {
      ref_kind: "external",
      value: `${origin.vendor.vendor}/${surface}`,
      hints: { sdk_symbol: origin.sdkSymbol },
      source_line: site.line,
    };
    em.edgeFromSite(site, {
      to: ref,
      kind: "external_call",
      label: method,
      confidence: origin.certain ? "certain" : "inferred",
      confidence_reason: origin.reason,
    });
    return;
  }

  const { service, config } = origin;
  if (!config) {
    em.unsupported(
      `boto3 service ${JSON.stringify(service)} is not in the vendor table; call ${origin.method} skipped`,
      site.line,
    );
    return;
  }
  if (config.kind === "external") {
    const ref: UnresolvedRef = {
      ref_kind: "external",
      value: `${config.vendor}/${config.surface}`,
      hints: { sdk_symbol: origin.sdkSymbol },
      source_line: site.line,
    };
    em.edgeFromSite(site, {
      to: ref,
      kind: "external_call",
      label: origin.method,
      confidence: origin.certain ? "certain" : "inferred",
      confidence_reason: origin.reason,
    });
    return;
  }

  // A queue is transport: publish/subscribe edges to a topic, never a vendor.
  const direction = config.publish_methods.includes(origin.method)
    ? "publish"
    : config.subscribe_methods.includes(origin.method)
      ? "subscribe"
      : null;
  if (direction === null) {
    em.unsupported(
      `boto3 ${service} method ${origin.method} is neither a publish nor a subscribe method in the vendor table`,
      site.line,
    );
    return;
  }
  const kwargs = keywordArguments(site.argumentList);
  const queueNode = kwargs.get(config.queue_kwarg) ?? null;
  const literal = stringLiteral(queueNode);
  const ref: UnresolvedRef = {
    ref_kind: "topic",
    value:
      literal ??
      (queueNode ? queueNode.text : `<${config.queue_kwarg} missing>`),
    hints: { direction },
    source_line: site.line,
  };
  const reason = literal
    ? origin.reason
    : `queue name is not a literal: ${queueNode ? queueNode.text : `${config.queue_kwarg} not passed as a keyword`}; left unresolved rather than guessed`;
  em.edgeFromSite(site, {
    to: ref,
    kind: direction,
    label: origin.method,
    confidence: literal && origin.certain ? "certain" : "inferred",
    confidence_reason: reason,
  });
}

export type { Callee, ValueInfo };
