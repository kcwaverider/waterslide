from os.path import *
from typing import Any

handlers: dict[Any, Any] = {key(): value for key, value in []}


def run(kind):
    handlers[kind]()
    return join("a", "b")
