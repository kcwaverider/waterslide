; Module-level and class-level definitions. Nested function definitions are
; deliberately not captured: they fold into the enclosing definition.
(module (function_definition) @function)
(module (decorated_definition definition: (function_definition)) @function)
(module (class_definition) @class)
(module (decorated_definition definition: (class_definition)) @class)
(class_definition body: (block (function_definition) @method))
(class_definition body: (block (decorated_definition definition: (function_definition)) @method))
