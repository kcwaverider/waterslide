;; SwiftUI framework recognizer (parser pipeline §7, decisions item 9).
;; A view-modifier call with a trailing closure, or a Button construction, is
;; a ui_handler entry point. Which modifier names qualify is decided in
;; src/recognizers/swiftui.ts against the approved list; this query finds the
;; shape.

(call_expression
  (navigation_expression
    suffix: (navigation_suffix
      suffix: (simple_identifier) @modifier))
  (call_suffix
    (lambda_literal))) @modifier_call

(call_expression
  (simple_identifier) @callee
  (call_suffix) @suffix
  (#eq? @callee "Button")) @button_call
