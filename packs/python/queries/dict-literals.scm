; Module-level dictionary literals bound to a name: dispatch tables (parser
; §6.4) and the PEP 562 re-export map (`_ROUTER_MODULES`).
(module (expression_statement (assignment left: (identifier) @name right: (dictionary) @dict)))
