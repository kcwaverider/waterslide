; Assignments whose target is a plain name or a `self.<attr>` — the two shapes
; that bind a receiver type the pack can trace within the file.
(assignment left: (identifier) @name right: (_) @value) @assignment
(assignment left: (attribute object: (identifier) @object attribute: (identifier) @attr) right: (_) @value) @self_assignment
