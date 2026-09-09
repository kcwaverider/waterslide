import type { Node } from "web-tree-sitter";
import { parameterName } from "../language/analyze.js";
import type { Definition } from "../language/model.js";
import {
  attributeChain,
  positionalArguments,
  stringLiteral,
} from "../tree-sitter/runtime.js";
import type { FrameworkRecognizer } from "./types.js";

/**
 * AWS Lambda event handlers (A10 item 3). A module-level function that reads a
 * batch-event envelope key off one of its parameters — `event["Records"]`,
 * `event.get("Records", [])` — is an entry point whose kind the data table
 * names. Shape, never name: `handler` as a function name says nothing, and the
 * Mangum-wrapped HTTP handlers in the same tree are named exactly that.
 */
export const awsLambdaRecognizer: FrameworkRecognizer = {
  id: "aws_lambda",
  run(model, em) {
    const shapes = em.data.lambdaEventShapes.keys;
    for (const def of model.definitions) {
      if (def.kind !== "function" || def.parent !== null) continue;
      const params = def.node.childForFieldName("parameters");
      const names = new Set(
        (params?.namedChildren ?? [])
          .map((p) => parameterName(p).name)
          .filter((n): n is string => n !== null),
      );
      if (names.size === 0) continue;
      const key = envelopeKey(def, names, Object.keys(shapes));
      if (key === null) continue;
      const kind = shapes[key];
      if (!kind) continue;
      em.annotateNode(em.nodeIdFor(def), {
        is_entry_point: true,
        entry_point_kind: kind,
        tags: ["aws_lambda:event_handler"],
      });
    }
  },
};

/** The first envelope key the body reads off a parameter, in source order; null when none. */
function envelopeKey(
  def: Definition,
  params: ReadonlySet<string>,
  keys: readonly string[],
): string | null {
  const body = def.node.childForFieldName("body");
  if (!body) return null;
  const wanted = new Set(keys);
  let found: Node | null = null;
  const visit = (n: Node): void => {
    if (found) return;
    if (
      n.type === "function_definition" ||
      n.type === "class_definition" ||
      n.type === "lambda"
    )
      return;
    if (n.type === "subscript") {
      const value = n.childForFieldName("value");
      const sub = n.childForFieldName("subscript");
      if (value?.type === "identifier" && params.has(value.text)) {
        const lit = stringLiteral(sub);
        if (lit !== null && wanted.has(lit)) found = sub;
      }
    } else if (n.type === "call") {
      const fn = n.childForFieldName("function");
      const chain = fn ? attributeChain(fn) : null;
      if (
        chain &&
        chain.length === 2 &&
        params.has(chain[0] as string) &&
        chain[1] === "get"
      ) {
        const first =
          positionalArguments(n.childForFieldName("arguments"))[0] ?? null;
        const lit = stringLiteral(first);
        if (lit !== null && wanted.has(lit)) found = first;
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(body);
  return found ? stringLiteral(found) : null;
}
