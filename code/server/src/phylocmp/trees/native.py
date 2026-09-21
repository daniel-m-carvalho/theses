"""Load the native extension, if it has been built.

The extension is optional by design. It is gitignored, needs a C++ compiler,
and is not required for correctness: every native component has a Python
counterpart that produced the numbers this project reports, and those remain
the reference implementations. A machine without a compiler — a grader's
laptop, a minimal container — runs the whole backend from `uv sync` alone.

So nothing imports the extension directly. Callers ask here, get ``None`` if it
is absent, and fall back.
"""

from __future__ import annotations

import importlib.util
import threading
from types import ModuleType

from .. import config

_lock = threading.Lock()
_loaded: ModuleType | None = None
_attempted = False

MODULE_NAME = "phylocmp_native"


def extension() -> ModuleType | None:
    """The native module, or None if it is not built. Loaded once per process."""
    global _loaded, _attempted
    with _lock:
        if _attempted:
            return _loaded
        _attempted = True
        # Found by path rather than by sys.path, so a build in the repository
        # is used without anything being installed or the import path altered.
        candidates = sorted(config.NATIVE_DIR.glob(f"{MODULE_NAME}*.so"))
        for path in candidates:
            spec = importlib.util.spec_from_file_location(MODULE_NAME, path)
            if spec is None or spec.loader is None:
                continue
            try:
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
            except Exception:
                # A stale extension built for another interpreter should not
                # take the process down; the Python path still works.
                continue
            _loaded = module
            break
        return _loaded


def available() -> bool:
    return extension() is not None


def describe() -> str:
    return "native" if available() else "python"
