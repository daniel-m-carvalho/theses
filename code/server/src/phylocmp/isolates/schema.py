"""Which isolate columns become queryable facets, and why the rest do not.

The TSVs carry 43 columns, most of which cannot usefully segment or filter a bar
chart. Selection is by rule rather than by a hand-written list, so a new export
with different columns still works:

* **Identifiers are excluded by name.** ``Uberstrain``, ``Barcode``, ``Sample``
  and friends are unique per row by construction -- 26,629 distinct values in
  26,629 rows. Dictionary-encoding them would store the file twice.
* **Constant columns are excluded.** ``Differences`` has one distinct value in
  both files and ``Collection Time`` is empty in all 38,597 clostridium rows.
  A facet that cannot divide anything is noise in the UI.
* **Very high cardinality is excluded.** Anything above
  ``MAX_FACET_CARDINALITY`` is identifier-like in practice, whatever it is
  called. This is what removes the finest HierCC levels: vibrio ``HC0`` has
  17,935 distinct values across 26,629 rows.
* **``ST`` is excluded** because it is the join key, not a facet. Filtering
  isolates by ST is what selecting a leaf already does.

Everything surviving is kept and reported with its cardinality, and
``segmentable`` marks those small enough to colour and put in a legend. The
frontend is told the number and can decide for itself; the server does not
silently drop a column because it judged it too wide.
"""

from __future__ import annotations

#: Above this, a column is an identifier in all but name.
MAX_FACET_CARDINALITY = 5_000

#: Above this a column can still be filtered on, but is a poor thing to colour
#: by: the legend stops being readable and a categorical scale runs out of
#: distinguishable colours long before.
MAX_SEGMENTABLE_CARDINALITY = 200

#: Unique-per-row by construction, or free text. Matched case-insensitively
#: against the column name, with a prefix match for the compound Data Source
#: column whose header embeds its own field list.
IDENTIFIER_COLUMNS = frozenset(
    {
        "uberstrain",
        "name",
        "sample",
        "secondary sample",
        "barcode",
        "comment",
    }
)
IDENTIFIER_PREFIXES = ("data source",)

#: The join key between an isolate and a tree leaf.
JOIN_COLUMN = "ST"


def slug(name: str) -> str:
    """A filesystem-safe name for a column, e.g. 'HC800 (ceBG)' -> 'hc800_cebg'."""
    parts = "".join(c.lower() if c.isalnum() else " " for c in name).split()
    return "_".join(parts) or "column"


def is_identifier(name: str) -> bool:
    lowered = name.strip().lower()
    return lowered in IDENTIFIER_COLUMNS or lowered.startswith(IDENTIFIER_PREFIXES)


def is_facet(name: str, n_distinct: int) -> bool:
    """Whether a column becomes a queryable facet."""
    if name == JOIN_COLUMN or is_identifier(name):
        return False
    return 2 <= n_distinct <= MAX_FACET_CARDINALITY


def is_segmentable(n_distinct: int) -> bool:
    return n_distinct <= MAX_SEGMENTABLE_CARDINALITY
