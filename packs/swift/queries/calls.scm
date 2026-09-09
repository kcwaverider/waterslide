;; Swift language recognizers — call sites (parser pipeline §3.5, §7).
;; Every call expression is a candidate edge. Receiver resolution, import and
;; typealias tables, self context and local scope are applied in
;; src/recognizers/calls.ts.

(call_expression) @call
