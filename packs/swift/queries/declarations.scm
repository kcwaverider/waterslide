;; Swift language recognizers — declarations (parser pipeline §7).
;; Types, extensions, protocols, functions, initializers, computed properties,
;; imports and typealiases. The walk in src/recognizers/declarations.ts starts
;; from these captures; nesting is recovered from the tree, not from here.

(class_declaration) @type          ; class / struct / enum / actor / extension
(protocol_declaration) @protocol
(function_declaration) @function
(init_declaration) @init
(property_declaration
  (computed_property)) @computed_property
(import_declaration) @import
(typealias_declaration) @typealias
