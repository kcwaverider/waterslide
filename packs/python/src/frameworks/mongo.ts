import type { UnresolvedRef } from "@waterslide/core";
import type { Emitter } from "../emitter.js";
import type { Callee, CallSite, FileModel } from "../language/model.js";
import type { FrameworkRecognizer } from "./types.js";

/**
 * Motor / PyMongo collection access (parser §8, decision item 6):
 * `<receiver>.<collection>.<method>(...)`. The collection is the attribute name,
 * read-versus-write is the method name, and every result is `inferred` because
 * both come from naming conventions, not from a type the pack can see. The pack
 * never mints `mongo:` nodes — the database name lives outside any one file.
 */
export const mongoRecognizer: FrameworkRecognizer = {
  id: "mongo",
  run(model, em) {
    const table = em.data.mongo;
    const read = new Set(table.read);
    const write = new Set(table.write);
    const roots = new Set(table.receiver_roots);
    const markers = table.receiver_module_markers;

    for (const site of model.callSites) {
      if (em.isClaimed(site)) continue;
      const chain = site.chain;
      if (!chain || chain.length < 3) continue;
      const method = chain[chain.length - 1] as string;
      const collection = chain[chain.length - 2] as string;
      const receiverChain = chain.slice(0, -2);
      // The collection attribute hangs directly off the handle: `db.notes`,
      // `self.db.notes`. `db.mongo_client.admin.command` is not a collection.
      if (
        receiverChain.length > 2 ||
        (receiverChain.length === 2 &&
          receiverChain[0] !== "self" &&
          receiverChain[0] !== "cls")
      )
        continue;
      const receiverText = receiverChain.join(".");
      const known = read.has(method) || write.has(method);

      const receiver = model.resolveChain(
        receiverChain,
        model.scopeFor(site.owner),
        site.owner,
      );
      const strong = strongReceiver(receiver, markers);
      const weak = weakReceiver(receiverChain, roots);
      if (!strong && !(weak && known)) continue;

      em.claim(site);
      const operation: "read" | "write" | null = read.has(method)
        ? "read"
        : write.has(method)
          ? "write"
          : null;
      const ref: UnresolvedRef = {
        ref_kind: "datastore",
        value: collection,
        // Amendment A5: exact shape. `namespace` is the Mongo db, null when
        // it lives outside this file (tapistree: an env default elsewhere).
        hints: {
          ...(operation ? { operation } : {}),
          store: "mongo",
          namespace: null,
        },
        source_line: site.line,
      };
      const why =
        strong ?? `receiver ${receiverText} is named like a database handle`;
      let reason = `inferred collection '${collection}' from attribute access on ${receiverText}; ${why}`;
      if (operation === null) {
        reason += `; method ${method} is not in the read/write table, edge kind defaulted to read`;
        em.unsupported(
          `Mongo method ${method} on ${receiverText}.${collection} is not in the read/write table; emitted with operation omitted`,
          site.line,
        );
      }
      em.edgeFromSite(site, {
        to: ref,
        kind: operation ?? "read",
        label: method,
        confidence: "inferred",
        confidence_reason: reason,
      });
    }

    // `db.notes.find(...).sort(...).to_list(...)`: cursor methods on a claimed
    // access are the same access, not further datastore calls or symbols.
    const claimedCalls = new Set(
      model.callSites.filter((s) => em.isClaimed(s)).map((s) => s.call.id),
    );
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

/** The receiver traces to a database module or Motor/PyMongo constructor: a reason string, or null. */
function strongReceiver(
  receiver: Callee,
  markers: readonly string[],
): string | null {
  const hit = (q: string | null): boolean =>
    q !== null &&
    q
      .toLowerCase()
      .split(".")
      .some((seg) => markers.includes(seg) || seg.includes("mongo"));
  if (receiver.kind === "symbol") {
    if (hit(receiver.root.qualified))
      return `receiver resolves to ${receiver.root.qualified}`;
    if (hit(receiver.value)) return `receiver resolves to ${receiver.value}`;
    const ctor = receiver.root.constructor;
    if (ctor && ctor.callee.kind === "symbol" && hit(ctor.callee.value))
      return `receiver constructed by ${ctor.callee.value}(...)`;
    if (hit(receiver.root.annotation))
      return `receiver annotated ${receiver.root.annotation ?? ""}`;
  }
  if (receiver.kind === "in_file" && hit(receiver.def.qualifiedName))
    return `receiver is ${receiver.def.qualifiedName} in this file`;
  if (receiver.kind === "opaque" && receiver.root) {
    if (hit(receiver.root.annotation))
      return `receiver annotated ${receiver.root.annotation ?? ""}`;
    const ctor = receiver.root.constructor;
    if (ctor && ctor.callee.kind === "symbol" && hit(ctor.callee.value))
      return `receiver constructed by ${ctor.callee.value}(...)`;
  }
  return null;
}

/** The receiver is only *named* like a database handle (`db`, `self.db`): needs a known method to count. */
function weakReceiver(
  receiverChain: readonly string[],
  roots: ReadonlySet<string>,
): boolean {
  const leaf = receiverChain[receiverChain.length - 1];
  return leaf !== undefined && roots.has(leaf);
}

export type { CallSite };
