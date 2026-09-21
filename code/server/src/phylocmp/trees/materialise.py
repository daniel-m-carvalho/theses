"""Materialise reconciled trees as files for a subprocess metric to read.

A metric that is a separate program cannot be handed a ``TreeArrays``; it takes
file paths. The trees it must be given are the **reconciled** ones, restricted
to the leaves the pair shares and re-canonicalised, and those exist only in
memory (``trees.reconcile``). So they have to be written out.

**Written once per pair, not once per metric.** Computing RF and triplet for the
same pair should not serialise the same two trees twice, and the files are
hundreds of KB each. A ``MaterialisedPair`` holds the arrays and writes lazily,
caching by the options it was asked for.

The distinction that earns the cache a second key: **with and without branch
lengths are different files**, and which one a tool gets changes what it
computes. TreeDiff infers weighted mode from the first ``:`` it encounters and
silently returns wRF rather than RF.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .newick import TreeArrays
from .newick_writer import write_newick


@dataclass
class MaterialisedPair:
    """Lazily writes a reconciled pair to disk, once per distinct form."""

    pair_id: str
    left: TreeArrays
    right: TreeArrays
    directory: Path
    _written: dict[tuple[str, bool], Path] = field(default_factory=dict, repr=False)

    def newick(self, side: str, include_lengths: bool = True) -> Path:
        """Path to this side as Newick, writing it if it is not already there."""
        if side not in ("left", "right"):
            raise ValueError(f"side must be 'left' or 'right', not {side!r}")
        key = (side, include_lengths)
        if key not in self._written:
            suffix = "" if include_lengths else ".topology"
            path = self.directory / f"{side}{suffix}.nwk"
            arrays = self.left if side == "left" else self.right
            self._written[key] = write_newick(
                path, arrays, include_lengths=include_lengths
            )
        return self._written[key]

    def cleanup(self) -> None:
        """Remove what was written. Safe to call more than once."""
        for path in self._written.values():
            path.unlink(missing_ok=True)
        self._written.clear()
        # Only if we emptied it; another pair may share the parent.
        if self.directory.is_dir() and not any(self.directory.iterdir()):
            self.directory.rmdir()

    def __enter__(self) -> "MaterialisedPair":
        return self

    def __exit__(self, *exc: object) -> None:
        self.cleanup()
