import type { Node } from "web-tree-sitter";

/** Everything the language layer knows about one file. Framework recognizers read this; they never re-parse. */
export interface FileContext {
  readonly repo: string;
  readonly path: string;
  readonly content: string;
  /** Importable module name, e.g. `api.endpoints.memory`. Empty for a root `__init__.py`. */
  readonly module: string;
  /** Enclosing package, for relative imports. */
  readonly package: string;
  readonly lineCount: number;
}

export interface Definition {
  readonly kind: "function" | "class";
  readonly name: string;
  /** `Class.method` for methods, else the bare name (graph model §1). */
  readonly qualifiedName: string;
  /** The `function_definition` / `class_definition` node. */
  readonly node: Node;
  /** The `decorated_definition` wrapper when decorated, else `node`. Spans come from this. */
  readonly outer: Node;
  /** Decorator expressions (the node after `@`), in source order. */
  readonly decorators: readonly Node[];
  /** The class a method belongs to. */
  readonly parent: Definition | null;
  readonly isAsync: boolean;
  /** Return annotation text, when written. Drives receiver types for factory calls. */
  readonly returnType: string | null;
}

export interface ClassInfo {
  readonly def: Definition;
  readonly methods: Map<string, Definition>;
  /** `self.<attr>` assignments and class-body annotations, first occurrence wins. */
  readonly attributes: Map<string, AttributeInfo>;
  /** Superclass expressions as attribute chains, e.g. `["BaseModel"]` or `["pydantic","BaseModel"]`. */
  readonly bases: readonly string[][];
}

export interface AttributeInfo {
  readonly name: string;
  readonly annotation: string | null;
  readonly value: ValueInfo | null;
  /** The first assignment was a literal (dict, list, str, None, ...): a builtin, not a traceable type. */
  readonly literal: boolean;
  readonly line: number;
}

/** The right-hand side of a binding, when it is a call: `x = Foo(...)`. */
export interface ValueInfo {
  readonly call: Node;
  readonly callee: Callee;
  readonly chain: readonly string[] | null;
}

export type Binding =
  | {
      readonly kind: "module_import";
      readonly qualified: string;
      readonly line: number;
    }
  | {
      readonly kind: "name_import";
      readonly qualified: string;
      readonly line: number;
    }
  | { readonly kind: "definition"; readonly def: Definition }
  | {
      readonly kind: "variable";
      readonly value: ValueInfo | null;
      readonly annotation: string | null;
      readonly line: number;
    }
  | { readonly kind: "parameter"; readonly annotation: string | null }
  | { readonly kind: "loop_or_context"; readonly line: number }
  /** A def/class nested in a function: folded into the enclosing definition (not a node). */
  | { readonly kind: "nested_definition"; readonly line: number };

export interface Scope {
  readonly bindings: Map<string, Binding>;
  readonly parent: Scope | null;
}

/** How a receiver chain's root resolved, for recognizers that pattern-match on it. */
export interface RootInfo {
  readonly name: string;
  readonly binding: Binding | null;
  /** Qualified name the root stands for, when it stands for one. */
  readonly qualified: string | null;
  /** The constructor call that produced the root's value, when traced. */
  readonly constructor: ValueInfo | null;
  readonly annotation: string | null;
  readonly via:
    | "module_import"
    | "name_import"
    | "definition"
    | "variable"
    | "self_attribute"
    | "self_method"
    | "parameter"
    | "unbound"
    | "builtin";
}

export type Callee =
  /** Resolved to a node in this file. */
  | { readonly kind: "in_file"; readonly def: Definition }
  /** A qualified symbol that lives elsewhere; `value` is alias-resolved. */
  | {
      readonly kind: "symbol";
      readonly value: string;
      readonly root: RootInfo;
      readonly rest: readonly string[];
      /** Non-null when the receiver could only be named, not typed (self attr without annotation). */
      readonly uncertainty: string | null;
    }
  | { readonly kind: "builtin"; readonly name: string }
  /** A call to a nested def or lambda bound in the enclosing function: internal plumbing, skipped silently. */
  | { readonly kind: "local"; readonly name: string }
  /** A bare name bound nowhere in the file: emitted verbatim, file-scoped provides may match it. */
  | {
      readonly kind: "unbound";
      readonly value: string;
      readonly root: RootInfo;
    }
  /** Receiver is a parameter, local, or call result with no traceable type. Not emitted; diagnosed. */
  | {
      readonly kind: "opaque";
      readonly reason: string;
      readonly root: RootInfo | null;
    }
  /** `table[key](...)` over a literal dict — a dispatch fan-out (parser §6.4). */
  | { readonly kind: "dispatch"; readonly table: DictTable }
  /** Callee is an expression the pack does not model (call result, lambda, subscript of non-table). */
  | { readonly kind: "dynamic"; readonly text: string };

export interface DictTable {
  readonly name: string;
  readonly node: Node;
  readonly line: number;
  /** Literal string key → value expression, in source order. Null when any key or value is not a plain literal/chain. */
  readonly entries:
    | readonly {
        key: string;
        valueChain: readonly string[] | null;
        valueNode: Node;
      }[]
    | null;
}

export interface CallSite {
  readonly call: Node;
  readonly calleeNode: Node;
  readonly argumentList: Node;
  /** Attribute chain of the callee, e.g. `["db","memories","find_one"]`; null for non-chain callees. */
  readonly chain: readonly string[] | null;
  readonly callee: Callee;
  /** The definition whose body contains the call; null for module-level statements. */
  readonly owner: Definition | null;
  readonly line: number;
  readonly lineEnd: number;
  readonly arity: number;
}

export interface FileModel {
  readonly file: FileContext;
  readonly root: Node;
  readonly moduleScope: Scope;
  readonly definitions: readonly Definition[];
  readonly classes: Map<string, ClassInfo>;
  readonly imports: readonly ImportRecord[];
  readonly dictTables: Map<string, DictTable>;
  readonly callSites: readonly CallSite[];
  /** Constructs seen but not modelled, for `unsupported_construct` diagnostics. */
  readonly unsupported: readonly { line: number; what: string }[];
  /** Function-scope lookups for recognizers that resolve names inside a definition. */
  scopeFor(def: Definition | null): Scope;
  /** Resolve an expression chain in a scope, as the analyzer would for a call. */
  resolveChain(
    chain: readonly string[],
    scope: Scope,
    owner: Definition | null,
  ): Callee;
  /** Resolve `<call>().a.b` — a call on the result of another call — to a callee. */
  resolveCallResult(
    receiverCall: Node,
    attrs: readonly string[],
    scope: Scope,
    owner: Definition | null,
  ): Callee;
}

export interface ImportRecord {
  /** Local name bound in this file. */
  readonly local: string;
  /** Fully qualified target after alias resolution. */
  readonly qualified: string;
  readonly form: "import" | "from";
  readonly line: number;
}
