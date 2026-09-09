/** In-memory model of one file while it is being analyzed. Not serialized. */
import type {
  Diagnostic,
  PackNode as GraphNode,
  PartialEdge,
  PayloadSchema,
  Provide,
} from "@waterslide/core";
import type { Node } from "web-tree-sitter";
import type {
  Candidate,
  ExtensionFact,
  FunctionFact,
  TypeFact,
} from "./state.js";
import type { TypeRef } from "./tree.js";

export interface Param {
  label: string | null;
  name: string;
  type: TypeRef | null;
}

export interface PropertyDecl {
  name: string;
  type: TypeRef | null;
  is_static: boolean;
  is_stored: boolean;
  init: Node | null;
  decl: Node;
}

export type OwnerForm =
  | "function"
  | "init"
  | "computed"
  /** A protocol requirement: declared, no body; conformers implement it. */
  | "requirement"
  /** A closure-typed stored property: a callable slot whose implementation is injected. */
  | "slot"
  | "handler"
  | "type"
  | "module";

/** Something edges can originate from: a declaration with a body, or a handler closure. */
export interface Owner {
  node_id: string;
  qualified: string;
  member: string;
  form: OwnerForm;
  decl: Node;
  body: Node | null;
  owner_type: TypeDecl | null;
  is_static: boolean;
  params: Param[];
  return_type: TypeRef | null;
  fact: FunctionFact | null;
  /** Set by the SwiftUI recognizer when a Button passes this method as its action. */
  is_entry_point?: boolean;
}

export interface TypeDecl {
  qualified: string;
  node_id: string;
  decl: Node;
  body: Node | null;
  declaration_kind:
    "class" | "struct" | "enum" | "actor" | "protocol" | "extension";
  conformances: string[];
  /** For extensions: the extended type's name as written. */
  extension_target: string | null;
  /** The declared type this same-file extension was merged into, if any. */
  merged_into: TypeDecl | null;
  properties: PropertyDecl[];
  /** Enum case names, for enums. */
  cases: string[];
  members: Map<string, Owner[]>;
  has_explicit_init: boolean;
  is_view: boolean;
  is_app: boolean;
  is_codable: boolean;
  fact: TypeFact | null;
  ext_fact: ExtensionFact | null;
}

export interface CallSite {
  edge: PartialEdge;
  call: Node;
  owner: Owner;
  candidate: Candidate | null;
  /** Set by branch detection when the site sits in a `catch` limb only. */
  catch_default: boolean;
}

export interface FileContext {
  repo: string;
  path: string;
  content: string;
  root: Node;
  module_id: string;
  imports: string[];
  typealiases: Map<string, string>;
  types: TypeDecl[];
  /** Declared (non-extension) types by qualified name. */
  declared: Map<string, TypeDecl>;
  extensions: TypeDecl[];
  owners: Owner[];
  ownersByNode: Map<number, Owner>;
  /** Nodes whose subtree has a syntax error; declarations inside are skipped. */
  errorNodes: Node[];
  nodes: GraphNode[];
  edges: PartialEdge[];
  schemas: PayloadSchema[];
  provides: Provide[];
  diagnostics: Diagnostic[];
  sites: CallSite[];
  http_types: Set<string>;
  dropped_receivers: number;
  expression_receivers: number;
  /** Calls of closures (locals, parameters, `$0`): invocations, not edges. */
  closure_calls: number;
  /** `.success(x)`-style implicit member calls: enum cases and static factories on an inferred type. */
  implicit_member_calls: number;
  unsupported: Map<string, number>;
  /** Call nodes that are framework constructs (handler modifiers, Button), not edges. */
  skipCalls: Set<number>;
  /** Methods referenced as `Button(action: Type.method)` whose type lives in another file. */
  entry_point_refs: { type_name: string; member: string }[];
}

/** Append a diagnostic for this file (graph model §10 shape). */
export function diag(
  ctx: FileContext,
  severity: Diagnostic["severity"],
  code: string,
  message: string,
  line: number | null,
): void {
  ctx.diagnostics.push({
    severity,
    code,
    message,
    repo: ctx.repo,
    path: ctx.path,
    line,
    pack: "swift",
  });
}

/** Innermost owner whose declaration contains `n`. */
export function ownerAt(ctx: FileContext, n: Node): Owner | null {
  let best: Owner | null = null;
  for (const o of ctx.owners) {
    if (o.decl.startIndex <= n.startIndex && n.endIndex <= o.decl.endIndex) {
      if (best === null || o.decl.startIndex >= best.decl.startIndex) best = o;
    }
  }
  return best;
}

/** Innermost type declaration (including extensions) containing `n`. */
export function typeAt(ctx: FileContext, n: Node): TypeDecl | null {
  let best: TypeDecl | null = null;
  for (const t of [...ctx.types, ...ctx.extensions]) {
    if (t.decl.startIndex <= n.startIndex && n.endIndex <= t.decl.endIndex) {
      if (best === null || t.decl.startIndex >= best.decl.startIndex) best = t;
    }
  }
  return best;
}

/** Whether a syntax-error node lies inside `n`. */
export function hasErrorInside(ctx: FileContext, n: Node): boolean {
  return ctx.errorNodes.some(
    (e) => n.startIndex <= e.startIndex && e.endIndex <= n.endIndex,
  );
}
