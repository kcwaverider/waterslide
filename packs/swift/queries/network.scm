;; URLSession / Foundation network recognizer (parser pipeline §7, item 3).
;; URL and URLRequest constructions are the evidence of an outbound HTTP
;; request; the path is reconstructed from the construction expression in
;; src/recognizers/network.ts. Finding the call is the easy part.

(call_expression
  (simple_identifier) @ctor
  (call_suffix) @suffix
  (#match? @ctor "^(URL|URLRequest)$")) @construction
