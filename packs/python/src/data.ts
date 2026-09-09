import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EntryPointKindSchema } from "@waterslide/core";
import { z } from "zod";
import { packageRoot } from "./tree-sitter/runtime.js";

/**
 * The pack's data tables (handoff §2: construct tables live in data files, not
 * code). Each is validated on load so a typo fails loudly rather than
 * silently thinning the map.
 */

const ErrorPathRuleSchema = z.strictObject({
  construct: z.enum([
    "raise",
    "return_error_response",
    "except_clause",
    "early_return",
    "continues",
  ]),
  is_error_path: z.boolean(),
  uncertain: z.boolean().optional(),
  note: z.string(),
});
export const ErrorPathTableSchema = z.strictObject({
  $comment: z.string().optional(),
  language: z.literal("python"),
  rules: z.array(ErrorPathRuleSchema).min(1),
  error_response_callees: z.array(z.string()),
});
export type ErrorPathTable = z.infer<typeof ErrorPathTableSchema>;
export type ErrorPathConstruct = z.infer<
  typeof ErrorPathRuleSchema
>["construct"];

const VendorSchema = z.strictObject({
  module: z.string(),
  vendor: z.string(),
  constructors: z.array(z.string()),
  /** `first_attribute`: `client.messages.create` → `messages`; `method`: `client.embed` → `embed`. */
  surface: z.enum(["first_attribute", "method"]),
  module_functions: z.record(z.string(), z.string()),
});
const Boto3ServiceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("external"),
    vendor: z.string(),
    surface: z.string(),
  }),
  z.strictObject({
    kind: z.literal("topic"),
    publish_methods: z.array(z.string()),
    subscribe_methods: z.array(z.string()),
    queue_kwarg: z.string(),
  }),
]);
const HttpClientSchema = z.strictObject({
  module: z.string(),
  constructors: z.array(z.string()),
  /** `requests.get(url)`: the module itself exposes the verbs. */
  module_functions: z.boolean(),
});
export type HttpClient = z.infer<typeof HttpClientSchema>;

export const VendorTableSchema = z.strictObject({
  $comment: z.string().optional(),
  vendors: z.array(VendorSchema),
  http_clients: z.strictObject({
    $comment: z.string().optional(),
    clients: z.array(HttpClientSchema),
    methods: z.record(z.string(), z.string().nullable()),
  }),
  boto3: z.strictObject({
    module: z.string(),
    factories: z.array(z.string()),
    services: z.record(z.string(), Boto3ServiceSchema),
  }),
});
export type VendorTable = z.infer<typeof VendorTableSchema>;
export type Vendor = z.infer<typeof VendorSchema>;
export type Boto3Service = z.infer<typeof Boto3ServiceSchema>;

export const MongoTableSchema = z.strictObject({
  $comment: z.string().optional(),
  read: z.array(z.string()),
  write: z.array(z.string()),
  receiver_roots: z.array(z.string()),
  receiver_module_markers: z.array(z.string()),
});
export type MongoTable = z.infer<typeof MongoTableSchema>;

export const BuiltinsSchema = z.strictObject({
  $comment: z.string().optional(),
  names: z.array(z.string()),
});

export const NoiseTableSchema = z.strictObject({
  $comment: z.string().optional(),
  library_modules: BuiltinsSchema,
  value_methods: BuiltinsSchema,
  model_methods: BuiltinsSchema,
});
export const LambdaEventShapesSchema = z.strictObject({
  $comment: z.string().optional(),
  keys: z.record(z.string(), EntryPointKindSchema),
});
export type LambdaEventShapes = z.infer<typeof LambdaEventShapesSchema>;

export interface NoiseTable {
  readonly libraryModules: ReadonlySet<string>;
  readonly valueMethods: ReadonlySet<string>;
  readonly modelMethods: ReadonlySet<string>;
}

export interface PackData {
  readonly errorPaths: ErrorPathTable;
  readonly vendors: VendorTable;
  readonly mongo: MongoTable;
  readonly builtins: ReadonlySet<string>;
  readonly stdlibModules: ReadonlySet<string>;
  readonly noise: NoiseTable;
  readonly lambdaEventShapes: LambdaEventShapes;
}

function loadJson<T>(file: string, schema: z.ZodType<T>): T {
  const raw: unknown = JSON.parse(
    readFileSync(join(packageRoot(), "data", file), "utf8"),
  );
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `pack-python: data/${file} is malformed: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

let cached: PackData | null = null;

export function loadPackData(): PackData {
  cached ??= {
    errorPaths: loadJson("error-path-constructs.json", ErrorPathTableSchema),
    vendors: loadJson("vendors.json", VendorTableSchema),
    mongo: loadJson("mongo-methods.json", MongoTableSchema),
    builtins: new Set(loadJson("builtins.json", BuiltinsSchema).names),
    stdlibModules: new Set(
      loadJson("stdlib-modules.json", BuiltinsSchema).names,
    ),
    lambdaEventShapes: loadJson(
      "lambda-event-shapes.json",
      LambdaEventShapesSchema,
    ),
    noise: (() => {
      const t = loadJson("noise.json", NoiseTableSchema);
      return {
        libraryModules: new Set(t.library_modules.names),
        valueMethods: new Set(t.value_methods.names),
        modelMethods: new Set(t.model_methods.names),
      };
    })(),
  };
  return cached;
}
