;; Swift branch detection (parser pipeline §6). Each capture is a branch
;; point whose limbs may gate different outgoing edges. The is_error_path
;; construct table lives in data/error-paths.json.

(if_statement) @if
(guard_statement) @guard
(switch_statement) @switch
(do_statement) @do
(ternary_expression) @ternary
