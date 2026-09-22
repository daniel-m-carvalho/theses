"""The wire contract.

These models *are* the API. FastAPI generates the OpenAPI document from them, so
this file is what gets handed to whoever writes the frontend.

Two conventions run through all of it:

* **Node identity is the pre-order index**, an integer, never a clade-derived
  key. Measured: the vibrio root's clade key is a 93 KB string, and a key
  derived from clade membership does not even match on a pruned tree, which is
  what the client always displays. Integers are O(1), stable, and small.
* **Payloads are positional.** Parallel arrays in one agreed order, never
  ``{key: value}`` objects. Measured with gzip on 17,645 values: 41 KB
  positional against 236 KB keyed, 5.7x, because alignment removes the key and
  float runs compress far better than high-entropy hashes.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str = Field(examples=["ok"])
    version: str
    store_ready: bool = Field(description="False until the precompute CLI has been run.")


class TreeSummary(BaseModel):
    """A tree's header — everything except the node columns themselves."""

    id: str = Field(examples=["vibrio-upgma"])
    species: str = Field(examples=["vibrio"])
    method: str = Field(examples=["upgma", "nj"])
    n_nodes: int
    n_leaves: int
    max_depth: int = Field(
        description=(
            "Deepest node, in edges from the root. Far larger than a balanced "
            "tree of the same size: 443 for vibrio UPGMA against ~15 balanced. "
            "This is why fixed-depth chunking was rejected."
        )
    )


class PairSummary(BaseModel):
    """A comparable pair of trees, and the evidence for that comparability.

    Any two trees sharing leaf labels can be compared; whether the comparison
    *means* anything is a judgement for the person making it, so this reports
    what the matching was based on instead of deciding for them.
    """

    id: str = Field(examples=["vibrio-upgma__vibrio-nj"])
    left: str
    right: str
    #: The species of both trees when they agree, otherwise "left/right".
    species: str
    same_species: bool = True
    #: How the two label spaces were related. "identity" means leaf labels were
    #: compared as strings.
    label_match: str = "identity"
    shared_leaves: int = 0
    #: Shared leaves as a fraction of the smaller tree.
    shared_fraction: float = 0.0
    #: Set when the matching is suspect and the client should say so. Sequence
    #: types are numbered per species, so a vibrio and a clostridium tree
    #: overlap on ~99% of labels while sharing no actual organism.
    caution: str | None = None
    metrics: list[str] = Field(default_factory=list)


class IsolateSummary(BaseModel):
    """One species' isolate metadata store."""

    species: str
    n_rows: int
    keys: list[str]


class DatasetsResponse(BaseModel):
    """Everything the frontend needs to populate its dataset pickers."""

    trees: list[TreeSummary]
    pairs: list[PairSummary]
    isolates: list[IsolateSummary]


class ColumnDescription(BaseModel):
    """A per-node column a metric produces, described well enough to render.

    The server states no colours (§9.2); `semantics` says what the values *are*
    and `render` is a hint about what a client might reasonably do with them.
    """

    name: str = Field(examples=["exact"])
    dtype: str = Field(examples=["uint8", "float32"])
    semantics: str = Field(
        description="boolean | ratio | count | index | number — how to read the values.",
        examples=["boolean"],
    )
    label: str = ""
    description: str = ""
    render: str = Field(
        "value",
        description="gradient | overlay | value | link — a suggestion, not an instruction.",
    )


class ScalarDescription(BaseModel):
    key: str = Field(examples=["rf"])
    label: str = ""
    description: str = ""


class MetricOutputsDescription(BaseModel):
    """What a metric produces.

    An empty `columns` list is meaningful: the metric contributes a number and
    nothing per node. It is still fully usable — branch and leaf colouring come
    from the pair's correspondence, not from the metric.
    """

    summary: list[ScalarDescription] = Field(
        default_factory=list,
        description=(
            "Labelled summary scalars. Not exhaustive: `summary` on a result is "
            "free-form, and a metric may report numbers it did not declare."
        ),
    )
    columns: list[ColumnDescription] = Field(default_factory=list)


class MetricSummary(BaseModel):
    """A registered comparison metric and what it can do.

    ``capabilities`` is declared by the plugin's manifest so the frontend can
    enable or grey out controls without probing the backend.
    """

    name: str = Field(examples=["rf"])
    title: str = Field(examples=["Robinson-Foulds"])
    description: str = ""
    kind: str = Field(description="How it is invoked: 'python' in-process, or 'subprocess'.")
    available: bool = Field(
        True,
        description=(
            "Whether this metric can run here now. False when it is a "
            "subprocess metric whose binary has not been built — it is still "
            "listed, because it exists and is configured, but offering it to a "
            "user would only produce an error."
        ),
    )
    version: str = "1"
    capabilities: dict[str, bool] = Field(default_factory=dict)
    outputs: MetricOutputsDescription = Field(
        default_factory=MetricOutputsDescription,
        description="What this metric contributes, beyond the shared correspondence.",
    )


class TreeDetail(TreeSummary):
    """One tree's full header."""

    source: str = Field(description="The dataset file it was ingested from.")
    suppressed_unary: int = Field(
        0,
        description=(
            "Unary internal nodes removed when the tree was canonicalised. "
            "Non-zero means stored node ids are this server's canonical "
            "numbering, not offsets into the source file."
        ),
    )
    created: str = ""


class SliceNodes(BaseModel):
    """A summarised subtree as parallel arrays, in pre-order.

    Positional, not keyed (§1.6): entry *k* of every array describes the same
    node. Comparison values for the same slice arrive in this same order, so the
    client pairs them up by index without a lookup.
    """

    id: list[int] = Field(
        description=(
            "Pre-order index in the STORED tree. The join key for everything "
            "else: comparison values, metadata, and a follow-up request to "
            "expand this node."
        )
    )
    parent: list[int] = Field(
        description="Index into THESE arrays, or -1 at the slice root. Not a stored id."
    )
    label: list[str]
    branch_len: list[float | None] = Field(
        description="null where the source Newick gave no length."
    )
    true_leaf_count: list[int] = Field(
        description=(
            "Leaves beneath this node in the FULL tree — not the number "
            "returned beneath it here. This is what sizes a collapsed wedge "
            "and says how much is hidden behind it."
        )
    )
    truncated: list[bool] = Field(
        description=(
            "True where this tip stands for a clade that was not expanded. "
            "Its true_leaf_count is how many leaves it represents, and it is "
            "the node to request next to expand it."
        )
    )


class TreeSlice(BaseModel):
    """A subtree reduced to a leaf budget, largest clades first."""

    tree: str
    root: int = Field(description="Stored node id this slice is rooted at.")
    budget: int
    displayed_leaves: int = Field(description="Tips returned; never exceeds budget.")
    hidden_leaves: int = Field(
        description="Leaves represented by wedges rather than shown individually."
    )
    total_leaves: int = Field(
        description=(
            "Leaves under this root in the full tree. Always equals "
            "displayed_leaves - (wedge count) + hidden_leaves: a slice defers, "
            "it never discards."
        )
    )
    nodes: SliceNodes
    comparison: "ComparisonValues | None" = Field(
        None,
        description=(
            "Present when ?compare=<pair> was given. Aligned to `nodes` index "
            "for index, from the same summarisation — so no second request and "
            "no join is needed."
        ),
    )


class ComparisonSummary(BaseModel):
    """A computed comparison: the scalars, and what it was computed over."""

    pair: str = Field(examples=["vibrio-nj__vibrio-upgma"])
    metric: str = Field(examples=["rf"])
    left: str
    right: str
    summary: dict[str, float | int | str] = Field(
        description=(
            "Metric-specific scalars, e.g. rf, rf_normalised, shared_clusters. "
            "Free-form because metrics differ; render generically."
        )
    )
    shared_leaves: int
    dropped_from_left: list[str] = Field(
        description="Leaf labels present only in the left tree, so excluded from the metric."
    )
    dropped_from_right: list[str] = Field(default_factory=list)
    same_species: bool = True
    caution: str | None = Field(
        None,
        description=(
            "Present when the leaf matching is suspect — e.g. a cross-species "
            "pair, where sequence types collide without sharing organisms."
        ),
    )
    values: "ComparisonValues | None" = Field(
        None,
        description=(
            "Whole-tree per-node values, only when include_values=true. This is "
            "one entry per node of the full tree and is large; slices are the "
            "intended way to read values."
        ),
    )


class ComparisonValues(BaseModel):
    """Per-node comparison values, positional (§1.6).

    Entry *k* describes the node at entry *k* of the accompanying topology. The
    ``id`` array is included so alignment can be checked rather than assumed.

    Two sources are composed here. ``similarity`` and ``corresponds`` come from
    the pair's **correspondence** and are present for every comparison. The rest
    are the **metric's own** columns, and a metric may contribute none — a
    geodesic distance is a single number over branch lengths with no per-clade
    meaning, and is perfectly usable: the colouring never depended on it.
    """

    id: list[int] = Field(description="Stored node ids, matching the slice's nodes.id.")
    similarity: list[float | None] = Field(
        description=(
            "Overlap with the best corresponding clade in the other tree, 0..1. "
            "null where the node has no counterpart — it exists only in this "
            "tree, or was excluded when the leaf sets were reconciled. "
            "Drives the branch colour gradient, for every metric."
        )
    )
    corresponds: list[int | None] = Field(
        description=(
            "Stored node id of the counterpart in the OTHER tree, or null if "
            "there is none. For a leaf, null means it is unique to this tree — "
            "which is what an equal/different leaf colouring keys off."
        )
    )
    exact: list[bool] = Field(
        default_factory=list,
        description=(
            "Robinson-Foulds' verdict: is this clade present in the other tree "
            "identically? Empty for a metric that does not define one. It is "
            "binary by nature and saturates on large clades, so it suits a "
            "filter or overlay rather than a colour scale — use `similarity` "
            "for that."
        ),
    )
    columns: dict[str, list] = Field(
        default_factory=dict,
        description=(
            "Any further per-node columns this metric declared, by name. "
            "GET /api/metrics describes what a given metric produces, so a "
            "client can render a column it has not seen before."
        ),
    )


class ComparisonSlice(BaseModel):
    """Comparison values for one tree of a pair, aligned to a tree slice."""

    pair: str
    metric: str
    tree: str = Field(description="Which tree of the pair these values describe.")
    other_tree: str = Field(description="The tree that `corresponds` points into.")
    root: int
    budget: int
    nodes: ComparisonValues


class FacetSummary(BaseModel):
    """One queryable isolate column."""

    name: str = Field(examples=["Country"])
    n_distinct: int
    n_missing: int = Field(description="Isolates with no value for this key.")
    segmentable: bool = Field(
        description=(
            "A hint, not a restriction: true when the value count is small "
            "enough to colour and put in a legend. Wide keys can still filter."
        )
    )


class IsolateKeys(BaseModel):
    species: str
    n_isolates: int
    n_sequence_types: int = Field(
        description="Distinct STs with at least one isolate. The join key to tree leaves."
    )
    source: str
    facets: list[FacetSummary]


class ValueCount(BaseModel):
    value: str | None = Field(
        description="null for isolates with no value for this key — a real state, not a zero count."
    )
    count: int


class FacetValues(BaseModel):
    key: str
    values: list[ValueCount] = Field(description="Commonest first; blanks last.")


class CompositionRequest(BaseModel):
    """What to count, for which leaves.

    One key segments and colours; the rest filter. Filters combine with AND
    across keys and OR within a key.
    """

    leaves: list[str] = Field(
        description="Leaf labels (sequence types) — normally a slice's visible leaves.",
        examples=[["1", "2", "3"]],
    )
    segment_by: str = Field(examples=["Continent"])
    filter: dict[str, list[str]] = Field(
        default_factory=dict,
        examples=[{"Source Niche": ["Human"], "Country": ["Bangladesh", "India"]}],
    )


class LeafCompositionOut(BaseModel):
    leaf: str
    total: int = Field(description="Isolates for this leaf that passed every filter.")
    available: int = Field(
        description=(
            "Isolates for this leaf before filtering. total == 0 < available "
            "means everything was filtered out; available == 0 means the leaf "
            "has no isolate data at all, which is true of 3.9% of vibrio "
            "leaves and 10.9% of clostridium's."
        )
    )
    segments: list[ValueCount]


class CompositionResponse(BaseModel):
    species: str
    segment_by: str
    filter: dict[str, list[str]]
    leaves: list[LeafCompositionOut]
