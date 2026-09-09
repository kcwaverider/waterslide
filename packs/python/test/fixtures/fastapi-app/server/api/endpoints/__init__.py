"""Router exports, resolved lazily (PEP 562), mirroring tapistree."""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

_ROUTER_MODULES: dict[str, str] = {
    "notes_router": "notes",
    "users_router": "users",
}

__all__ = list(_ROUTER_MODULES)


def __getattr__(name: str) -> Any:
    module_name = _ROUTER_MODULES.get(name)
    if module_name is None:
        raise AttributeError(name)
    from importlib import import_module

    router = getattr(import_module(f"{__name__}.{module_name}"), "router")
    globals()[name] = router
    return router


if TYPE_CHECKING:  # pragma: no cover
    from .notes import router as notes_router
    from .users import router as users_router
