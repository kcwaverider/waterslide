import type { UnresolvedRef } from "@waterslide/core";
import type { Node } from "web-tree-sitter";
import type { Boto3Service, Vendor } from "../data.js";
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
    const { vendors, boto3 } = em.data.vendors;
    const vendorByModule = new Map(vendors.map((v) => [v.module, v] as const));

    for (const site of model.callSites) {
      if (em.isClaimed(site)) continue;
      if (isSdkConstructor(site, vendorByModule, boto3)) {
        em.claim(site);
        continue;
      }
      const origin = sdkOrigin(model, site, vendorByModule, boto3);
      if (!origin) continue;
      em.claim(site);
      emitOrigin(em, site, origin);
    }
  },
};

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
): boolean {
  if (site.callee.kind !== "symbol") return false;
  const segments = site.callee.value.split(".");
  if (segments.length !== 2) return false;
  const [moduleName, name] = segments as [string, string];
  if (moduleName === boto3.module) return boto3.factories.includes(name);
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
