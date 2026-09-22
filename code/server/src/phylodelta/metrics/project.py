"""Place values computed on a reconciled pair back onto the stored trees.

A comparison can only be computed over the leaf set the two trees share, so it
runs on reconciled copies whose pre-order numbering differs from the stored
trees' (``trees.reconcile``). The API, however, serves the stored trees under
the stored trees' node ids. Values must therefore be projected back, and nodes
with no counterpart must be marked **explicitly** rather than left at whatever
value happened to occupy the slot.

This is the failure the whole design is arranged against: dropping one leaf from
a 17,646-leaf tree shifts every index after it, and the result is arrays that
are each individually well-formed while attaching the wrong values to the wrong
clades. Nothing throws. The permanent guard is a test asserting that every
displayed leaf's counterpart carries the same label.

Fill values are per-column and deliberate:

* ``similarity`` fills **NaN** — "not measured here", distinct from 0.0, which
  would read as "nothing in common".
* ``corresponds`` fills ``NO_CORRESPONDENCE``, and must also be **translated**
  through the other tree's mapping, since it points into *that* tree's
  reconciled numbering.
* a metric's own columns fill by dtype: NaN for floats, 0 for integers.
"""

from __future__ import annotations

import numpy as np

from ..trees.correspondence import (
    NO_CORRESPONDENCE,
    Correspondence,
    CorrespondenceSide,
)
from .contract import MetricResult, MetricSide


def _fill_for(dtype: np.dtype):
    """What an unmeasured node holds. Floats can say "unknown"; integers cannot."""
    return np.nan if np.issubdtype(dtype, np.floating) else 0


def project_column(
    values: np.ndarray, source_index: np.ndarray, n_nodes: int
) -> np.ndarray:
    """Lift one column from reconciled indexing to stored indexing."""
    array = np.asarray(values)
    dtype = np.uint8 if array.dtype == np.bool_ else array.dtype
    out = np.full(n_nodes, _fill_for(dtype), dtype=dtype)
    out[source_index] = array.astype(dtype, copy=False)
    return out


def project_corresponds(
    values: np.ndarray,
    source_index: np.ndarray,
    other_source_index: np.ndarray,
    n_nodes: int,
) -> np.ndarray:
    """Lift a correspondence column, translating where it points.

    Two mappings are involved, not one: the position moves through this tree's
    index, and the *value* moves through the other tree's.
    """
    out = np.full(n_nodes, NO_CORRESPONDENCE, dtype=np.uint32)
    pointed = np.asarray(values).astype(np.int64)
    known = pointed != int(NO_CORRESPONDENCE)
    translated = np.full(len(pointed), NO_CORRESPONDENCE, dtype=np.uint32)
    translated[known] = other_source_index[pointed[known]].astype(np.uint32)
    out[source_index] = translated
    return out


def project_correspondence(
    correspondence: Correspondence,
    left_source_index: np.ndarray,
    right_source_index: np.ndarray,
    n_left_nodes: int,
    n_right_nodes: int,
) -> Correspondence:
    """Project both sides of a correspondence onto the stored trees."""

    def side(
        values: CorrespondenceSide, own: np.ndarray, other: np.ndarray, n: int
    ) -> CorrespondenceSide:
        return CorrespondenceSide(
            similarity=project_column(values.similarity, own, n),
            corresponds=project_corresponds(values.corresponds, own, other, n),
        )

    return Correspondence(
        left=side(
            correspondence.left, left_source_index, right_source_index, n_left_nodes
        ),
        right=side(
            correspondence.right, right_source_index, left_source_index, n_right_nodes
        ),
        left_to_right=correspondence.left_to_right,
        right_to_left=correspondence.right_to_left,
    )


def project(
    result: MetricResult,
    left_source_index: np.ndarray,
    right_source_index: np.ndarray,
    n_left_nodes: int,
    n_right_nodes: int,
) -> MetricResult:
    """Project a metric's own columns onto the stored trees.

    A metric with no per-node columns passes through unchanged — that is a
    supported result, not an error.
    """

    def side(values: MetricSide | None, own: np.ndarray, n: int) -> MetricSide | None:
        if values is None or not values.columns:
            return values
        return MetricSide(
            columns={
                name: project_column(column, own, n)
                for name, column in values.columns.items()
            }
        )

    return MetricResult(
        name=result.name,
        summary=dict(result.summary),
        left=side(result.left, left_source_index, n_left_nodes),
        right=side(result.right, right_source_index, n_right_nodes),
        notes=dict(result.notes),
    )
