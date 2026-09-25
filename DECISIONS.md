# Design record

The reasoning behind **the whole project** — the rendering library (`code/lib`), the backend
(`code/server`) and the frontend (`code/web`): every decision with the alternatives that were
weighed against it, why it went the way it did, and the measurement or observation that settled it.

One file rather than three, because the decisions do not divide that way. Where the slicing budget
is chosen is a question about the browser's drawing rate and the server's summariser at the same
time; whether the export belongs to the library or the app is a question about what the library is
*for*. Splitting them by directory would file each argument under one of its halves.

It is written **as decisions are made**, one section per milestone, because the alternatives and the
evidence are the parts that stop being recoverable once the code exists. It feeds two thesis
chapters directly:

* **Proposed solution** — the *what and why*: the model of the problem and the shape of the answer.
* **Implementation** — the *how*: layouts, byte budgets, endpoints, and what was deliberately left
  undone.

Entries are formatted **Decision · Alternatives considered · Rationale · Evidence**. Where an
alternative was tried and abandoned, it is recorded as such: a design record that lists only
successes cannot answer the question an examiner actually asks, which is why the other options were
rejected.

---

## 0. The problem, and what is being claimed

The thesis claim is **client-side**. What is measured is the time and memory a *browser* spends
presenting and navigating a comparison of two large phylogenetic trees, and how that scales towards
500k+ nodes. Backend computation time and space are explicitly **not** the claim.

That single sentence determines the architecture. If the expensive work does not have to be fast,
it should be moved off the request path entirely — computed once, offline, stored in a form that
makes serving trivial. Every decision below follows from it.

Existing tools establish the problem. **phylo.io** loads the complete tree into the browser before
it can show anything: measured on the vibrio UPGMA tree (17,646 leaves), it spends **945 ms** in
parsing alone, against **48 ms** for the same file in this project's rendering library. Its
comparison step is worse than linear — `build_table` implements Day's (1985) linear-time
construction and the matching loop that follows then discards it, giving roughly **O(n² log n)**.
Both costs are paid in the browser, on the main thread, before the first frame.

---

## 1. Foundations — parsing, canonical form, and the store

*Milestone 1. Code: `trees/newick.py`, `trees/normalise.py`, `trees/store.py`, `catalogue.py`,
`api/`.*

### 1.1 Node identity is the pre-order index

**Decision.** A node is identified by its position in a pre-order walk of the tree: a plain integer.
Every column in the store is indexed by it, and it is what appears on the wire.

**Alternatives considered.** A key derived from clade membership — a hash or sorted join of the leaf
labels beneath the node. This is what the rendering library offers as `keyByClade`, and it has the
attraction of being comparable *across* trees without a separate mapping.

**Rationale.** Clade keys are large, expensive, and — decisively — wrong for the thing being
displayed. The client never shows a full tree; it shows a pruned summary. A key derived from clade
membership changes when the clade is pruned, so it fails to match precisely in the case that
matters. Cross-tree matching is a genuinely separate concern and gets an explicit correspondence
map rather than being smuggled into the identifier.

**Evidence.** The vibrio root's `keyByClade` string alone is **93 KB**, and the library recomputes
such keys uncached, per node *and* per edge, on every refresh. An integer is O(1) to produce and 4
bytes to send.

### 1.2 Pre-order plus an interval encoding, as one structure serving two purposes

**Decision.** Alongside `parent`, each node stores `subtree_end`: the exclusive end of the
contiguous index range its descendants occupy. The subtree rooted at `i` is exactly `[i,
subtree_end[i])` in every column.

**Alternatives considered.** An explicit child-list or adjacency structure, traversed on demand; or
a separate index mapping each node to its descendant set.

**Rationale.** This is the load-bearing decision of the whole backend, because the same layout
answers two questions that would otherwise need two representations:

* **Serving a subtree is a memcpy.** No traversal, no descendant index, no per-request graph walk —
  a contiguous range of each column.
* **Robinson-Foulds is linear.** The interval *is* the cluster: the leaves under `i` are the
  leaf-valued entries of that same range. This is exactly the structure Day (1985) constructs to
  bring RF down to linear time.

The comparison index and the serving index are therefore the *same bytes on disk*, rather than two
derived representations that have to be kept in step. That is a design result worth stating in its
own right, and it is what phylo.io builds and then throws away.

**Evidence.** Asserted directly by `test_subtree_is_a_contiguous_range` and
`test_leaf_count_equals_leaves_in_range`, which check the property against an independent
parent-chain walk on every node.

### 1.3 A hand-written parser, iterative rather than recursive

**Decision.** Newick is parsed in one pass, by hand, directly into flat arrays, using an explicit
stack.

**Alternatives considered.** `ete3` and `Bio.Phylo`. Recursive descent, which is the natural way to
write a grammar this small.

**Rationale.** Both libraries build a Python object per node, which is precisely the per-node cost
being designed out; `ete3` is additionally near-unmaintained. The parser is ~200 lines and removes a
heavy dependency from the ingest path.

Recursion is not merely inelegant here, it is **unsafe**: a recursive descent parser recurses once
per level of nesting, and these trees are pathologically unbalanced.

**Evidence.** Measured depths: vibrio UPGMA is **443** levels deep and clostridium UPGMA **604**,
where balanced trees of those sizes would be ~15 and ~15. `test_deep_tree_does_not_recurse` parses a
20,000-level caterpillar, which would exhaust the interpreter stack under recursion.

Parse times into columns, whole file: **81 ms** (vibrio UPGMA), **112 ms** (vibrio NJ), **132 ms**
(clostridium UPGMA) — for context, phylo.io takes 945 ms on the first of those.

### 1.4 Unary nodes are suppressed at ingest

**Decision.** Internal nodes with exactly one child are removed during ingestion, their branch
length added to their child's. The count is recorded in the tree's header as `suppressed_unary`.

**Alternatives considered.** Store the file's topology verbatim and tolerate unary nodes everywhere
downstream. Reject such files.

**Rationale.** *This was found in the data, not anticipated.* The store's contract to the rest of
the backend is a rooted binary tree — `n_nodes == 2 * n_leaves - 1` — and `vibrio-nj-tree.nwk` is
written as `(X);`, a root with a single child. A unary node is not cosmetic:

* It **duplicates a bipartition**. A node's cluster is the leaf set beneath it, and a unary node's
  cluster is identical to its only child's. RF is defined over the *set* of bipartitions, so a
  duplicate either inflates a naive count or silently collapses depending on the implementation —
  exactly the class of off-by-one that makes two RF implementations disagree by one and sends you
  looking in the wrong place.
* It **wastes a slice entry** and draws the user a branch point that is not one.

Suppression is the standard fix and preserves every root-to-leaf distance. Tolerating unary nodes
would mean defending against them in the metric, the summariser and the renderer instead of once at
the door. Rejecting the file would discard a real dataset over a formatting convention.

The consequence must be stated rather than assumed: the stored pre-order indices are **this store's
canonical form, not offsets into the source file**. Since node identity is defined as the pre-order
index *in this store* (§1.1), that is coherent — but it is why the header records it.

**Evidence.** Child-count census over all three trees: vibrio UPGMA `{2: 17,645}`, clostridium UPGMA
`{2: 27,961}`, vibrio NJ `{1: 1, 2: 17,644}` — one unary node, at pre-order index 0, the root. After
suppression all three satisfy `n = 2L − 1`, asserted at ingest by `assert_rooted_binary` and in
`test_real_trees_are_binary_and_rooted`.

### 1.5 Raw memory-mapped columns, not Parquet, HDF5 or a database

**Decision.** One directory per tree, one flat binary file per column (`parent.uint32`,
`subtree_end.uint32`, `depth.uint16`, `leaf_count.uint32`, `branch_len.float32`), plus a
length-prefixed label blob and a JSON header. Read with `np.memmap`.

**Alternatives considered.** Parquet; HDF5; SQLite or a relational store; JSON.

**Rationale.** The access pattern is fixed by §1.2: a *contiguous index range per column*. That is
the one thing a flat memory-mapped array does perfectly, with no dependency. Parquet's row groups
and compression both work against random range access. HDF5 adds a large native dependency for the
same result. A relational store would build an index over rows that are already addressed by
position. Memory mapping also means nothing is deserialised at startup and nothing is retained in
the process heap between requests — the kernel's page cache does the caching, shared across workers,
and a 200-node slice of a 56k-node tree pages in roughly 200 nodes' worth of each column.

The format is deliberately boring: a reader in any other language is an `mmap` and a dtype. That
matters for the requirement that metrics may be written in any language.

**Evidence.** Measured on the real trees: **24.7–24.8 bytes per node** (871 KB each for the two
vibrio trees, 1.32 MB for clostridium; the whole vibrio pair is 1.66 MB). Storage is not the
constraint — computation is. Asserted by
`test_storage_cost_per_node`.

### 1.6 Payloads are positional, never keyed

**Decision.** Parallel arrays in one agreed order. Topology and comparison values for the same slice
align index for index. No `{node_key: value}` objects anywhere on the wire.

**Alternatives considered.** Keyed JSON objects, which are self-describing and robust to
reordering.

**Rationale.** Alignment removes the key entirely, and runs of similar floats compress far better
than high-entropy hash strings. The robustness argument is weak here because the ordering is not
incidental — it is the pre-order index, which is the identity.

**Evidence.** Measured with real gzip on 17,645 values: **41 KB positional against 236 KB keyed**, a
**5.7×** reduction end to end.

### 1.7 Any two trees sharing labels may be compared; the server reports, it does not forbid

**Decision.** `/api/datasets` offers a pair whenever the two trees share at least one leaf label,
measured, regardless of species. Each pair carries the evidence for its own comparability:
`same_species`, `label_match`, `shared_leaves`, `shared_fraction`, and a `caution` string when the
matching is suspect. Only pairs with *no* shared label are omitted, because no clade-based metric is
defined without some correspondence between the leaves.

**Alternatives considered, and initially chosen.** Restrict pairs to a single species. The reasoning
was that sequence types are numbered per species, so a vibrio ST 11 and a clostridium ST 11 are
unrelated organisms, and matching them by label would produce a confident, plausible, meaningless
number.

**Why that was wrong.** The observation is right; the conclusion was not. Looking for similarity
across datasets is ordinary phylogenetic practice, and whether a given comparison is worth making is
a judgement for the person making it, not a policy for the server to enforce. Comparable tools
compare whatever two trees they are given. A tool that refuses is not safer, only less useful — and
the refusal would have been silent from the user's point of view, since the pair simply would not
have appeared.

What the original concern genuinely justifies is **disclosure, not prevention**: the server states
what it matched and on what basis, and the client can surface that.

**Evidence — the reason disclosure is enough.** Measured on the real trees:

| | shared labels | RF | shared clades | normalised RF |
|---|---|---|---|---|
| vibrio NJ vs vibrio UPGMA | 17,645 (100%) | 6,825 | 10,819 | 0.193 |
| clostridium vs vibrio | 17,490 (**99.1%**) | 17,487 | **2** | **0.500** |

The cross-species pair overlaps on 99.1% of labels and yields **two** shared clades out of 17,489 —
a normalised RF of 0.500, the maximum. The data makes the point more convincingly than a refusal
would have: coincidental label collision produces no shared structure, and that is visible in the
result. The caution explains *why* before the user has to work it out.

**Consequence for the frontend.** Both presentation modes the requirement asks for work on any pair:
branch colouring from the `similarity` gradient, and leaf colouring from `corresponds` — a leaf with
`NO_CORRESPONDENCE` exists in only this tree. Measured: 1 such leaf in the vibrio pair, 156 in the
cross-species pair.

**Still open:** a pair could also be made comparable by an explicit crosswalk between two label
spaces — the same isolates typed under different schemes, or at different HierCC levels, which the
isolate TSVs could supply through `Uberstrain`/`Barcode`. `label_match` exists to name that case
("identity" today) so the field does not have to be added later.

### 1.8 goeBURST files are out of scope

**Decision.** The catalogue matches `*-{upgma,nj}-tree.nwk` only. The three goeBURST files in
`datasets/gen_trees/` — including `salmonella-100k` — are not ingested.

**Rationale.** goeBURST produces minimum-spanning **forests**: multi-root, with data on internal
nodes. Neither the RF bipartition model nor the rooted-subtree slicing model applies. This is a
scope decision taken with the supervisor, recorded here so its absence is not read as an oversight.

### 1.9 Python 3.12, pinned

**Decision.** `requires-python = ">=3.12,<3.13"`, with the interpreter provisioned by `uv`.

**Rationale.** The machine's default is Python 3.14.6. Pinning removes wheel-availability risk from
the dependency set and makes the environment reproducible on the school server from
`pyproject.toml` + `uv.lock` alone.

### 1.10 Relationship to the reference algorithm (Branco, Vaz & Francisco, 2024)

The preparation of trees for the metric follows **Branco, A.P.; Vaz, C.; Francisco, A.P.,
"Computing RF Tree Distance over Succinct Representations", *Algorithms* 2024, 17, 15**
(doi:10.3390/a17010015), reference implementation at `pedroparedesbranco/TreeDiff`.

**Where this store is identical to the paper.** On every point that bears on correctness:

| Paper | Here |
|---|---|
| "each node is mapped to a unique index given by the tree pre-order traversal" (§3.1) | pre-order index is node identity (§1.1) |
| cluster `c(v) = L(T(v))`; all descendants lie between a node's opening and closing parenthesis (§3.1) | `[i, subtree_end[i])`, which is that span, decoded (§1.2) |
| `NumLeaves(bv, p)` (Table 1) | the `leaf_count` column |
| per-node weight vector for wRF (Def. 3, Alg. 1) | the `branch_len` column |
| `CodeMap`: an n-integer array, tree-1 index to tree-2 index, built from a temporary label hash table during parsing (§4.1, Alg. 1 ll. 26-29) | the correspondence map, milestone 2 — this design is adopted rather than reinvented |

**Decision.** Store the tree as **explicit fixed-width columns** rather than as the paper's succinct
balanced-parentheses bit vector.

**Alternatives considered.** The paper's representation: `2n + o(n)` bits per tree, with
`FindClose`, `Enclose`, `LCA`, `NumLeaves` and `ClusterSize` computed on demand in `O(log n)` via
SDSL (`bp_support_sada`).

**Rationale.** This is not a different model of the tree; it is the *materialised* form of the same
one. `subtree_end[i]` is precisely `PreOrderMap(FindClose(p))` and `leaf_count[i]` is `NumLeaves` —
the same quantities, computed once at ingest instead of per call. The cost is ~200 bits per node
against ~2; the gain is `O(1)` instead of `O(log n)` on every lookup.

The paper identifies this exact axis as its own trade-off: *"expected trade-offs on running time
overhead versus space requirements due to the use of succinct data structures."* It optimises for
space, because its object is computing distances over very large trees within a memory budget. This
store has a **second obligation the paper's does not**: serving arbitrary subtree slices to a browser
on request. A contiguous memory-mapped range serves that as a memcpy, whereas a bit vector requires
`O(log n)` primitive operations per node *on the request path* — the one place in this system where
they cannot be afforded, because the request path is what the thesis measures.

The paper's motivating constraint also does not bind at present scale: the whole vibrio pair is
1.66 MB stored (§1.5). It would bind at 500k+ nodes, which is why the succinct representation is
**deferred rather than rejected**. Because the columns are exactly the outputs of the paper's
operations, substituting sdsl-lite later is contained behind `TreeReader` and changes no caller.
(sdsl-lite is C++-only, so that step is also the natural occasion for the native core.)

**Evidence — and a correction this reading produced.** The paper's Algorithm 2 (l. 29) computes

    distance = (numInternalNodes1 + numInternalNodes2 - 2 x equalClusters) / 2

using the **internal-node count as a proxy for the number of non-singleton clusters**. That
substitution is valid only if no two nodes of a tree share a cluster — which is exactly what a unary
node violates, its cluster being identical to its only child's. Had `vibrio-nj` been stored verbatim
(§1.4), this algorithm would have read 17,645 clusters where there are 17,644 distinct ones, and the
RF distance would have been wrong by one with nothing in the output to indicate why. The
canonicalisation in §1.4 is therefore a **precondition of the reference algorithm**, not a tidying
step.

**Two conformance details recorded for milestone 2**, both from §3.3 and Algorithm 2, and both
places where implementations silently differ from one another:

* **Singleton clusters are not counted** — "since they occur in both trees".
* **The result is divided by two**, consistent with the paper's note that "most software
  implementations usually divide the RF distance by 2".

A third point constrains milestone 2 directly: the method assumes a **bijection** between the two
label sets (§3.3 builds a permutation between them). The vibrio pair does not have one — see
*Findings carried forward* — so the reconciliation has to be explicit and reported.


## 2. Validating the reference implementation

*Feasibility gate before adopting the paper's succinct representation. Code:
`native/build_treediff.sh`.*

### 2.1 Decision: adopt the succinct representation, with the columnar store as its reference

**Decision.** Move to the paper's balanced-parentheses representation for the stored topology.
Retain the columnar implementation as the reference against which the succinct one is validated.

**Alternatives considered.** Keep the columnar store indefinitely. Adopt the succinct store
immediately and drop the columnar one.

**Rationale.** Three arguments, of which only the first was obvious at the outset:

1. **Space.** Like-for-like — both serving leaf labels and branch weights — the succinct store is
   ~6.3 B/node against ~24.7 B/node, about **4x**. (The headline 11x against the paper's 2.2 B/node
   is not a fair comparison: the paper's tool stores a *permutation between two trees* and never
   serves a label to anyone, because it prints a number and exits.) This matters for an eventual
   PHYLOViZ merge: at 100 trees of 1M nodes it is 2.36 GB against 210 MB.
2. **The native core is already a hard requirement**, not additional scope. A faster language
   called from Python was a stated constraint from the start. Pointing that work at a
   representation the supervisors published, with a reference implementation that already exists,
   satisfies the constraint and the space concern with one piece of work instead of two.
3. **An earlier argument of mine against it did not survive checking** and is withdrawn: I claimed
   `O(log n)` primitives could not be afforded on the request path. A slice is budget-bounded at
   ~500 nodes; at `log2(1M) ~ 20` that is ~10,000 primitive operations for an entire slice, tens of
   microseconds against a 50 ms budget. The `O(1)` columns buy nothing a user could perceive and do
   not justify 4x the space.

**Sequencing.** Correctness first, representation second. The columnar implementation is easy to
inspect and becomes the oracle for the succinct one; swapping both the representation and the metric
at once would leave a wrong answer with two candidate causes. The by-product is a thesis result
rather than duplicated effort: two representations of the same trees, computing the same distances
on real data, measured — which replicates the paper's own reported trade-off on a dataset it did not
use.

### 2.2 The reference implementation does not build unmodified, and five fixes are needed

**Evidence.** `TreeDiff` and `sdsl-lite` on macOS 27 / arm64, CMake 4.4.3, Apple clang 21:

| # | Failure | Cause | Fix |
|---|---|---|---|
| 1 | CMake refuses to configure sdsl | `cmake_minimum_required(VERSION 2.8.7)`; CMake 4.x removed < 3.5 compatibility | `CMAKE_POLICY_VERSION_MINIMUM=3.5` |
| 2 | `fatal error: 'process.h' file not found` | sdsl tests for `"Clang"`, but Apple's compiler id is `"AppleClang"` and the default path `/usr/bin/c++` does not match `.*clang.*` either, so it falls through to the **MSVC** branch and includes a Windows header | `CXX=/usr/bin/clang++` |
| 3 | `no member named 'm_select1'` | An upstream typo in `louds_tree.hpp`: `tree.m_select1` should be `tree.m_bv_select1`. Unnoticed since 2015 because `swap` was never instantiated | patch the two lines |
| 4 | link failure | `-static` in TreeDiff's Makefile; macOS ships no static libc | clang flags from TreeDiff's own README |
| 5 | wRF wrong at scale | see §2.3 | rebuild with `double` |

All five are captured in `native/build_treediff.sh`, which ends by reproducing the paper's
documented example (RF = 1, exclusive clusters 3 and 7) exactly. **This is a maintenance cost that
an eventual PHYLOViZ merge inherits**, and it belongs in the space/complexity trade-off rather than
being discovered later.

### 2.3 wRF loses precision in float32 on real branch lengths

**Evidence.** Comparing a tree with **itself**, where the answer must be 0:

| Tree | `float` (as shipped) | `double` |
|---|---|---|
| vibrio-upgma | **-28.4947** | 1.95e-08 |
| clostridium-upgma | **-11.5768** | -2.75e-09 |

The weighted variants accumulate in `float`, and compute wRF by summing every weight in both trees
and then correcting downward per shared cluster (paper §3.4). On vibrio UPGMA the running total is
**4.78e6** while each correction is of order 1, so the cancellation falls below float32 resolution
(spacing 0.5 at that magnitude). Small trees are unaffected, which is why it does not show up in the
paper's examples: this is a property of **UPGMA branch lengths**, which are cumulative distances
summing into the millions, not of the algorithm.

A negative distance is the useful signal here — it is impossible by definition, so the defect
announces itself provided anyone compares a tree with itself. That check is now a test.

*Correction to my own process:* the first attempt to test this appeared to disprove it, because the
`sed` used `\b`, which BSD sed does not support, so the "double" binary was a byte-identical copy of
the float one. The hypothesis was right; the experiment was broken. Recorded because an experiment
that silently does nothing is the failure mode most likely to recur.

### 2.4 Canonicalisation is a precondition of the reference implementation, and it crashes without it

**Evidence.** `vibrio-nj-tree.nwk` compared with **itself**:

* as shipped (unary root): `Assertion failed: (i > 0 and i <= m_arg_cnt), select_support_mcl.hpp:349`
* after §1.4 canonicalisation: `-4.80e-09`, i.e. zero

This is a stronger result than §1.4 anticipated. The unary root was justified there on the grounds
that it duplicates a bipartition and would miscount. In the reference implementation it does not
miscount — it **aborts**. The canonicalisation is load-bearing, not tidying.

### 2.5 The `rf_day` baseline is unreliable at scale

**Evidence.** Comparing trees with themselves, where the answer must be 0:

| Input | `rf_day` |
|---|---|
| `tree_examples/treeA` vs itself (7 nodes) | 0 |
| vibrio-nj as shipped vs itself | **207** |
| vibrio-nj canonicalised vs itself | **350** |
| vibrio-upgma vs itself | **11,831** |

`rf_day` is the paper's *baseline for comparison*, not its contribution — the contributions,
`rf_postorder` and `rf_nextsibling`, are correct on all these inputs. But it means `rf_day` cannot
be used as an oracle, and any timing comparison against it is comparing against something that does
not compute the right answer. Noted alongside the `phylodiff` defect in *Corrections*: three of the
five RF implementations examined for this project are wrong on real input.

### 2.6 The conformance target for milestone 2

**Evidence.** vibrio UPGMA vs NJ, restricted to the 17,645 shared leaves (ST 211 is absent from the
NJ tree, §*Findings carried forward*), unary nodes suppressed in both:

* **RF = 6,825**, agreed by `rf_postorder` and `rf_nextsibling` independently
* both self-comparison controls return **0**
* computed in **32 ms**
* wRF on the same pair = **1.2304e6**
* `info` reports **6,825 exclusive clusters in each tree**, as **pre-order indexes** in `[0, 35289)`

That last point matters beyond conformance: the reference implementation already emits per-clade
differences keyed by pre-order index — the identity convention adopted in §1.1, arrived at
independently. The membership half of the per-clade output required by this project is therefore
directly available from it, and only the Jaccard gradient has to be added.

**TreeDiff's pre-order indexes are 1-based; this store's are 0-based.** Verified against the
paper's own documented example: it reports treeA cluster `{A,B}` as index 3 where this store has it
at 2, and treeB `{A,C}` as 7 where this store has 6. Every index crossing that boundary needs the
offset. It is recorded because it is exactly the kind of off-by-one that produces a plausible but
wrong picture rather than an error — it first appeared here as a clade-size histogram in which a
third of the "differing clades" were leaves, which is impossible, since RF judges only internal
nodes. The assertion `all exclusive indexes are internal nodes` is kept as the guard.

### 2.7 RF is binary per clade, which is why Jaccard is a requirement and not a refinement

**Evidence.** RF's verdict on a clade is *present* or *absent* — there is no degree. On the vibrio
pair (17,645 shared leaves, 17,644 judgeable clades per tree):

| | |
|---|---|
| clades RF calls identical | 10,819 (61.3%) |
| clades RF calls different | 6,825 (38.7%) |

and the clades it calls different span the entire size range:

| clade size (leaves) | count |
|---|---|
| 2 | 733 |
| 3–4 | 886 |
| 5–10 | 1,255 |
| 11–100 | 2,456 |
| 101–1,000 | 1,096 |
| 1,001–8,600 | 399 |

A clade of **8,600 leaves** receives the same verdict as a clade of **2**: "not present in the other
tree". RF cannot express that the first may be 99% preserved while the second shares nothing. The
mechanism is visible on a 10-leaf example: swapping a single leaf between two clades marks **four**
clades different, because one misplaced leaf invalidates every ancestor on its path to the root,
regardless of how much of each ancestor's membership survives.

**Consequence for the design.** The two required per-clade outputs are not two views of one
computation; they answer different questions and neither substitutes for the other:

* **membership** (from RF) — *is this clade exactly preserved?* Binary, exact, standard, citable,
  and already emitted by the reference implementation.
* **Jaccard gradient** (to be built) — *how much of this clade survives, and where did it go?* For
  each clade, its best corresponding node in the other tree and the continuous overlap
  `|A ∩ B| / |A ∪ B|`.

The gradient is what a colour scale can render, and it is the only one of the two that distinguishes
a near-miss from a total rearrangement. It is not part of the paper, so it is ours to implement and
validate; RF remains the citable headline distance and the exact-match layer beneath it.

*Also available, not yet used:* TreeDiff ships a **Triplets** metric (`trip_treediff`, `trip_sht`),
which is inherently more granular than RF because it scores agreement over leaf triples rather than
whole clades. Both binaries build and are a candidate second entry in the metric registry.


### 2.8 What is presented: a graded dissimilarity, not RF's difference set

**Decision.** The per-clade visual encoding is a **continuous** dissimilarity,
`1 - Jaccard(clade, best corresponding node)`. RF supplies the headline distance and an exact-match
overlay, but is not the colour scale.

**Alternatives considered.** Colour clades directly by RF membership — the literal inverse of a
consensus tree, showing what the two trees do *not* agree on. This is the obvious reading of the
requirement and it is what RF's `info` output hands you ready-made.

**Rationale.** It fails empirically, for the reason established in §2.7. Measured on the vibrio
pair, the proportion of clades RF calls "different", by clade size:

| clade size (leaves) | total | different | % |
|---|---|---|---|
| 2 | 4,691 | 733 | 15.6% |
| 3-4 | 3,769 | 886 | 23.5% |
| 5-10 | 3,682 | 1,255 | 34.1% |
| 11-100 | 3,897 | 2,456 | 63.0% |
| 101-1,000 | 1,199 | 1,096 | **91.4%** |
| 1,001-8,600 | 406 | 399 | **98.3%** |

RF's difference set **saturates precisely where discrimination is needed**. Nearly every large clade
is "different", because a single misplaced leaf invalidates every ancestor on its path and large
clades accumulate the disagreements of everything beneath them. A user opening the comparison
zoomed out sees the whole upper tree flagged, which is indistinguishable from no information. The
binary encoding is at its least informative exactly at the scale the thesis is about.

A graded measure still separates a clade that is 99% intact from one that shares nothing, in the
range where RF has gone flat.

**The delivered per-clade payload**, positional and aligned to the slice (§1.6):

| field | type | use |
|---|---|---|
| `jaccard` | f32 | the colour gradient - how much of this clade survives |
| `corresponds` | u32 | pre-order index of the counterpart in the other tree - click-to-jump and side-by-side linking |
| `exact` | bit | RF's verdict - an overlay/filter, "show only exactly preserved clades" |

plus RF itself (6,825, and normalised) as the citable summary statistic. This mirrors phylo.io's
best-corresponding-node plus Jaccard colouring, so the presentation model is established practice
rather than invention; what differs is that it is computed once offline and delivered sliced (§1.1).

**A consequence worth stating, with its limit.** The RF traversal already computes, for each clade
`A` of tree 1, the LCA in tree 2 of `A`'s taxa and that node's leaf count (paper §3.3, Alg. 2).
Because the LCA's cluster `B` contains all of `A`'s leaves, `A` is a subset of `B`, so
`Jaccard(A,B) = |A| / |B|` - the same two numbers RF compares for equality, divided instead of
compared. A gradient is therefore almost free from the same pass.

**But the LCA is not in general the best corresponding node.** If `A = {1,2}` and the LCA in tree 2
is a 100-leaf clade, `|A|/|B| = 0.02`, while a descendant `{1,2,3}` scores 0.67. So `|A|/|B|` is a
**lower bound** on best-match similarity, and using it unqualified would systematically overstate
how much has changed - the very error this section exists to avoid. True BCN requires a search below
the LCA.

**Settled in milestone 2 by measurement — see §3.3.** Both were implemented and compared on the
vibrio pair. The gap is material (653 clades where the cheap estimate says < 0.1 and the true best
match says > 0.5), so the search is shipped and the LCA ratio is retained only for comparison.

## 3. The metric: Robinson-Foulds and the similarity gradient

*Milestone 2. Code: `metrics/`, `trees/reconcile.py`, `precompute/pipeline.py`.*

**Gate met.** RF on the vibrio pair = **6,825**, shared clades = **10,819**, matching the reference
implementation exactly (§2.6). Self-comparison of a real tree returns 0. 59 tests pass.

### 3.1 Reconciliation is explicit, reported, and refuses rather than guesses

**Decision.** Before any comparison, both trees are restricted to their shared leaf labels, the
result is re-canonicalised, and the dropped labels are recorded in the stored comparison's notes.
A pair with no shared labels is refused.

**Rationale.** RF is defined only over a common leaf set, and the vibrio pair does not have one -
`vibrio-nj` lacks ST 211. Handed the files unreconciled, the reference implementation neither warns
nor skips: it indexes past the end of its label mapping and aborts (§2.4). Silent partial
reconciliation would be worse still, so the choice is between failing loudly and reporting
explicitly; this reports.

Pruning a leaf leaves its parent unary, so §1.4's canonicalisation runs again afterwards - the
invariant is re-established, not assumed.

**Evidence.** `dropped_from_right: ["211"]`, 17,645 shared leaves, in the stored pair's metadata.

### 3.2 Two independent mechanisms, cross-checked on every run

**Decision.** The shared-clade count is computed twice by different means, and the metric raises if
they disagree.

* **LCA test** - a left clade is present in the right tree iff the smallest right clade containing
  all its taxa has exactly as many leaves. This is the reference implementation's formulation
  (paper §3.3), and it also yields the corresponding node.
* **Day's interval test** - a left clade is present iff its taxa occupy a *contiguous* run of the
  right tree's leaf order and that exact run is one of the right tree's clades. No LCA at all.

**Rationale.** Three of the five RF implementations examined for this project return wrong answers
on real input (§2.5, and `phylodiff` in *Corrections*). All three were wrong *silently* - they
produce a plausible number. An assertion between two mechanisms that share no machinery is cheap
insurance against joining them. Left/right symmetry of the shared count is asserted for the same
reason.

**Evidence.** Both agree at 10,819 on the vibrio pair; neither assertion has fired.

### 3.3 The similarity gradient uses a true best-match search, not the free LCA ratio

**Decision.** Per-clade similarity is Jaccard overlap against the **best** corresponding clade in
the other tree, found by search. The free LCA ratio `|A|/|B|` is retained behind a flag for
comparison, not shipped.

**Alternatives considered.** The LCA ratio, which §2.8 established comes free from the same pass the
RF test needs, and which is a *lower bound* on best-match similarity.

**Rationale.** §2.8 left this open deliberately, to be settled by measurement rather than by
assumption. Measured on the vibrio pair, over 17,644 clades:

| | LCA ratio | best match |
|---|---|---|
| mean similarity | 0.7860 | 0.8618 |
| median | 1.0000 | 1.0000 |

| gap between them | clades | share |
|---|---|---|
| any difference | 4,171 | 23.6% |
| more than 0.10 | 3,330 | 18.9% |
| more than 0.25 | 2,228 | 12.6% |
| **LCA says < 0.1 where best match says > 0.5** | **653** | 3.7% |

The last row is the decisive one: on 653 clades the cheap estimate would render a *more than half
preserved* clade as almost entirely lost. That is the same class of error §2.8 exists to avoid -
misrepresenting how much changed - so the cheap version fails on its own terms.

The cost of being right is **12.6 s** for the whole pair, against 0.15 s. Both are negligible for
work done once, offline, and neither is on the request path. RF itself and the exact-match verdict
are identical under both, exactly as the theory predicts, which is itself a useful check.

**Provenance.** The measure itself — best corresponding node by maximum Jaccard overlap — is
**adopted from Phylo.io** (`worker_bcn.js`), not original here; see *References and provenance*.
What differs is that Phylo.io approximates the candidate set with MinHash/LSH in the browser, while
this is exact and computed offline.

**Implementation.** For a clade `A` and a candidate `C`, `|A n C|` is the count of A's taxa falling
in C's contiguous leaf range - two binary searches. Evaluating every candidate at once with numpy
makes it `O(n log a)` per clade instead of the `O(n * a)` a naive set intersection would cost.

### 3.4 Values are projected back onto the stored trees before they are stored

**Decision.** A comparison is computed against reconciled trees, then projected back onto the
*stored* trees' pre-order indexing before being written. Nodes with no counterpart are written as
NaN similarity and `NO_CORRESPONDENCE`, never left at a default.

**Rationale.** The API serves stored trees under stored node ids. Dropping one leaf from a
17,646-leaf tree shifts every index after it, so values computed on the reconciled tree are offset
against the tree they describe. The failure mode is the dangerous one: every array is individually
well-formed and the picture merely attaches the wrong values to the wrong clades. `corresponds`
needs translating too, since it points into the *other* tree's reconciled indexing.

Marking absent values explicitly matters for the same reason - a leaf present in only one tree is a
real thing to show the user, greyed, rather than something to hide or to fake a value for.

**Evidence.** On the stored vibrio pair: exactly **two** right-tree nodes carry no value - ST 211 and
the internal node it leaves unary - and **zero** of 17,645 leaves point at a counterpart carrying a
different label. That last assertion is a permanent test; it fails under any index shift.

### 3.5 The metric contract is data, not a Python type

**Decision.** A metric is a directory with a `metric.json` manifest plus an implementation. Two
invocation kinds are defined: `python` (imported in-process) and `subprocess` (trees in, results
out, as JSON on stdio). Every metric returns the same shape, so neither the API nor the frontend
knows which produced a result.

**Rationale.** "Metrics addable in any language" was a stated requirement. Defining the contract in
terms of a manifest and a data shape rather than a Python base class is what makes that true rather
than aspirational: a C++ binary or an R script satisfies it with no Python at all. The columnar
store supports the same goal - a reader in another language is an mmap and a dtype (§1.5).

The `subprocess` kind is defined and documented but deliberately not yet wired up; `load()` raises a
message saying so. Declaring a contract costs little, and pretending to implement one costs a lot.

**Capabilities are declared, not probed.** The manifest states `per_clade`, `symmetric`, `weighted`,
`requires_shared_leaf_set`, and `/api/metrics` passes them through, so the frontend can enable or
grey out controls without trial calls.

### 3.6 Comparison storage

9 bytes per node per side - 4 similarity (f32) + 4 corresponds (u32) + 1 exact (u8) - in the same
flat-column, memory-mapped form as the tree store, indexed by the same pre-order position. A slice
of a comparison is therefore the *same contiguous range* as the slice of topology it accompanies,
which is what lets the two be read and shipped together, aligned index for index (§1.6).

**Measured:** the whole vibrio pair, both sides, is **621 KB**.

## 4. Slicing: what the client actually receives

*Milestone 3. Code: `trees/summarise.py`, `api/routes_trees.py`.*

**Gate met.** A 500-tip slice of the 17,646-leaf vibrio tree is served in **6.6 ms** (target: under
50 ms). 95 tests pass.

### 4.1 Summarisation runs on the server, not the client

**Decision.** `GET /api/trees/{id}/slice?root=&budget=` returns a subtree already reduced to a leaf
budget. The client asks for what it can afford to draw and receives only that.

**Rationale.** The rendering library already reduces a tree to a budget in the browser
(`prepareTree`), so the rule is not new — what is new is applying it *one step earlier*. Nodes the
client would have discarded after downloading and parsing them are never sent. That is the whole
client-side argument in one sentence: not "draw fewer nodes" but "never receive them".

**Evidence.** Payload and latency against the source file phylo.io loads in full:

| budget | tips | nodes | JSON | gzipped | latency |
|---|---|---|---|---|---|
| 10 | 10 | 19 | 1 KB | <1 KB | 1.4 ms |
| 50 | 50 | 99 | 4 KB | 2 KB | 1.7 ms |
| 200 | 200 | 399 | 15 KB | 5 KB | 3.5 ms |
| 500 | 500 | 999 | 36 KB | 12 KB | 6.6 ms |
| 2,000 | 2,000 | 3,999 | 142 KB | 42 KB | 21.6 ms |
| **whole tree** | 17,646 | 35,291 | **534 KB** | 193 KB | — |

A 500-tip slice is **15x smaller** than the source file and still represents all 17,646 leaves — 500
individually, the rest behind wedges. Latency scales with the budget, not with the tree: the cost of
a slice is the size of the answer, because the interval encoding makes finding it free (§1.2).

### 4.2 Conservation: a slice defers detail, it never discards it

**Decision.** Every leaf of the requested subtree is either displayed or counted inside exactly one
wedge. A tip standing for an unexpanded clade carries `true_leaf_count`, the clade's size in the
**full** tree.

**Rationale.** This is the property that makes navigation possible at all. If a slice could drop
clades silently, the user would have no way to know something was there, and no id to ask for it
with. Because it cannot, expanding a wedge is just another slice rooted at that wedge's id — the
navigation loop closes with no extra machinery.

It also gives the strongest available test. `displayed_leaves - wedges + hidden_leaves ==
total_leaves` is checked at every budget on both real trees and on constructed ones; any
apportionment bug breaks it immediately.

**Evidence.** Holds at budgets 1, 2, 7, 25, 100, 500 on vibrio (17,646) and clostridium (27,962),
and on a 5,000-level caterpillar.

### 4.3 Two deliberate divergences from the library's `prepareTree`

The *selection priority* is the library's, unchanged: visit the largest subtree first, so a tight
budget spends its detail on the most prominent clades. Two things had to change because a slice
crosses a wire.

**An unexpanded clade is emitted as a wedge, not descended into.** The library, given a budget of
one for a clade, descends and returns a single arbitrary leaf. It can afford to: its pruned clone
keeps an `origin` pointer back to the real subtree, so the wedge is still drawn at the true size
(`clade_shape.ts:161`). Across a wire there is no pointer. A tip that is really 8,441 leaves has to
say so, or the client cannot size the wedge or know there is anything to navigate into.
`true_leaf_count` is that pointer's wire encoding — and this is the `trueLeafCount` change the plan
anticipated, arriving where it was actually needed.

**Budget is reserved so that no sibling vanishes.** Taken literally, the library's apportionment
lets the largest child consume everything. *Measured*: at a budget of 500 on the vibrio tree it
descends into one corner, returns 500 real leaves — and the other **17,146 disappear without
trace**, with 0 wedges emitted. That is a sound safety net in the browser, where `prepareTree` is
handed a tree that user collapse state has already reduced and the budget rarely binds. It is the
wrong rule for the first thing a user sees. Holding back one unit per remaining sibling makes every
clade appear, expanded if it fits and as a wedge if it does not.

This was caught by the conservation check above, not by reading the code — the first implementation
was a faithful port and reported `accounted 500/17,646`.

### 4.4 Slices carry stored ids, and parents are local

**Decision.** `nodes.id` is the pre-order index in the **stored** tree. `nodes.parent` is an index
into the returned arrays (-1 at the slice root), not a stored id.

**Rationale.** The two do different jobs. `id` is the join key — it addresses comparison values
(§3.4), metadata, and the next slice request, and it is the same number across all of them. `parent`
exists only to rebuild the nesting the client draws, so a local index is smaller and needs no lookup
table. Conflating them would force the client to build a map before it could draw anything.

`parent[k] < k` holds by construction, since the flatten is pre-order — asserted in tests, and it
lets a client build the tree in one forward pass.

### 4.5 Iterative, not recursive

The library recurses, which is safe in a browser because it recurses over an already-pruned tree.
The server summarises the **real** tree, which is 604 levels deep, and a budget-driven descent down
a caterpillar spine is bounded by the budget rather than by depth. The summariser is therefore a
stack machine. Tested against a 5,000-level caterpillar, which the recursive form cannot survive.

### 4.6 A budget ceiling, as a guard rail

`budget` is capped at 50,000 tips and rejected below 1 (HTTP 422). The cap is not a recommendation —
a client drawing that many tips is already past the point slicing exists to avoid — but it stops a
single request from materialising an entire 500k-leaf tree in memory.

## 5. Serving comparisons

*Milestone 4. Code: `api/routes_comparisons.py`, `metrics/registry_pairs.py`.*

**Gate met.** Comparison values arrive in the same order as the topology they describe, index for
index, verified at budgets 5, 50 and 300. 110 tests pass.

### 5.1 Values are gathered, never recomputed

Comparison values are stored indexed by stored-tree pre-order position (§3.4, §3.6) — the same index
a slice reports in `nodes.id`. Serving values for a slice is therefore a gather at those positions:
no search, no join, no recomputation, and no per-request state. This is what the shared index buys,
and it is why the two halves of the store had to agree on node identity from the start (§1.1).

**Evidence**, topology and values together for vibrio-nj (17,645 leaves):

| budget | nodes | topology | + values | gzipped | latency |
|---|---|---|---|---|---|
| 50 | 99 | 4 KB | 7 KB | 3 KB | 2.1 ms |
| 200 | 399 | 16 KB | 27 KB | 9 KB | 3.7 ms |
| 500 | 999 | 41 KB | 65 KB | 21 KB | 6.9 ms |
| 2,000 | 3,999 | 167 KB | 256 KB | 78 KB | 26.1 ms |

Against the alternative of shipping what is needed to compute this client-side — the 776 KB tree
file plus the 621 KB stored comparison, 1,397 KB — a 500-tip slice **with** its comparison values is
**65 KB in one request, 22x less**. Adding values costs ~60% more bytes and almost no time.

### 5.2 One round trip by default, two when they help

**Decision.** `GET /api/trees/{id}/slice?compare={pair}` returns topology and values together.
`GET /api/comparisons/{pair}/slice` returns values alone.

**Rationale.** The combined form is the normal path: two panels would otherwise need four requests
per navigation step instead of two, and the values are built from the very `id` array the same
response carries, so they are aligned *by construction* rather than by agreement. The separate
endpoint earns its place for the case where the client already holds the topology and only wants to
switch metric — refetching topology to change a colour scale would be wasteful.

**Alignment is verifiable, not assumed.** The standalone endpoint re-runs summarisation, which is
deterministic, so it reproduces the same nodes in the same order. Rather than rely on that, it
returns `nodes.id` too: a client can check, or join by id if it prefers. Determinism is asserted in
its own test; this is the belt to that braces.

### 5.3 A pair is addressed by tree id, not by "left" and "right"

`?tree=vibrio-nj` rather than `?side=left`. The client is already working in tree ids — that is what
`/api/datasets` and the slice endpoints speak — and making it track which tree is nominally "left"
is an invitation to silently fetch the wrong side. Passing a tree that is not in the pair is a 400
naming both members, rather than a plausible answer about the wrong tree.

### 5.4 Absent values are `null`, in both senses

**Decision.** A node with no counterpart is served with `similarity: null` and `corresponds: null`.

**Rationale.** Two representations had to be translated at the wire boundary, and both would have
failed quietly:

* **NaN** — JSON has no NaN. Emitting one produces a document that many strict parsers reject, and
  that `JSON.parse` accepts in no browser. A test asserts the bytes contain no `NaN` and parse
  under a strict loader.
* **`0xFFFFFFFF`** — the in-store sentinel for "no correspondence" would arrive looking like a
  perfectly valid node id, four billion nodes into a tree with 35,291.

The distinction is visible to the user and worth preserving: a leaf with `corresponds: null` exists
in only one of the two trees. That is exactly what an equal/different leaf colouring keys off, and
ST 211 is the live case — served, drawn, and marked, rather than hidden.

### 5.5 What the frontend has, and what it can draw

Per node in a slice, aligned by position:

| field | drives |
|---|---|
| `similarity` 0..1, or null | the **branch colour gradient** — how much of this clade survives |
| `corresponds`, or null | **click-to-jump** to the counterpart; and for leaves, **equal/different colouring** |
| `exact` | the RF verdict — an overlay or filter, not a gradient (§2.7) |
| `true_leaf_count` | wedge size, and how much is hidden behind it |
| `truncated` | which tips can be expanded, by slicing at their `id` |

Both presentation modes the requirement named are served from one response.

### 5.6 A note on what the gradient shows that RF cannot

Visible in the first slice served. The top of the vibrio-nj tree is a caterpillar: the root's larger
child holds 17,644 of 17,645 leaves, the next 17,643, and so on. Each of those clades scores
`similarity` 0.9999 — essentially perfectly preserved — while `exact` is **false** for every one of
them, because a single leaf differs. Thirteen clades in the left tree score above 0.999 without
being identical.

This is §2.7 in miniature, on the very first screen a user would see: RF alone would paint the
entire visible backbone as "different", and the gradient is what distinguishes *99.99% preserved*
from *actually changed*.

## 6. Navigation order: where the budget spends its detail

*Code: `trees/summarise.py:divergence_priority`, `api/slicing.py`.*

### 6.1 Summarisation order is a parameter, because ordering is a backend capability

**Decision.** `?order=size|difference` on both slice endpoints. `size` expands the largest clades
first (the overview); `difference` descends towards the worst disagreement beneath each branch.

**Rationale.** The backend decides *which nodes exist* in a response — that is forced by the thesis
claim, since reduction has to precede transmission (§4.1). Ordering is the same decision: a client
cannot reorder by values it has not been sent. For a comparison tool "which clades are biggest" is
often the wrong question; "where do these trees actually disagree" is the one the user opened the
tool to ask, and only the server can answer it, because only the server holds the comparison values
at summarisation time.

This is the one place where presentation policy and the backend genuinely meet. The line held
elsewhere: the API contains no colour, scale, size or style anywhere — `similarity` is a
measurement, `corresponds` is a node id, `exact` is a verdict. What the backend owns is *what data
exists*; what it looks like remains entirely the frontend's.

**Evidence.** At a budget of 100 tips on the vibrio pair:

| order | worst similarity on screen | most-changed clades shown |
|---|---|---|
| `size` | 0.233 | 0.23 (43 leaves), 0.24 (122), 0.31 (35) |
| `difference` | **0.039** | **0.04 (51), 0.04 (47), 0.04 (45)** |

### 6.2 Choosing the divergence measure — three implemented, two rejected

**Decision.** `difference` ranks a node by `max(1 - similarity)` over its subtree: the worst
disagreement anywhere beneath it.

**Rationale and evidence.** Scored by how many of the 50 most-diverged substantial clades
(at least 20 leaves, similarity 0.04–0.23) a slice actually contains:

| priority | budget 100 | budget 200 | budget 500 |
|---|---|---|---|
| `size` (the default) | 2% | 22% | 22% |
| sum of `1 - similarity` | 2% | 22% | 22% |
| mean of `1 - similarity` | 0% | 14% | 24% |
| **max of `1 - similarity`** | **14%** | **24%** | **24%** |

* **Sum was implemented first and was wrong.** It scales with the number of nodes underneath, so it
  re-derives subtree size — rank correlation with size 0.57, and slices indistinguishable from
  `size`. This is the identical trap that §2.7's saturation sets for counting non-exact clades, and
  it was walked into anyway after being predicted; the measurement caught it, the reasoning did not.
* **Mean dilutes.** One badly diverged clade inside a large, otherwise well-matched subtree is
  averaged away and the descent never finds it — at a budget of 100 it found *nothing*.
* **Max is the natural heuristic for a greedy descent**: "the best thing reachable below here". It
  separates from `size` exactly where it matters, at tight budgets — seven times the recall at 100
  tips — and converges as the budget grows, because a generous budget reaches most things whatever
  order it visits them in.

**A methodological note worth keeping.** The first evaluation used *mean similarity of displayed
tips* and ranked `max` as the **worst** option. That measure is invalid: a matched leaf always
scores 1.0, so expanding anything at all drives the mean towards 1 and the metric rewards *not*
finding differences. Recall against a fixed target set has no such degenerate optimum. An evaluation
metric can be wrong in the same way an implementation can, and it is harder to notice because it
still produces a confident ranking.

### 6.3 Ordering changes where detail goes, and nothing else

The budget is still spent in leaves, every child still receives at least a wedge, and the
conservation invariant (§4.2) is asserted under both orderings. Priority decides *which* clades get
expanded; it cannot cause a leaf to be lost. Both slice endpoints take the same parameter and are
tested to agree node for node under `difference`, so the alignment gate (§5) holds for every
ordering rather than only the default.

## 7. Isolate metadata

*Milestone 5. Code: `isolates/`, `api/routes_isolates.py`.*

**Gate met.** Filtered compositions agree with a naive scan of the original TSV across six filter
combinations, including two-key AND queries. 147 tests pass.

### 7.1 The dominant payload, and what it costs served

Metadata, not topology, is the largest thing this backend holds: **8.4 MB** (vibrio) and **11.7 MB**
(clostridium) of TSV against 1.3 MB for both vibrio trees. Ingested it becomes **1.4 MB** and
**2.0 MB** — 6.1x and 5.7x smaller — and a request for a slice's worth of leaves returns **25 KB**.

| stage | vibrio |
|---|---|
| source TSV | 8.4 MB |
| dictionary-encoded store | 1.4 MB |
| served, per 500-tip slice | **25 KB** (2.1 KB gzipped), 3.0 ms |

That is **344x less** than loading the file, which is what the client-side claim rests on for
metadata just as §4.1 does for topology.

### 7.2 Joint tuples, not per-key counts

**Decision.** Isolates are stored as rows of dictionary-encoded columns: the row stays intact.

**Rationale.** Marginal counts cannot answer an AND query. Knowing that 254 isolates are Bangladeshi
and 30 are human-source says nothing about how many are both, and "Bangladesh or India, **and**
human source" is precisely the query a filter UI generates. Precomputed per-key histograms would be
smaller and would answer the wrong question.

**Evidence.** The gate is a naive TSV scan, run over six filter combinations including
`{Country: [Bangladesh, India], Source Niche: [Human]}` — a query no set of marginals could produce.

### 7.3 Rows are sorted by sequence type and indexed by range

The same move as the interval encoding (§1.2): sorting rows by ST makes one leaf's isolates a
contiguous run, so gathering a slice's worth of leaves is a handful of range reads rather than a
scan of 38,597 rows. The join is one-to-many — up to **312 isolates share one ST** in vibrio.

**Sequence types are strings, not integers.** The exports contain `NaN`, `-2`, `-3`, `-14`, `-15`
and `-18` where none was assigned. Parsing to integers would have thrown on ingest or, worse,
silently coerced. The index is a dictionary keyed by the label exactly as the tree carries it, so
matching against leaf labels is exact by construction.

### 7.4 Facets are selected by rule, and wide ones are kept

**Decision.** A column becomes a queryable facet unless it is an identifier by name, has fewer than
2 or more than 5,000 distinct values, or is `ST` itself. Survivors are reported with their
cardinality; `segmentable` marks those under 200 values.

**Rationale.** Rules rather than a hand-written list, so a different export still works. The
thresholds do real work on this data:

* `Uberstrain`, `Barcode`, `Data Source` — 26,629 distinct values in 26,629 rows. Dictionary-encoding
  them would store the file twice.
* `Differences` — one distinct value in both files. A facet that cannot divide anything is noise.
* `Collection Time` — empty in all 38,597 clostridium rows.
* `HC0` — 17,935 distinct values in 26,629 vibrio rows. The finest HierCC levels are identifiers in
  all but name, which is why the cardinality rule is expressed as a number rather than a name list.

Wide-but-useful columns are **kept and flagged**, not dropped: `Source Details` (1,264 values)
cannot sensibly colour a chart but can perfectly well filter one. The server reports the count and
lets the frontend decide, rather than silently withholding a column because it judged it too wide.
25 facets survive for vibrio, 29 for clostridium.

### 7.5 Three states, not two: no data, filtered out, and counted

**Decision.** Every requested leaf is answered, carrying both `total` (isolates passing the filter)
and `available` (isolates before filtering).

**Rationale.** *Measured, and not anticipated:* **3.9% of vibrio leaves and 10.9% of clostridium
leaves have no isolate rows at all** (686 and 3,043 leaves). A tree leaf without metadata is normal,
not an error. Without both numbers the client cannot tell "this clade has no data" from "your filter
excluded everything" — visually identical, and very different things. Omitting such leaves from the
response would be worse still, since the bar chart would silently lose rows.

Blanks are likewise a value, not a dropped row: 11,699 of 26,629 vibrio isolates have no
`Source Niche`, and they appear as a segment with `value: null`.

### 7.6 A filter value that matches nothing is an error

`{"Continent": ["Atlantis"]}` returns 422, not an empty result. An unmatched value and a very
selective filter produce identical output, so a typo would read as a finding. The same reasoning as
§5.4: at a boundary, make the difference between "no data" and "bad request" visible.

### 7.7 Species-keyed stores, no shared namespace

One store per species, because ST numbering restarts per species and ST 11 is a different organism
in each (§1.7). Both stores are ingested independently and neither can resolve the other's labels.

## 8. Hardening

*Milestone 6. Code: `api/errors.py`, `api/app.py`, `tests/fixtures/`, `README.md`.*

**Gate met.** Every `curl` in the README runs against a live server and returns what the README
says it does. 171 tests pass.

### 8.1 One error shape, with a code to branch on

**Decision.** Every non-2xx response carries `detail` (a sentence for a human), `code` (a stable
identifier), and optionally `hint` (the request or command that answers the question). Validation
failures get the same shape plus an `errors` array naming each bad field.

**Rationale.** A frontend has to branch on failures, and branching on prose is how clients end up
matching substrings — after which the message can never be improved. `code` is the contract;
`detail` is free to be reworded. `hint` exists because most failures here have a specific remedy:
an uncomputed comparison names the CLI command that computes it, an unknown key names the endpoint
that lists the real ones.

Validation errors were folded into the same shape deliberately. Otherwise there are two error
contracts — the application's and the framework's — and the client has to implement both.

**Evidence that it was worth doing:** converting the routes broke three tests, each of which was
asserting on a substring of prose that had moved into `hint`. They now assert on `code`, which is
what a real client should do. The tests demonstrated the problem the change fixes.

A small thing, caught by the end-to-end test: pydantic reports a field as `query.budget`, prefixing
the location it came from. The client named `budget`, so that prefix is stripped before the error
goes out.

### 8.2 A committed fixture, so the suite runs anywhere

**Decision.** `tests/fixtures/datasets/` holds a 6 KB synthetic dataset, and
`test_pipeline_end_to_end.py` runs all three offline stages plus the API against it.

**Rationale.** Every other test needs `datasets/` — 20 MB of EnteroBase exports that are not in the
repository — and skips without it. A suite that skips silently on a fresh clone is a suite that can
rot unnoticed. The fixture makes the pipeline itself testable anywhere, including in CI.

It deliberately reproduces the shapes that actually broke things, rather than being merely small:
a **unary root** (§1.4), **mismatched leaf sets** (§3.1), **sequence types with no isolates** and
isolates belonging to no tree (§7.5), **blank cells**, a **goeBURST file** the catalogue must skip
(§1.8), and a **constant column** facet selection must drop (§7.4). A fixture made only of
well-formed data would pass whatever the code did.

### 8.3 The README is executed, not just written

**Decision.** `test_readme_walkthrough.py` extracts every `localhost:8000` URL from the README and
replays it, reading the HTTP method from the `curl` line that carries it.

**Rationale.** The README is the deliverable handed to whoever writes the frontend, and a broken
example there costs someone a morning. Restating the URLs inside the test would drift from the
README just as easily as the README drifts from the code, so the test reads the document.

Two figures in the first draft were already wrong — a `hidden_leaves` count and a similarity
minimum, both written from memory rather than from output. Running the walkthrough caught both
before it was handed to anyone.

### 8.4 CORS stays permissive, and says why

Every endpoint is a read over public research data and none accepts credentials, so
`allow_origins=["*"]` with `allow_credentials=False` is the honest setting rather than a lax one.
The note in `app.py` records what must change with it if authentication is ever added — and that
browsers refuse `allow_credentials=True` alongside a wildcard origin anyway, which makes the mistake
self-announcing.

### 8.5 What the OpenAPI document now carries

`/docs` is the contract handed to the frontend author, so it states the three conventions that are
not discoverable from the endpoint list: pre-order node identity, positional payloads, and slice
conservation. Tags group the four route families, the error model is declared on every route so the
failure shape appears in the documentation rather than being discovered by failing, and the summary
opens with a request worth making first.

## 9. Metric architecture: correspondence, and the language boundary

*Settled 2026-09-21, before any native porting, because the first C++ metric written would
otherwise fix these choices in place.*

### 9.1 Clade correspondence is a shared layer, not part of each metric

**Decision.** Split the per-node output in two. A **correspondence layer**, computed once per pair,
produces `similarity` and `corresponds`. Each **metric** produces its summary scalars and,
optionally, its own per-clade verdict. `MetricResult` changes shape accordingly.

**Alternatives considered.** The current design, where each metric produces its own `SideValues`
including similarity — which is how `rf_python` works today, because RF's LCA pass yields the
Jaccard ratio from the same two numbers it already compares (§3.3).

**Rationale.** That coupling is an accident of RF, not a property of comparison. Jaccard overlap
between two clades' leaf sets, and "which clade in the other tree does this one correspond to", are
**pure set operations over two topologies**. Nothing in them is RF-specific: a triplet, quartet or
geodesic comparison of the same pair would want exactly the same gradient to colour with.

Left as it is, the correspondence search — the expensive part, and the one piece of genuinely
novel work here — would have to be written once per metric, and in each metric's language. With one
metric that is invisible; with four it is the dominant cost of adding one.

**Evidence.** `_best_matches` is **12.6 s of the 13 s** a pair takes; RF itself is 0.15 s. The
expensive component is the one that is not metric-specific. Writing it four times would also mean
four opportunities for four implementations to disagree about what "similar" means, when the whole
point of a gradient is comparability across views.

**Consequence.** A metric that produces no per-clade values at all is still fully usable — see §9.3.

### 9.2 The language boundary follows the offline/online split

**Decision.** Two mechanisms, chosen by how often the code runs:

| layer | runs | mechanism |
|---|---|---|
| parser, succinct store, correspondence/BCN | every ingest, every request | **in-process native**, bound with `nanobind` or `pybind11` |
| **metrics** | **once per pair, offline** | **subprocess**: JSON over stdio, any language |

**Alternatives considered.** In-process bindings for everything. The per-language bridges all exist
and are current — `pybind11` 3.1.0 and `nanobind` 3.1.0 (C++), `maturin` 1.15.0 with PyO3 (Rust),
`jpype1` 1.7.1 (Java), `rpy2` 3.6.8 (R), `wasmtime` 48.0.0 (anything compiled to WASM).

**Rationale.** The requirement is that metrics be writable in **any** language. There is no single
library that binds any language; there are four bridges, four build toolchains, and four ways to
fail on a deployment machine — and this project has already spent a day on one unmaintained C++
dependency that needed three patches to compile (§2.2).

The universal mechanism needs no library at all. A metric takes **seconds** per pair; process-spawn
overhead is a millisecond. So `subprocess` is not a compromise for metrics, it is the correct
mechanism — and it makes "any language" true rather than aspirational. A geodesic implementation in
Java (GTP) then needs no Java bridge, only a command line.

In-process binding is reserved for what is actually hot, and everything on that list is code written
here anyway, so there is only ever **one** bridge to maintain.

The `subprocess` metric kind was already defined and documented in `contract.py` (§3.5) and
deliberately left unwired. This is the decision that says it gets wired, and why.

### 9.3 A metric need not produce per-clade values

**Decision.** Metrics may return scalars only. The frontend loses nothing but that metric's own
overlay.

**Rationale.** Because the gradient comes from the correspondence layer (§9.1), what the client can
draw does not depend on which distance was chosen:

| the frontend shows | source | available for a scalar-only metric |
|---|---|---|
| branch colour gradient | `similarity` — correspondence | yes |
| leaf equal/different | `corresponds` — correspondence | yes |
| headline distance | the metric | yes |
| per-clade overlay | the metric, if it defines one | no |

This matters for **geodesic (BHV)** specifically, which is measured over branch lengths in tree
space rather than over topology, and produces a single distance that does not decompose per clade in
any natural way. Under the old coupling it would have been unimplementable; under the split it is a
headline number alongside a full visual comparison.

Several scalars together are also worth more than each alone: RF, triplet and geodesic reported for
the same pair say *how the measures disagree about how different the trees are*. Two trees can be
far apart topologically and close in branch-length space, and that discrepancy is a result in
itself — one that needs no per-clade decomposition to state.

### 9.4 The metric roadmap

Recorded because the requirement is plural — several metrics, each native — and the earlier reading
of it as "the same metric in two languages" was **wrong** (user, 2026-09-21). A Python and a C++ RF
remain useful as oracle and production (§Next), but that is a conformance arrangement, not the point
of the registry.

| metric | status | notes |
|---|---|---|
| **Robinson-Foulds** | implemented (Python); C++ port planned | conformance target 6,825 |
| **Triplet** | **already built and working** | `trip_treediff` / `trip_sht` ship with TreeDiff |
| **Quartet** | candidate | `tqDist` is the standard C++ implementation; unrooted, so it ignores the root; new dependency and licence to check |
| **Geodesic (BHV)** | candidate | scalar only (§9.3); standard implementations are GTP (Java) and R's `distory`, both natural `subprocess` metrics |

**Evidence that triplet is close to free.** `trip_sht` on the reconciled vibrio pair (17,645 shared
leaves) returns **427,072,406,574** in **2.3 s** — about **46.6%** of the ~9.155e11 possible triples
disagreeing. It reproduces the paper's documented example (distance 1) and uses the same parser and
representation as the RF binaries.

**Recommended order: RF, then Triplet.** Triplet costs almost nothing, gives a second genuinely
different topological signal, and — unlike RF — does not saturate on large clades (§2.7), so it is
the better candidate for a second per-clade overlay. Quartet and geodesic can wait until the
frontend's interaction model says whether it wants a second overlay or only a second number.

## 10. The split, implemented

*Code: `trees/correspondence.py`, `metrics/columns.py`, `metrics/store.py`, `metrics/contract.py`.
§9 decided this; this records what it cost and what it revealed.*

**RF unchanged at 6,825**, shared clades 10,819, both cross-checks still firing. 212 tests pass
(was 196).

### 10.1 What moved, and the proportions

`trees/correspondence.py` now holds what was never RF: pre-order leaf numbering, the subtree fold,
binary-lifting LCA, the best-match search, and the leaf-bijection validation. `rf.py` keeps the
`(a+b−2s)/2` formula, its summary keys, and Day's interval test as a cross-check.

The proportions are the argument for having done it: of ~275 lines, **~180 were general machinery
and ~95 were Robinson-Foulds**. A second metric would have copied the larger part — or reached into
a sibling plugin's private module, which the plugin-directory design exists to prevent.

The move was made by lifting the functions **verbatim** and checking the output was identical
(`similarity` 0.667 at the same node, `corresponds` the same array) before changing anything else. A
refactor that also "improves" the code cannot be checked this way.

### 10.2 RF's verdict is derived, not recomputed

`exact` is `similarity == 1.0`: Jaccard reaches 1 only when intersection equals union, which is set
equality. So the metric needs no second traversal, and — the part that matters for the native
port — **a C++ RF needs to return only a number**.

Asserted rather than assumed, on the real pair and on constructed trees where the clade sets are
enumerated directly.

### 10.3 Measured: the split does what it was for

| | vibrio pair |
|---|---|
| shared work (reconcile + correspondence) | **12.6 s** |
| RF itself | **0.1 s** |

A second metric now costs its own work and nothing else. Before, each metric recomputed the search;
`compute-pairs` also takes `--metric` repeatably now, so several metrics share one pass over a pair
rather than one pass each.

Storage, per pair: correspondence **552 KB** (8 B/node/side), RF **70 KB** (1 B/node/side).

### 10.4 `order=difference` became metric-independent

It ranks by `similarity`, which is now shared, so the priority cache is keyed by pair and side
rather than by metric — and the navigation works for a metric that contributes no per-node columns
at all. Behaviour is unchanged: worst similarity on screen at budget 100 is still 0.039 against
`size`'s 0.233, and slice conservation still holds.

### 10.5 Two things the refactor surfaced

**A caching mistake, caught while writing it.** The first version tried to load stored
correspondence instead of recomputing it. That is wrong: metrics receive correspondence in
**reconciled** indexing, while what is stored is projected onto the **stored** trees. The two are
not interchangeable, and the confusion would have produced values attached to the wrong nodes —
silently, since both arrays are well-formed. The pipeline now computes for the metric and writes the
projected form separately, and the comment says why.

**`correspondence` appeared as a metric.** `/api/datasets` listed a pair's metrics by listing its
directories, so the new sibling showed up as one. Caught by an existing test asserting
`metrics == ["rf"]`. The listing now goes through `registry_pairs.available()`, which knows the
difference — one place to be right rather than two.

### 10.6 What a metric may now return

`MetricSide` holds **named columns**, and the on-disk schema is recorded in each header rather than
hardcoded. Consequences, each covered by a test:

* a metric may declare **no columns** — the geodesic case; it stores, reads back, and slices as an
  empty mapping;
* a metric may declare **several** — a richer per-clade signal is not flattened to fit;
* a column of the wrong length is **refused at write time**, not discovered on read.

The wire follows: `ComparisonValues` carries `similarity` and `corresponds` from correspondence,
`exact` when the metric defines one, and any further columns under `columns`.

## 11. Metrics in any language, as configuration

*Code: `metrics/runners.py`, `metrics/plugins/triplet_treediff/metric.json`. §9.2 decided the
mechanism; this is what it cost and what it proved.*

**The claim is now asserted, not argued.** `tests/test_runners.py::test_triplet_is_configuration_only`
reads the plugin directory and fails if it contains anything but `metric.json`. Adding a second
metric, in another language, added **no code**.

246 tests pass. RF unchanged at 6,825.

### 11.1 What adding triplet actually took

One file. The whole of it:

```json
{
  "name": "triplet", "kind": "subprocess",
  "command": ["${native}/TreeDiff/trip_sht", "${left}", "${right}"],
  "input": {"format": "newick", "include_lengths": false},
  "parse": {"scalars": [
    {"key": "triplet", "pattern": "Triplets distance is:\\s*([0-9]+)", "type": "int"}
  ]},
  "outputs": {"columns": []}
}
```

Measured, computing both metrics in one pass over the vibrio pair:

| | |
|---|---|
| shared work (reconcile + correspondence) | 12.6 s |
| RF | 0.1 s |
| **triplet** | **2.6 s** |
| triplet distance | **427,072,406,574** — ~46.6% of the ~9.155e11 possible triples |

### 11.2 `include_lengths` is a correctness control, not a formatting option

The manifest says `"include_lengths": false`, and it must. TreeDiff infers *weighted* mode from the
first `:` it encounters and silently computes a weighted distance instead of a topological one
(§2.3). A tool that changes what it computes based on its input's incidental shape is exactly the
kind of thing a declarative contract has to be able to control, so the input spec governs it and a
test asserts both forms reach the tool.

### 11.3 Failing loudly, because the alternative is a plausible number

A subprocess metric can fail in ways a function cannot, and each is turned into an error rather than
an empty result:

| | behaviour |
|---|---|
| binary not built | refuses, naming the path and where to build it |
| non-zero exit | reports the exit code and the tool's stderr |
| output does not match the declared pattern | **fails** — a tool that changed its output format must not report nothing |
| no output in `timeout_s` | fails rather than hanging an overnight batch |
| unbuilt metric at discovery | still **listed**, marked `available: false` |

That last one matters for the frontend: a metric that exists but cannot run should be visible and
not offerable, rather than absent (looks unconfigured) or offered (produces an error when picked).

### 11.4 The offline/online split is what makes subprocess the right mechanism

A metric runs once per pair and takes seconds; process startup is a millisecond. So there is no
overhead worth avoiding, and the alternative — an in-process binding per language — would mean four
toolchains and four ways to fail on a deployment machine, against a project that has already lost a
day to one unmaintained C++ dependency (§2.2).

In-process binding stays reserved for the hot paths — parsing, the store, correspondence — which are
this project's own code, and therefore only ever one toolchain.

### 11.5 What a subprocess metric may return, and what it may not

Scalars, parsed by declared patterns. That covers every metric in view: RF, triplet, quartet and
geodesic all print a number. It is *enough* only because per-clade colouring does not come from the
metric (§9.1) — under the old contract, a tool that printed one number could not have been
integrated at all.

Structured per-clade output from a tool is **deliberately not implemented**. TreeDiff's `info` mode
is the only candidate and it prints four different formats depending on which mode fired; building a
parser for a shape nothing needs would be speculative. The gap is recorded rather than filled.

## 12. The sdsl-lite v3 spike

*Code: `native/src/spike.cpp`, `native/build.sh`. The question was whether part 2 of the plan is
viable at all; §2.2 recorded that the GPL-3.0 original needed three patches to compile here.*

**It is viable, and considerably easier than expected.**

### 12.1 v3 is header-only, which removes the whole class of problem

`add_library(sdsl-lite INTERFACE)` — there is no library to build. No CMake step, no `libsdsl.a`, no
compiler-detection bug mistaking Apple clang for MSVC, no unmaintained typo in `louds_tree.hpp`.
`native/build.sh` is **one `clang++` invocation over one source file**, against
`native/build_treediff.sh`'s five patches. It compiled first attempt with `-Wall` and no warnings.

That difference is worth more than the licence change on its own: it is the maintenance a PHYLOViZ
merge would otherwise inherit (§2.2).

### 12.2 The operations agree with the columnar store, on every node

The spike implements the operations TreeDiff added to sdsl's GPL header — reimplemented from stock
v3 primitives, not copied — and checks each against the existing implementation:

| | vibrio-upgma | vibrio-nj | clostridium-upgma |
|---|---|---|---|
| nodes checked | 35,291 | 35,289 | 55,923 |
| `preorder` / `select` | ✓ | ✓ | ✓ |
| `cluster_size` vs the interval encoding | ✓ | ✓ | ✓ |
| `is_leaf` | ✓ | ✓ | ✓ |
| `num_leaves` vs the `leaf_count` column | ✓ | ✓ | ✓ |

**Zero mismatches.** `lca` spot-checked against hand-worked cases, including the ancestor-of case
that `double_enclose` handles differently from a naive reading.

**One bug, found by the cross-check rather than by reading either implementation.** `num_leaves`
was wrong for every leaf: a leaf is the pattern `()` == `10`, sdsl's rank counts patterns wholly
before its argument, so the closing position must be passed as `find_close(i) + 1`. TreeDiff's
vendored header omits the `+1` against its own indexing. The convention is not transferable between
the two, and copying the expression would have produced a representation that reported zero leaves
under every tip — while passing any test that only checked it loaded.

### 12.3 Space: the honest number is ~4x, not 74x

Topology alone is **0.34 B/node** succinct against **14.00 B/node** columnar — 41x, or 74x measured
against the whole columnar store. **That is the wrong number to quote**, and worth stating plainly
because it is the one that leaps out of the measurement: the succinct form holds *no labels and no
branch lengths*, and both must be served.

Like-for-like, counting what a store must hold to serve rather than only to compare:

| | B/node | |
|---|---|---|
| columnar, as built | 24.70 | |
| succinct topology | 0.34 | replaces 14.00 of columns |
| + branch lengths (f32) | 4.00 | required either way |
| + labels, as stored today | 6.69 | required either way |
| **succinct, same duties** | **11.02** | **2.2x smaller** |
| + labels narrowed to u32 ST ids | 2.00 | possible, since ST ids are integers |
| **succinct + narrowed labels** | **6.34** | **3.9x smaller** |

**§2.1 predicted ~4x like-for-like. Measured: 3.9x.** The prediction holds, which is a useful check
on the reasoning that produced it — and the 74x figure would have quietly inflated a thesis claim by
an order of magnitude.

### 12.4 Time: the trade is real and in the expected direction

`num_leaves` over all 35,291 nodes: **3.2 ms** succinct against **0.2 ms** columnar — because the
columnar store *holds* the answer while the succinct one *computes* it. Sixteen times slower in
relative terms, and irrelevant in absolute ones: a 500-node slice is ~0.05 ms either way, against a
50 ms budget.

This is the paper's own reported trade-off — space against time — reproduced on a dataset it did not
use, which is the thesis result §2.1 anticipated.

### 12.5 What this unblocks, and what it does not

Steps 6–9 are viable: the primitives are present, correct, fast enough, and permissively licensed.

What the spike does **not** show, and what remains genuinely new work: the **serialisation**
(TreeDiff has none at all, so there is no precedent to copy), the C++ Newick parser, and the
correspondence search — which is the expensive part and has no counterpart in TreeDiff.

## 13. The native Newick parser

*Code: `native/src/newick.hpp`, `trees/native.py`. Gate: leaf counts match, ingest no slower.*

**Gate met, and then some.** Leaf counts 17,646 / 17,645 / 27,962 exactly, every column identical to
the Python parser, and ingest **17–19x faster**.

| tree | Python | C++ |
|---|---|---|
| vibrio-upgma | 85 ms | **5 ms** |
| vibrio-nj | 99 ms | **5 ms** |
| clostridium-upgma | 136 ms | **8 ms** |

For scale: phylo.io parses the first of these in **945 ms**, in the browser, before it can draw
anything.

### 13.1 Written new, not ported

TreeDiff's parser was read closely (§Next) and deliberately not reused. It takes a `FILE*`, discards
every label once it has built its correspondence map, is structurally a two-tree routine — the
second parse depends on state the first left behind — grows its bit vector one parenthesis at a time
(**O(n²)**, very likely the dominant cost in its reported parse times), and **does not skip
whitespace**, so a pretty-printed Newick parses wrongly and silently.

This one takes a string, keeps labels and branch lengths, handles one tree at a time, reserves once
rather than growing per node, and skips whitespace. It also emits the balanced-parentheses string
alongside the columns, which is what the succinct store will hold.

### 13.2 Checked against the Python parser, not against itself

Correctness is established by **agreement, column for column**: `parent`, `subtree_end`, `depth`,
`leaf_count`, `branch_len` (including which entries are NaN), and `labels`. On all three real trees
and on eleven constructed cases chosen for where implementations actually differ — quoted labels,
doubled-quote escapes, absent lengths, whitespace, pretty-printing.

That is a stronger check than a test suite written for the C++ alone, because the Python parser was
already validated independently: leaf counts against a regex scan of the source files, and RF
against the reference implementation.

### 13.3 The extension is optional, and that is load-bearing

`trees/native.py` loads it **by path** if present, returns `None` if not, and every caller falls
back. Nothing imports it directly.

This is not defensive habit. The extension is gitignored, needs a C++ compiler, and is not required
for correctness: every native component has a Python counterpart that produced the numbers reported
here. A machine with no compiler — a grader's laptop, a minimal container, the school server — runs
the entire backend from `uv sync` alone.

**Verified both ways**: 271 tests pass with the extension, 248 pass and 23 skip without it. The
skips are the native-specific tests; nothing else changes behaviour. A stale extension built for
another interpreter is caught and ignored rather than taking the process down.

### 13.4 Two bugs the corpus check caught

Neither would have failed a test written against the C++ in isolation.

**Label whitespace.** The first version kept surrounding whitespace inside unquoted labels, so
`( A , B )` yielded labels `" A "` and `" B "`. Every structural column was correct; only the names
were wrong — and a label set that is quietly wrong is what breaks the leaf bijection two milestones
later, as a mismatched-leaf-set error nobody can explain.

**Malformed branch lengths.** `std::stof` throws where Python's `float()` was already being caught.
Left unhandled, one bad length in a 900 KB file would abort ingestion instead of becoming NaN, which
is what the Python parser does and what §1.3 decided.

## 14. The succinct store

*Code: `trees/succinct_store.py`, `native/src/bp_tree.hpp`. Gate: slices identical to the columnar
store.*

**Gate met.** Slices are identical at budgets 1, 2, 7, 25, 100, 500 and 2,000, from the root and
from a wedge, on all three trees — field for field, not merely equivalent. 297 tests pass.

| | columnar | succinct | |
|---|---|---|---|
| vibrio-upgma | 851 KB | **377 KB** | 2.3x |
| vibrio-nj | 851 KB | **377 KB** | 2.3x |
| clostridium-upgma | 1,355 KB | **604 KB** | 2.2x |

§12.3 predicted 2.2x for "succinct, same duties" — labels still stored as strings and offsets. The
3.9x figure needs labels narrowed to u32 sequence-type ids, which is not done.

**Slice latency is unchanged**: 6.7 ms succinct against 7.5 ms columnar at budget 500. The space
saving costs nothing at serving scale, because a slice touches a few hundred nodes and both paths
are bounded by Python call overhead rather than by the lookup.

### 14.1 The summariser had to stop taking columns

`Summariser` materialised `subtree_end`, `leaf_count` and `branch_len` as whole arrays. For the
columnar store that is free; for this one it would mean **decompressing an entire tree to serve a
few hundred nodes of it** — precisely inverting the point.

It now asks per node — `subtree_end_of(i)`, `leaf_count_of(i)`, `branch_len_of(i)` — and both stores
implement that interface. This is what makes the equivalence test possible at all: one summariser,
two stores, compared output.

Done as its own change, with the full suite green before anything succinct existed, so a later
difference could not be attributed to it.

### 14.2 Only the bit vector is serialised

Rank and select support are **derived**, so storing them would be storing a cache. They cost ~1 ms
to rebuild for 35k nodes, once per process, against a file roughly four times smaller.

TreeDiff has no serialisation at all — it rebuilds from Newick on every invocation — so there was no
precedent here to follow or to diverge from.

### 14.3 A C++ trap worth recording

sdsl's rank/select supports hold a **pointer** to the bit vector they index. The implicitly-generated
copy and move constructors copy that pointer, leaving the support aimed at the source object's
vector — which is then destroyed. The structure looks valid and reads freed memory.

It surfaced as an assertion inside `int_vector` the first time a *loaded* tree was queried, which is
the lucky outcome; the unlucky one is plausible-looking garbage. `BpTree` now writes out all four
operations and re-aims the supports with `set_vector`.

This is the kind of thing that makes "vendor their header" look cheaper than it is: the trap is in
the library's ownership model, not in any one implementation, and it is invisible until an object
crosses a function boundary.

### 14.4 What is stored where, and why it is split

The succinct structure holds **topology**. Labels and branch lengths sit beside it as ordinary
columns, because they are data it has no notion of and the API must serve them. That split is the
whole reason the honest space figure is 2.2x rather than the 41x topology-alone number (§12.3) —
worth restating here, because this is the file where someone would look for it.

## 15. Native correspondence

*Code: `native/src/correspondence.hpp`. The expensive half — 12.6 s of the 13 s a pair took — and
the piece every metric shares.*

**13x faster on the real pair, and bit-identical.** 304 tests pass.

| pair | Python | native | |
|---|---|---|---|
| vibrio-upgma vs vibrio-nj | 12.8 s | **0.95 s** | **13x** |
| clostridium vs vibrio (cross-species) | 15.0 s | 11.5 s | 1.3x |

### 15.1 An exact pruning bound, not a faster loop

The Python version scores every target clade against every source clade. The native version does
the same search with a bound that excludes candidates which *provably* cannot win. For a source
clade of size `a` and a target clade of size `c`,

    Jaccard <= min(a, c) / max(a, c)

because the intersection cannot exceed the smaller set. So once something has scored `best`, only
clades with `c` in `(a * best, a / best)` can beat it. Target clades are visited nearest-size-first,
and the window tightens every time `best` improves. The LCA seeds it for free, since the LCA
contains the whole source clade by construction.

This is exact — it prunes what cannot win, not what looks unlikely — and that is asserted against an
exhaustive scan written independently of both implementations, so a shared misreading of the bound
would surface.

### 15.2 The speedup depends on the pair, which is worth stating

| pair | mean clade similarity | speedup |
|---|---|---|
| vibrio-upgma vs vibrio-nj | 0.862 | 13x |
| clostridium vs vibrio | 0.224 | 1.3x |

A high `best` closes the window to clades of nearly the same size; a low one leaves it open. Two
genuinely related trees prune hard; two unrelated ones — and a cross-species pair is exactly that,
99.1% of labels colliding by coincidence (§1.7) — barely prune at all, and the native version falls
back to being ordinary C++ against vectorised numpy.

**13x is therefore the number for the comparison this tool is for**, and 1.3x is the floor. Quoting
the first without the second would be describing the best case as the typical one.

### 15.3 Two bugs, both invisible in the scores

`similarity` was bit-identical from the first working version. `corresponds` was not, and neither
cause could have been found by looking at the numbers — the scores agreed throughout.

**Ties had no rule.** Where several clades match equally well — 1,148 nodes on the vibrio pair —
numpy's `argmax` takes the lowest index and the native search took whichever it reached first. Both
answers are equally good and the disagreement is still a defect: it would make the extension a
*behaviour* change rather than a speed one, and the fallback observably different from the fast
path. Ties now break on lowest node index in both.

**The window bound was strict where it had to be inclusive.** A clade that *ties* with the current
best sits exactly on the boundary — its intersection is the whole smaller set, so `c == a / best` —
and `<` excluded precisely the ties, including ones with a lower index than the winner. Changing
`<` to `<=` fixed it. This had to be reasoned about rather than measured, because every score was
already correct.

### 15.4 What this means for step 9

RF now costs **0.1 s** against correspondence's 0.95 s, and derives its entire per-clade output from
it (§10.2). A native RF would optimise under 10% of a pair, and under 1% before this step.

So the remaining native work is not a port. The useful thing is an **independent** implementation to
check against — TreeDiff's `rf_postorder`, already built, addable as a subprocess metric with no
code (§11). That buys verification by different code over a different representation, which is what
three wrong RF implementations (§2.5) suggest is worth having.

## 16. Step 9, changed: verification instead of a port

*Code: `metrics/plugins/rf_treediff/metric.json`.*

The plan's step 9 was "RF in C++, checked against 6,825". **That work is no longer worth doing**, and
saying why is more useful than doing it.

After the correspondence split (§10) RF derives its entire per-clade output from `similarity == 1.0`
and contributes one number. After native correspondence (§15) a pair costs 1.1 s of shared work and
**0.1 s of RF**. Porting it would optimise under 10% of a pair — and under 1% before step 8.

What *is* worth having is an **independent** implementation. Three of the five RF implementations
examined for this project return wrong answers on real input, all silently (§2.5, and *Corrections*).
Agreement between two implementations that share no code is the only evidence available that neither
is wrong in a way the other shares.

**So step 9 became a `metric.json`.** TreeDiff's `rf_postorder` is already built and was already the
conformance oracle; registering it makes the check standing rather than something run by hand once.

    vibrio-nj__vibrio-upgma   rf           rf=6,825    0.1 s   (ours, derived from correspondence)
    vibrio-nj__vibrio-upgma   rf-treediff  rf=6,825    0.4 s   (TreeDiff, succinct representation)

Different authors, different algorithm, different representation, same answer — now asserted on the
paper's own example, on constructed pairs including caterpillars, on the real pair, and on the
self-comparison control that exposed two defects elsewhere.

`rf_postorder` rather than `rf_nextsibling`: the latter recurses once per tree level, and these
trees are 604 deep.

**Licensing is unchanged by this.** TreeDiff runs as a separate process and nothing links it, so the
GPL-3.0 obligation does not reach this MIT repository (§References and provenance). Registering it
as a metric is running a program, which is what the subprocess kind exists for.

### The native work, in proportion

| | before | after | |
|---|---|---|---|
| Newick parsing (per tree) | 85–136 ms | **5–8 ms** | §13 |
| correspondence (per pair) | 12.6 s | **0.95 s** | §15 |
| RF (per pair) | 0.1 s | 0.1 s | not ported, deliberately |
| tree storage | 24.7 B/node | **~11 B/node** | §14 |

The parts that were worth making native were the parts that were slow. RF never was.

## 17. Scaling, measured — and the search parallelised

*Code: `native/src/correspondence.hpp`, `native/src/module.cpp`, `config.threads()`.*

### 17.1 Where a comparison's time actually goes

Measured on pairs built by nesting relabelled copies of the real vibrio trees, so the shape stays
deep and unbalanced rather than randomly balanced — which matters, because the pruning bound
(§15.1) depends on shape:

| leaves | nodes | parse | reconcile | **correspondence** | rf |
|---|---|---|---|---|---|
| 17,645 | 35,289 | 0.04 s | 0.12 s | **0.92 s** | 0.07 s |
| 35,290 | 70,579 | 0.08 s | 0.24 s | **3.39 s** | 0.12 s |
| 70,580 | 141,159 | 0.16 s | 0.47 s | **12.92 s** | 0.24 s |
| 141,160 | 282,319 | 0.32 s | 0.95 s | **51.88 s** | 0.48 s |
| 282,320 | 564,639 | — | — | **207 s** (568 MB) | — |

**Correspondence is O(n²) and is essentially all of it.** Four doublings confirm the shape: twice
the leaves, ~3.8x the time. Everything else is linear and together under 2% at 282k leaves.

**The native port (§15) bought a constant, not a shape.** 13x faster, still quadratic. Worth
stating plainly because it is the intuitive mistake: a language change cannot fix an algorithm.

### 17.2 Robinson-Foulds does not need any of it

| nodes | RF via Day's interval test | correspondence |
|---|---|---|
| 35,289 | 0.07 s | 0.92 s |
| 141,159 | 0.24 s | 12.92 s |
| 564,639 | **0.95 s** | **207 s** |

RF is O(n) and scales flat. What costs is the **gradient** — "how much of this clade survives and
where did it go" — which RF has no need of and the frontend colours with. `rf.py` already carries
Day's test as a cross-check (§3.2), so a distances-only mode would be nearly free.

**Decided against** (user, 2026-09-22): one code path is worth more than the saving. No pair is
ever half-computed, and the API never has to represent one.

### 17.3 Parallelised: 5.5x, and bit-identical

Each source clade's search is independent — shared read-only inputs, its own scratch buffer, two
output slots nobody else touches.

| leaves | nodes | before | after | |
|---|---|---|---|---|
| 17,645 | 35,289 | 0.92 s | 0.28 s | 3.2x |
| 70,580 | 141,159 | 12.92 s | 2.34 s | 5.5x |
| 141,160 | 282,319 | 51.88 s | 9.06 s | 5.7x |
| 282,320 | 564,639 | **207 s** | **37.97 s** | **5.5x** |

On 10 cores, 4 of them performance. The gain is 3.2x at small sizes and 5.5x at large: at 35k nodes
the single-threaded Python preparation around the search is 15% of the total, and by 565k nodes it
is 2%. Amdahl's law, visible in a table.

Two things the implementation turns on:

* **Dynamic scheduling.** Clade cost varies by three orders of magnitude — a 2-leaf clade against
  an 8,441-leaf one — so threads pull 64-index chunks from an atomic counter rather than taking
  equal blocks, which would leave most of them idle behind whoever drew the large clades.
* **Releasing the GIL.** Without it the workers serialise on it and the pool is *slower* than the
  single-threaded loop.

**The gate is determinism, and it is tested rather than argued.** The same pair at 1, 2, 3, 8 and 16
threads is bit-identical in both `similarity` and `corresponds`, on constructed trees and on the
real pair. It should be — index *i* depends on no other index and ties break within one iteration —
but reasoning about determinism instead of testing it is how race conditions ship.

### 17.4 Other languages were weighed for this, not just other schedulers

`best_matches` touches no sdsl: nine plain arrays in, two out, run once per pair offline. Unlike the
succinct store it has no commitment to C++ and could even be a subprocess.

* **Virtual threads (Loom) and coroutines (Kotlin)** solve *blocking*, not computation. A parked
  task releases its carrier thread; this loop never parks — no I/O, no locks, nothing to yield on.
  They would be pinned to a carrier pool sized to the core count, giving the same parallelism plus
  overhead. **CPU-bound work is capped by physical cores in every language.**
* **Rust with `rayon`** was the strongest alternative: work-stealing handles the clade-size
  imbalance better than hand-rolled chunking, and memory safety rules out the class of bug in §14.3.
* **Java/Kotlin as a subprocess** is viable — JVM startup and serialising a few MB are noise against
  200 s.

**C++ was kept because it already existed and was already verified** bit-identical to the Python
reference and to an independent exhaustive scan. A rewrite re-opens that verification for a
constant-factor gain threading already delivers, and none of the alternatives changes O(n²).

Java and Kotlin remain usable for **metrics**, which the subprocess contract accepts in any language
— GTP, a geodesic implementation, is Java and would need no code at all.

### 17.5 Where this leaves the ceiling

At 565k nodes a pair is **38 s**; extrapolating the quadratic, 1M nodes is ~2 min and 2M ~8 min.
Comfortable for offline work.

Two caveats worth carrying: the pruning weakens on **dissimilar** trees (1.3x rather than 13x,
§15.2), so a badly-matched large pair costs several times these figures; and parallelism is a
constant factor, so it buys roughly **one doubling** of tree size and no more. Beyond that the
remaining lever is the algorithm — bottom-up overlap accumulation with small-to-large merging —
which is recorded as deferred, not dismissed.

## 18. Persistence: a module owns its storage, the API is the contract

*Decided with the supervisors, 2026-09-22. One suggested PostgreSQL; the other that it should be
"a base de dados que mais for conveniente", since "o ponto de integração com o PhyloViz será por
meio da FastAPI bem definida" and "todos os módulos do PhyloViz 3.0 [têm] como requisito serem
desacopláveis dos restantes".*

### 18.1 The integration point is the API, so storage is internal

**Decision.** This module owns its own persistence. No other module reads its files; the FastAPI is
the only contract. Storage is therefore an implementation choice, revisable without coordination.

**Rationale.** This is *database-per-service*, and the reasoning is that a shared schema is a worse
coupling than an API, not a lesser one: it is invisible, unowned, and prevents either side from
deploying independently. A module that brings its own store is **more** decoupleable than one
requiring a shared database, which is what the modularity requirement asks for.

That also dissolves the disagreement rather than settling it. PostgreSQL is a sound choice *when it
is already part of the platform* — an operational convenience. It is not an architectural
requirement, and nothing in this module's design has to commit either way.

**Evidence that the seam is real, not asserted.** In §14 the columnar store was replaced by a
structurally different succinct one — balanced parentheses over a bit vector, computing what the
other held — and the API, the summariser and every endpoint were **unchanged**, producing
**byte-identical slices** at seven budgets, from the root and from a wedge. The API touches no file
directly; the summariser needs four methods (`subtree_end_of`, `leaf_count_of`, `branch_len_of`,
`label`). Two working stores behind one unchanged interface is a demonstration, where most
architecture writing offers a diagram.

### 18.2 The store holds no system of record, which is what makes this cheap

**Confirmed with the user (2026-09-22): there is no update path after precompute.** Everything in
`store/` is derived from `datasets/` and reconstructed by `phylodelta build-all`. It is a **cache, not
a database**.

Owning your persistence normally means owning backup, migration and durability. Here:

| | |
|---|---|
| backup | `cp -r`, or nothing — re-run `build-all` |
| migration | every store writes a `FORMAT_VERSION`; a reader refuses a mismatch rather than misreading old bytes |
| durability | no unique state to lose |
| deployment | `uv sync` and a directory — no service, no credentials, no schema |

**This invariant is load-bearing and is recorded because it is otherwise implicit.** The moment
anything is written at runtime — an uploaded tree, a saved annotation, a session — the store holds
data that exists nowhere else, and the full operational burden of the pattern arrives with it:
real backups, migrations, concurrent writes, and a reason to want a database. Revisit this section
before adding the first write.

### 18.3 Where a database would fit if one were wanted

The data has three shapes, and "PostgreSQL or not" is the wrong granularity for all three at once:

| | shape | access | verdict |
|---|---|---|---|
| tree topology, correspondence, metric columns | flat arrays, 3.9 MB now, ~30–50 MB per pair at 500k nodes | *"entries 4,812 to 5,311 of six columns"* | **keep on disk** — that is a memcpy from an mmap (6.6 ms per slice); in SQL it is a query to plan, execute and serialise, and as `bytea` it is a filesystem with extra steps |
| isolate metadata | 26,629 rows x 25 facets | filter by AND/OR across facets, group-count by one | **the genuine candidate.** What is built is a hand-rolled column store for exactly the query SQL is good at (3.0 ms for 500 leaves), but it answers only anticipated queries |
| catalogue | which trees, pairs and metrics exist | listed per request | **would help at scale** — currently a directory scan, fine for three trees, noticeable at three hundred |

The common landing place for this shape is relational metadata pointing at array files. Not needed
now; cheap to adopt later precisely because of §18.1.

### 18.4 API versioning follows from the API being the contract

Routes moved to `/api/v1`. Not a commitment to maintaining two versions — a reservation of the
ability to, which cannot be retrofitted once a consumer's client is in production. The costs are
asymmetric: a prefix now, against coordinating a breaking change with another team later, or never
changing a response shape again.

Path rather than header, because whoever integrates this will be reading logs and running `curl`,
and a path segment lets `/v1` and `/v2` run side by side through a migration.

The policy is stated in the OpenAPI description, where an integrator will actually look:

* **not breaking** — a new endpoint, a new field, a new metric, a new per-node column. This is why
  metric outputs are *declared* (§9.1) rather than fixed: adding one is additive by construction.
* **breaking** — removing or renaming a field, changing what one means, and above all **changing
  what a node id denotes**. `id` is the join key across topology, comparison values and isolate
  composition, so a client holding ids across such a change would silently misalign rather than
  fail.

The same discipline already exists one layer down: each store's `FORMAT_VERSION` is checked on
read. The API deserved it too.

## 19. From a precomputed catalogue to a multi-tenant service

*Requirements given by the user, 2026-09-23. Recorded before design, because they invalidate an
invariant §18 rests on and nothing should be built on the old assumption by accident.*

### 19.1 What was settled

| question | answer |
|---|---|
| Are trees uploaded by users, or ingested by an operator? | **Uploaded.** Users supply the trees *and* their isolate data. |
| Is there authentication? | **Yes**, and each user's datasets are their own. |
| How large may an upload be? | "Depends on what the frontend can upload" — which means **unbounded from our side, so the limit must be ours**. |
| Do results outlive the session? | **Yes.** |
| Do the vibrio/clostridium datasets stay shared? | **No — everything is user-owned.** |

### 19.2 What this invalidates

**§18.2's read-only invariant is dead.** It said the store holds no system of record: everything
derived from `datasets/`, rebuildable by `build-all`, backed up with `cp -r` or not at all. A user's
uploaded tree and their computed comparison exist **nowhere else**. Backup, durability and migration
become real obligations rather than conveniences.

**A database is now required, not an operational convenience.** §18.3 said PostgreSQL would be right
*if already on the platform*. Users, ownership, uploads, job state, quotas and expiry are mutable,
relational and concurrently written — exactly what a database is for. The split from §18.3 still
holds: **a database for identity and job state; flat files for the bulk arrays.** Nothing about
uploads makes SQL a good home for 40 MB of node columns.

**Eight of the ten endpoints become authorisation decisions.** Only `/health` and `/metrics` are
genuinely global. Slices, comparisons, isolate queries and `/datasets` all currently serve any data
to anyone. Ownership is not a bolt-on; it is a parameter threaded through every read path.

**Tree identity must become opaque.** Ids are `{species}-{method}` derived from the filename
(`catalogue.py`), so the second user to upload `vibrio-upgma-tree.nwk` would overwrite the first.

**Storage grows without bound.** Persistent results plus uploads sized by the client means quotas
and retention are decisions someone must take. For scale: a 500k-leaf Newick is ~25 MB, an isolate
TSV 12 MB, and a large pair commits the server to minutes of CPU — so the cap protects the CPU as
much as the disk.

### 19.3 What survives, which is most of the work

Parsing, canonicalisation, reconciliation, correspondence, the metric plugin system, both tree
stores, the comparison store, slicing, node identity, the whole read surface of the API, and all 320
tests. Unchanged.

What is needed is a **layer around** it — identity, ownership, uploads, jobs, quotas — not a
rewrite. The stores simply get written per user instead of per deployment.

### 19.4 `build-all` is demoted, not deleted

With every dataset user-owned there is no global catalogue, so the `datasets/` → `build-all`
pipeline stops being part of the product. It remains:

* how the test suite builds a real store,
* how the measurements throughout this record were produced,
* and how anyone evaluates the system locally without uploading anything.

Recorded so its continued existence is understood as deliberate rather than vestigial.

### 19.5 Identity is undecided, and is designed around rather than waited on

Whether PhyloDelta validates a token issued by PhyloViz, or runs its own accounts, is **not yet
settled with the supervisors**.

It need not block design. Everything downstream needs one thing: *which user is this request for*,
as an opaque id. Putting that behind a single dependency means the eight endpoints consuming it do
not care where it came from, and the source can be swapped without touching them.

The interim assumption is **PhyloViz owns identity** — PhyloDelta verifies a token and stores an
opaque subject id, never a password. It is the smaller commitment, the easier one to replace, and
the one consistent with modules being decoupleable: identity is a platform concern, and duplicating
it per module — along with password handling, reset flows and session management — would be
duplicating a security surface, not just code.

### 19.6 Still open

* **Upload limits.** Ours to choose, since the client will not impose them. They bound CPU as well
  as disk.
* **Quotas and retention.** Results persist; storage does not shrink on its own.
* **Sharing is deferred to future work** (user, 2026-09-23). Datasets are private to their owner;
  there is no mechanism for one user to show another a comparison.

  Deferring costs nothing **provided the store path does not encode the owner.** With files at
  `store/trees/{uuid}/` and ownership held as a database column, adding sharing later is one new
  table and no data movement. With files at `store/users/{user_id}/trees/{id}/`, it means copying,
  symlinking or an indirection layer — the layout would have assumed a single owner forever.

  So: **owner in the database, never in the path.** That is the whole cost of keeping the option,
  and it is worth paying now.
* **Computation on request.** A pair is seconds to minutes; no HTTP request survives that, so this
  needs a job queue and a status endpoint. `proxy_read_timeout 600s` in the deployment is a stopgap,
  and is marked as one.

## 20. Ownership, and the seam that decides who is asking

*Code: `db/`, `api/identity.py`. First step of §19, chosen because it is needed whichever way the
identity question resolves.*

**334 tests pass** (was 320), and the suite still passes without the native extension.

### 20.1 A database, for the half that is relational

`SQLAlchemy` over SQLite by default, PostgreSQL by `PHYLODELTA_DATABASE_URL`. The split §18.3
described now applies: **the database holds ownership and job state; the bulk stays in flat files.**

Two things it deliberately does **not** hold:

* **A users table.** Whether identity comes from a PhyloViz token or local accounts is undecided
  (§19.5), so `owner_id` is an opaque string with no foreign key. The table does not need to know.
* **Tree metadata.** Leaf counts, depth, species and method stay in each store's `meta.json`, which
  remains authoritative and self-describing — a store directory can still be read without the
  database. The row holds ownership and a pointer. Two sources of truth for one fact is how they
  drift.

Adding SQLAlchemy preserves the property worth keeping: SQLite is stdlib and SQLAlchemy is a pure
wheel, so the backend still runs from `uv sync` and a directory with **no service to install**.

`create_all` is enough while the schema is young and the data rebuildable. Once uploads exist there
is user data to carry across a change, and this needs a migration tool — recorded in the module
rather than left to be discovered.

### 20.2 Owner is a column, never a path

`store_path` does not contain the owner id, and a test asserts it. That is the whole cost of keeping
sharing (§19.6) a new table rather than a data migration, and it is paid now because it is free now.

### 20.3 One answer-site for "who is asking"

`api/identity.py` is a single dependency returning an opaque owner id. Three modes:

| `PHYLODELTA_AUTH` | behaviour |
|---|---|
| `none` (default) | everything belongs to one fixed owner — what the current single-operator deployment is |
| `header` | owner read from a header, trusted as given. **Not authentication**; it makes multi-tenant behaviour testable and lets a frontend be built before identity is settled |
| `token` | the intended production mode. **Deliberately unimplemented**: returns 501 |

That last is the decision worth defending. A token verifier that does not verify is worse than an
honest error, because it looks like security — and someone would eventually ship it. The error says
what is undecided and what to do meanwhile.

Because the eight endpoints that need an owner take it from this dependency, resolving §19.5 changes
this module and nothing else.

### 20.4 `/datasets` is answered from the database, not a directory walk

It now lists **an owner's** datasets. That also retires the cost noted in §18.3: the endpoint was
rebuilding the catalogue per request by scanning directories and decoding every tree's leaf labels
to measure pair overlap — 114 ms cold for three trees, and pairs are quadratic.

A recorded dataset whose store is missing is **skipped, not fatal**. A partial ingest should not
hide every other dataset behind an error; the row's `status` is where that belongs.

### 20.5 A bug this uncovered, which was silently corrupting test isolation

The first version cached one engine globally, and `database_url()` derived from `config.STORE_DIR`.
So `ingest_trees(store_dir=tmp)` wrote **stores to the temporary directory and ownership rows to the
real database**.

Nothing failed. The tests passed — by reading ids from the developer's real database that happened
to match the ones the fixture had just built. The symptom would have arrived much later, as a test
run that quietly mutated real data.

The fix makes the invariant structural rather than remembered: **engines are cached by URL**, so
pointing at another store yields another database, and `using_store()` scopes the offline commands
so stores and their ownership rows land together. Both are asserted:
`test_pointing_at_another_store_yields_another_database` and
`test_the_database_lives_beside_the_store_it_describes`.

The general shape is worth noting, because it recurs: *a cache keyed by nothing is a cache keyed by
the first caller.*

## 21. The upload unit is a comparison, not a dataset

*User, 2026-09-23: "a single upload with both trees and respective metadata (typing data)".*

### 21.1 What that decides

```
POST /api/v1/comparisons            (multipart)
  left_tree        required   .nwk
  right_tree       required   .nwk
  left_isolates    optional   .tsv
  right_isolates   optional   .tsv    omit when both trees are one species
  name             optional   display label

-> 202 Accepted   {"id": ..., "status": "pending"}
```

Omitting `right_isolates` means the left file covers both, which handles same-species and
cross-species uploads without a mode flag to get wrong. Both are optional because a tree with no
typing data is already a case this backend handles — 3.9% of vibrio leaves and 10.9% of
clostridium's have no isolate rows (§7.5), so "no metadata" is a supported state rather than a
missing input.

### 21.2 Consequences

**The `Comparison` row exists from the moment of upload**, in `pending`. A client has something to
poll before anything has been computed, and the id it is given at upload is the id it keeps.

**One transaction, or none.** A half-ingested bundle is useless: a comparison needs both trees, and
a tree without its pair cannot be compared with anything. So the bundle lands whole or leaves
nothing behind, and a failure is a `failed` status with a reason rather than orphaned rows and a
directory of fragments.

**Trees remain individually addressable.** They are *created* as a bundle and owned together, but
`/trees/{id}/slice` still serves one. The bundle is how they arrive, not how they are read.

**Bundles are large.** Two 25 MB Newick files plus two 12 MB TSVs is ~75 MB in one request. nginx is
already at `client_max_body_size 300m`; the backend must **stream to disk rather than buffer**, or a
handful of concurrent uploads exhausts memory. This is the first place where the upload limit
(§19.6, still ours to choose) protects memory rather than just disk.

### 21.3 What this model gives up, deliberately

Comparing A with C later means **re-uploading A**. There is no library of previously uploaded trees
to pair from.

That is a real cost — duplicate storage, duplicate ingestion — and it is the right trade for a tool
whose session is "here are my two trees". Recorded so it is understood as a choice. Reversing it
means allowing a comparison to reference existing dataset ids instead of files, which the model
already permits: `Comparison` holds two dataset ids and does not care how they arrived.

## 22. Every data endpoint is owner-scoped

*Code: `api/access.py`. Second step of §19. 347 tests pass.*

**8 of 10 endpoints now require an owner.** The two that do not — `/health` and `/metrics` — serve
nothing owned, and a test asserts that the set of unscoped endpoints is exactly those two.

### 22.1 Two properties the checks are shaped around

**"Not yours" and "does not exist" return the same 404, with the same code.** Distinguishing them
would let anyone discover which ids exist by probing, which is a disclosure even when the data
behind them stays unreachable. Asserted directly:
`test_a_strangers_404_is_indistinguishable_from_a_missing_one`.

**Errors do not enumerate what exists.** The isolate 404 used to list the available species —
genuinely helpful when there was one operator, and a leak once datasets are owned. It now points at
`/datasets`, which answers the same question scoped to the caller. The test that asserted the old
behaviour was rewritten to assert the new one, and a broader test checks that no error mentions
another owner's data.

Ownership is also checked **before the store is opened**: a reader builds memory maps and decodes
labels, and doing that for a dataset the caller cannot have is both wasted and a way to tell the two
404s apart by timing.

### 22.2 A comparison is owned by owning both its trees

A pair id names two datasets, so `pair_or_404` checks the caller owns **both**, rather than trusting
the comparison's own row. A comparison should not outlive access to the trees it was computed from.

### 22.3 One endpoint was missed, and an audit caught it

Threading the dependency through seven endpoints by hand missed
`/api/v1/comparisons/{pair_id}/slice` — it kept serving any pair to anyone. Reading the diff did not
show it; enumerating the OpenAPI document and asking which operations lacked the owner parameter
did, immediately.

That check is now a test — `test_every_data_endpoint_declares_an_owner` — so the next endpoint added
without scoping fails the suite rather than shipping. **An authorisation model enforced by
remembering to apply it is not a model.**

### 22.4 What the tests establish

Beyond the unit checks, the same four endpoints are exercised twice over a real store: once as the
owner, expecting 200, and once as a stranger, expecting 404. Parametrised, so adding an endpoint to
the list covers both directions.

The fixture builds its own store with trees **and** isolates rather than reusing the session-scoped
one, because adding isolate data there would change what unrelated tests see.

---

## 23. Receiving a bundle: 202, streamed, whole or not at all

§21 settled *what* an upload is — two trees and their typing data in one request, because a
comparison is the unit the user is asking for. This section is what implementing it decided.

### 23.1 The request receives; it does not compute

`POST /api/v1/comparisons` does three things: take the bytes, check they are plausible, write a
`pending` row. It returns **202 Accepted**, which is the status code that means exactly that.

It cannot do more. Ingesting a 500k-node tree and building its correspondence is seconds to minutes
(§15) — 38 s for the largest pair measured, after threading. That is not work to do while a
connection is held open and a proxy's read timeout runs down. The alternative, ingesting
synchronously because *parsing alone* is fast (5–8 ms), was rejected: it would make the request
duration depend on the input size, so the endpoint would work in testing and time out in use.

What makes 202 safe is a property that already existed: **`dataset_for` serves only `ready` rows.**
An uploaded tree is `pending` until a job has actually written its store, so there is no window in
which a half-built store can be read as though it were finished. This is asserted rather than
assumed — `test_an_uploaded_tree_is_not_servable_until_a_job_has_run` checks that the tree, its
slice and its comparison all 404 immediately after a successful upload.

### 23.2 Streaming, and what it was measured against

Files are copied to disk in 1 MB chunks and the size limit is enforced **during** the copy, so an
oversized upload is refused before it has been written in full rather than after.

The endpoint is deliberately `def`, not `async def`. Reading an upload is blocking file I/O, and
FastAPI runs a sync endpoint on a threadpool; in an `async def` the same reads would stall the event
loop for every other request in the process. With 75 MB bundles that is not a subtlety.

Measured, because "it streams" is the kind of claim that is easy to assert and easy to get wrong —
six concurrent uploads of a 44 MB bundle (two 18 MB trees and an 8 MB table), throttled so they
overlap:

| | |
|---|---|
| baseline RSS | 27 MB |
| peak RSS, six uploads in flight | **27 MB** |
| request body concurrently in transit | 264 MB |
| all six accepted | 202, 4.5 s each, 265 MB written |

Memory did not move. Buffering would have shown ~264 MB.

### 23.3 Validation is cheap at the door and thorough in the job

The endpoint checks that a tree file is non-empty and begins `(` and ends `;`, and that a table has
a tab-separated header — reading 4 KB from each end rather than the whole file. That catches the
common mistake (the wrong file) immediately, with an error naming the field at fault.

It does **not** parse. Full parsing belongs to the job, where a failure becomes a recorded `failed`
status with a reason. Parsing in the request would put a 25 MB parse in the path of a response and
still not remove the need for the job to handle failure — so it would buy a slightly better error
message at the cost of the thing 23.1 is for.

### 23.4 A bundle is whole or it is absent

Three separate places, because the upload has three ways to half-succeed:

* **On disk** — any refusal removes the whole bundle directory, so a rejected upload leaves no
  fragments for a later job to find and mistake for work.
* **In the database** — the two datasets and the comparison are written in one transaction. A
  comparison referring to a dataset that is not there is not a state anything knows how to read, and
  the foreign keys would refuse it anyway.
* **Between the two** — if the database write fails after the bytes have landed, the bytes are
  removed. An orphaned bundle is unreachable by any owner and unclaimable by any job.

A `bundle.json` manifest is written last, and atomically. So a directory with a manifest is a
complete bundle and one without is debris from an interrupted upload — which is what makes orphan
cleanup possible without consulting the database.

### 23.5 The comparison id is the pair id

`Comparison.id` is `{left_id}__{right_id}`, which is the pair id the comparison endpoints already
use. One identifier addresses a comparison everywhere rather than an upload id that must be
translated into a pair id, which is a mapping to keep and a place for the two to disagree.

Dataset ids are generated, not derived from filenames: two users uploading `tree.nwk` must not
collide, and a name is not an identity. Asserted both ways — two uploads of the same bytes by one
owner are two comparisons, and two owners uploading the same filename do not collide.

`display_name` sits on the comparison row rather than being read through a relationship from either
dataset. The user names the comparison, not the trees; and reaching through a relationship to answer
a status poll is a second query and a lazy load on a detached row — which is precisely the bug that
first appeared here.

### 23.6 Status is polled at one endpoint, and answers for failure

`GET /api/v1/comparisons/{id}/status` answers in every state, including `failed`. A client that can
only observe success has to distinguish "still working" from "never going to work" by waiting. It
carries a `ready` boolean as well as the status string, so a client polls a boolean rather than
matching strings it would have to keep in step with this enum.

It is one endpoint for the bundle rather than one per dataset: a comparison is what was asked for,
and either it is ready or the thing the user wanted is not.

### 23.7 Still open

**Nothing runs the jobs yet.** The rows are written and stay `pending`; the queue is the next piece,
and until it exists an upload is recorded but never processed.

**The size limit is a guess.** 128 MB per file, overridable by `PHYLODELTA_MAX_UPLOAD_BYTES`, set
against a 25 MB tree and a 12 MB table. It is a stop on a mistake filling the disk, not a quota —
quotas and retention are still deferred (§19.6) because they need a deployment to be sized against.

**Isolate datasets get no row at upload.** The species is not known until the tree is parsed, and
the isolate store is registered under `isolates-{species}`; the manifest records which raw file
plays which role until the job can name it properly.

## 24. The queue: a row, a conditional UPDATE, and a lease

§23 left uploads inert — rows written, nothing computing. This is the other half.

### 24.1 The database is the queue

No Redis, no Celery, no RQ. §18 settled that a module owns its storage and that the whole backend
still runs from `uv sync` and a directory; a broker is a second service to install, configure and
keep alive, bought for a workload of a few jobs a minute. The database already holds the row,
already has a transaction, and the same code runs unchanged on SQLite and PostgreSQL — which is the
substitution §18 promised rather than one that only works on the engine we happened to pick.

The comparison row **is** the queue entry. A separate `jobs` table was considered and rejected:
there is exactly one job per comparison with the same lifetime, so a second table buys a join and a
way for the two to disagree about status.

It polls rather than listens. `LISTEN/NOTIFY` would be faster and would only work on PostgreSQL.

### 24.2 Claiming is an UPDATE, not a SELECT

The tempting version reads the oldest pending row and then marks it running. Between those two
statements another worker reads the same row, and both compute the same comparison into the same
directory. Instead:

    UPDATE comparisons SET status='running', ... WHERE id=? AND status='pending'

The database decides. Exactly one worker sees `rowcount == 1`. This needs no `SELECT FOR UPDATE`,
which SQLite does not have — so one implementation is correct on both engines instead of correct on
one and approximated on the other.

Measured rather than argued: **eight worker processes racing for 200 jobs produced 200 claims, 200
distinct, zero duplicates.** Work distributed unevenly (1 to 45 jobs per worker), which is what
pull-based claiming is supposed to do.

### 24.3 A lease, because workers die

A worker killed mid-job — OOM, a container restart — leaves its comparison `running` with a
heartbeat that stops advancing. Without recovery that row is unreachable by every worker forever,
and the user polls a status that never moves.

So a running job refreshes `heartbeat_at` every 30 s from a background thread, and any worker
returns jobs whose heartbeat is older than the 300 s lease. The heartbeat is on a thread because the
work is one long blocking call: correspondence on a 500k-node pair is tens of seconds with the GIL
released, and a lease refreshed only between steps would expire inside the longest step — the one
most likely to be running when a worker dies.

The lease is deliberately much longer than the heartbeat interval. Too short and a slow but healthy
job is stolen and run twice; too long and a dead worker's job waits. The costs are not symmetric —
waiting is a delay, stealing is duplicated work against the same directory — so the margin is wide.

`heartbeat` is scoped to the holder. A worker whose job was reclaimed while it was busy cannot take
it back from whoever owns it now.

**Retries are bounded** (3). A comparison that reliably kills its worker is a property of the job,
not bad luck; past the limit it fails with that stated, rather than cycling forever and blocking the
queue behind it.

### 24.4 The worker runs the same pipeline as the CLI

`ingest_tree_file` and `compute_pair` were **extracted** from the catalogue sweep, not reimplemented.
An uploaded tree and a catalogue tree are the same kind of thing and must be canonicalised, stored
and compared identically. A second ingestion path would be the same code with its own bugs, and the
places they would hide — unary-root suppression, projection back onto stored indices — are exactly
the ones that took longest to get right the first time.

The evidence that it is genuinely the same path: an uploaded vibrio pair scores **RF 6,825** with
**1 leaf dropped to reconcile**, which is the number and the quirk the pipeline has been verified
against throughout.

One deliberate divergence: no shared leaf labels raises `NotComparable`. The CLI sweeps every
combination and most are not meant to be compared, so it skips; a worker computing a pair a user
explicitly uploaded fails the job with the reason. Same condition, different meaning, so it is
raised rather than returned — neither caller can forget it.

Failure is a recorded status. Everything runs inside one `try`; anything raised becomes `failed`
with the reason on the row. A worker that dies instead of recording is handled by the lease above.

### 24.5 Uploaded typing data is keyed by dataset id, not species

The catalogue registers isolate stores under a species name because there is exactly one of each. An
uploaded table belongs to one uploaded tree, and two users may both upload salmonella. The dataset
id is already unique and already owned, so it is the key. The `{species}` path parameter is really
an isolate-set id; for catalogue data that id happens to be a species.

### 24.6 Species is declared, or it is unknown — never assumed

An uploaded tree has no filename convention to read a species from, so the upload takes optional
`left_species` / `right_species`.

When either is absent, `same_species` is **null**, not `true`. This matters more than it looks: the
cross-species caution exists precisely because sequence types are numbered per species, so identical
labels across species match no actual organism. Reporting two undeclared trees as "same species"
would manufacture a reassurance nobody gave. Undeclared pairs get their own caution saying the check
could not be made.

Widening that field caught a real bug: `ComparisonSummary.same_species` was still `bool` and returned
500 on the first undeclared pair.

### 24.7 The pair listing now reads the database

`/api/v1/datasets` used to enumerate every combination of an owner's trees and offer each as an
available pair. That was right while the catalogue was the only source — every combination really
had been computed — and became wrong the moment a comparison was something a user creates:

* it emitted `sorted(left, right)` as the id, while an uploaded pair is stored in upload order, so
  **a client following the listed id got a 404**;
* it advertised comparisons nobody had asked for and nothing had computed;
* it was quadratic in the owner's trees and loaded every tree's full label set per request.

Now a pair is listed because a row says it exists, and the evidence — shared leaves, the caution — is
read back from what the computation recorded rather than re-derived, so the listing cannot disagree
with the result it points at. The sweep records rows too, so "a comparison exists" means one thing
whichever route produced it.

What this gives up: there is no longer a way to see that two owned trees *could* be compared. That
is honest, because there is no endpoint to request such a comparison — uploads arrive as a pair.
Comparing two already-owned datasets is recorded under *Deferred by decision*.

### 24.8 Schema changes over a populated database

`create_schema` was `create_all`, which creates missing tables and silently skips any table that
exists, whatever shape it is in. §18 noted this would need to become a migration "once uploads
exist". They now do, and the symptom arrived on cue: `no such column: comparisons.display_name`
against a database holding somebody's uploaded trees.

It now adds missing **columns** as well as missing tables, taking the value for existing rows from
the model's own default so a migrated row and a freshly inserted one agree. Additive only: a
renamed, retyped or dropped column is refused loudly, because guessing means silent data loss. That
refusal is the marker for adopting Alembic rather than growing this function into it.

### 24.9 Still open

**Nothing cleans up.** A finished bundle's raw upload stays on disk, and a failed one keeps its
trees. Retention is still deferred (§19.6) and now has a concrete first job: delete the upload
directory once a comparison is `ready`.

**Only `rf` runs.** The worker computes `DEFAULT_METRICS`; which metrics an uploaded pair should get
— and whether the uploader chooses — is not decided.

**Progress is binary.** A comparison is pending, running or ready; there is no percentage. For a
500k-node pair that is minutes of "running" with nothing to show.

## 25. Authentication: one interceptor, in front of everything

§20 put identity behind a single dependency so the undecided question — whose tokens? — could be
answered later. This answers it, and changes the shape: identity is now resolved by **middleware,
before routing**, and `token` mode is no longer a 501.

### 25.1 Middleware, not a dependency on each route

The previous design put `Depends(current_owner)` on every endpoint. It worked, and it had one
structural flaw: it is a check you must remember to add.

**That is not hypothetical here.** Threading ownership through seven routes by hand, one was missed
— the comparison slice — and it was found by enumerating the OpenAPI document, not by reading the
diff (§22.3). The design had already failed once in exactly the way this replaces.

Middleware inverts the default. Authentication happens before a route is resolved, so a new
endpoint is protected by existing. Making one public requires naming it in `PUBLIC_PATHS`, which is
a visible list somebody can review, rather than an absence nobody can see.

The test changed with it, and got stronger. The old one inspected the OpenAPI document for an owner
parameter on every operation — a *proxy* for the property, checking that each route remembered to
ask. The new one calls every route the application declares, with no credentials, and requires a
refusal. It tests the property itself, and covers a new endpoint the moment it exists.

**Route handlers contain no authentication logic.** They ask for `owner: str = Depends(current_owner)`
and get an opaque id; `current_owner` now does nothing but read what the middleware already
resolved. It kept its name and its signature, which is why adding all of this touched **no route
handler at all**.

### 25.2 Three interceptors, one seam

An interceptor answers one question — who is this request for? — and returns a `Principal`. Nothing
downstream can tell which one ran.

`mock`
: A hardcoded user, nothing verified. The demo runs with no identity provider and no configuration.

`header`
: Owner id from a trusted header. Not authentication either, but the mock has exactly one user and
some properties only appear with two — that a dataset is invisible to a non-owner cannot be shown
with a single identity.

`jwt`
: The real one. Verifies a signed bearer token, RS256 against a provider's JWKS or HS256 against a
shared secret.

**Integrating with PHYLOViZ is writing a fourth and selecting it.** No route, no service, no model
changes. A test asserts that directly: two different interceptors, the same endpoint, identical
response shape, only the identity differing.

### 25.3 The mock is opt-in and loud

A mock that verifies nothing is the most dangerous component here, because it works perfectly. Three
things keep it visible:

* it is **never chosen implicitly** — an unrecognised `PHYLODELTA_AUTH` is a startup failure, not a
  fallback to mock;
* the service **logs a warning at startup** naming the user every request will become;
* the principal carries `mock: true`, surfaced at `GET /api/v1/me`, so a client can say "demo mode"
  rather than presenting a hardcoded user as signed in.

The mock's subject is `local` — the same owner the offline pipeline attributes what it builds to, so
a catalogue from `build-all` is readable in the demo and no existing row was orphaned.

### 25.4 What the JWT interceptor refuses, and why each one matters

A JWT check that passes everything looks identical to one that works. Each of these is tested:

**Algorithms are pinned by configuration, never read from the token.** The classic attack: an RS256
deployment publishes its public key, an attacker re-signs a token as HS256 using that public key as
the HMAC secret, and a verifier trusting the token's own `alg` accepts the forgery. `alg: none` is
refused for the same reason. Proving this needed the forged token assembled by hand — PyJWT refuses
to *encode* it, which is good defence but would have meant the test never reached our verifier.

**The issuer is configured, never discovered.** Keys are fetched only from the JWKS URL this server
was given. Following an issuer named inside an unverified token would let the token nominate who
vouches for it, and would turn this into a request-forgery primitive.

**`aud` is required.** A signature proves who minted a token, not who it was minted for. Without an
audience check, any token from the same provider — issued to any other service — would be accepted
here.

**`exp`, `iss` and `sub` are required**, with 30 s of leeway for clock skew.

**Refusals do not say which check failed.** One message for every way a token can be unacceptable,
so a forger does not learn which thing to fix next.

**A short HMAC secret is refused at startup** (RFC 7518 §3.2, 32 bytes). Refused rather than warned:
a warning in a log is not something anybody reads before going live.

Configuration is validated **when the process starts**, not on the first request that needed it to
work. An incomplete JWT setup cannot serve traffic in an undefined auth state.

### 25.5 Owner ids are namespaced by issuer

`Principal.owner_id` is `{issuer}:{subject}`, not `subject`. Two providers can both mint
`sub: "12345"`; without namespacing, adding a second identity provider would silently merge two
people and one would inherit the other's datasets. Unnamespaced when no issuer is configured, which
is what keeps the existing `local` ownership readable rather than orphaning every row on upgrade.

### 25.6 Fail closed

An interceptor that raises an unexpected exception produces a 503, not a request. Failing open would
be the worst available outcome: every route would run, and `current_owner` would be the only thing
between a stranger and somebody's data.

`/health` stays public so an orchestrator can check liveness without credentials; it reports that
the service is up and how deep the queue is, and nothing about anyone's data. `/metrics` — the
metric *plugin* catalogue, not Prometheus — stopped being public. Nothing needs it before signing
in, and "authenticated unless there is a reason" is the default that stays safe as endpoints are
added.

CORS was revisited, as §19's comment required once auth existed. Origins are now configurable and
still default to `*`, which is **not** the hazard it would be with cookies: credentials are bearer
tokens, which a browser never attaches by itself, so a hostile page can reach this API but has
nothing to send. CORS is not what protects the data here — the token is. `allow_credentials` stays
false deliberately; turning it on would mean cookie auth and the CSRF that comes with it.

### 25.7 What this is not

**This is a resource server, not an OAuth provider.** It *validates* tokens an OAuth provider
issued; it does not run the authorization-code flow, hold client secrets, redirect anybody, or
refresh anything. That half belongs to the frontend or to PHYLOViZ. The distinction matters for
planning: "supports Google sign-in" is this plus a frontend that obtains the token.

**Nothing is authorised by scope.** `Principal.scopes` is parsed and carried but no route consults
it. Authorisation here is ownership — `owner_id` on the row — and that is checked in the database.
Scopes would be a second, weaker mechanism for the same question.

**There is no user table, and no revocation.** A token is valid until it expires; there is no
session to end. Short token lifetimes are the mitigation, which is the provider's setting rather
than ours.

## 26. Retention: discard on success, delete on request, no clock

§23 and §24 both ended with the same gap — nothing ever removed anything. Settled with the user
(2026-09-23), now that the deployment is known: **a university VM with a container volume.**

### 26.1 What was actually accumulating

Measured on one real vibrio comparison (17,645 leaves per tree), end to end:

| | |
|---|---|
| `uploads/` — the raw files posted | **9.7 MB** |
| `trees/` — the ingested columnar stores | 1.7 MB |
| `isolates/` | 1.5 MB |
| `pairs/` — correspondence + RF | 640 KB |
| database | 44 KB |
| **total** | **14 MB** |

**69% of a stored comparison was the raw upload**, and it is redundant: the store can regenerate
Newick (`newick_writer.to_newick`, which `materialise` already uses to feed TreeDiff). Keeping it
buys byte-exact provenance of the submission, not the ability to recompute — adding the triplet
metric later needs the *store*, not the original file.

So a successful job discards its bundle. A **failed** job keeps it, because there the original file
is the evidence of what went wrong.

Measured after the change: 14 MB → **4.0 MB** on success, and 272 KB after deletion — which is the
SQLite file and its WAL, with every data directory empty and no rows left.

### 26.2 No expiry clock, and no quota

The user's call, and the right one for this deployment. A comparison lives until somebody deletes
it.

An automatic sweep trades one failure mode for another, and on a single research VM the trade is
bad: unbounded growth is a disk that needs attention, which is visible and recoverable; a timer is a
result vanishing from under the work that was about to cite it, which is neither. Quotas are
recorded under *Deferred by decision* — the user does not need them for the thesis, and sizing one
needs usage that does not exist yet.

That makes `DELETE /api/v1/comparisons/{id}` **the only way data leaves**, which is why it removes
the derived stores and not merely the rows. Deleting the row alone would leave the expensive half on
disk — the exact problem this section exists to fix.

### 26.3 Deletion is owner-scoped, ordered, and does not free shared data

**Same 404 for "not yours" as for "no such id"**, so deleting cannot be used to probe for existence
any more than reading can (§22.1).

**The comparison row goes first**, because the dataset rows carry foreign keys to it; then the
datasets nothing else refers to; then the files. A crash between those steps leaves files with no
rows, which is inert. The opposite order would leave rows pointing at data that is gone, which is
not.

**A tree another comparison still uses is kept.** Today nothing shares a tree — every upload mints
fresh ids — so the check always frees both. It is written as a real reference check anyway, because
the moment comparing two already-owned datasets lands (also deferred), the naive version would
delete the other comparison's data.

### 26.4 Delete wins over a running job

A comparison can be deleted while a worker is computing it; on a 500k-node pair that window is
minutes. Refusing the delete was the simpler option and was rejected — it strands the user behind
their own long job.

Instead the worker re-checks the row after computing and before recording success. If it has gone,
it discards what it built and moves on. Anything else would finish into a comparison nobody can
reach, leaving its stores on disk with nothing referring to them: exactly the orphan this section
is about, created by the code meant to prevent it.

## Findings carried forward

Observations made during milestone 1 that constrain later work.

| Finding | Consequence |
|---|---|
| The vibrio NJ tree is missing **ST 211**; its leaf set is a strict subset of the UPGMA tree's (17,645 vs 17,646). | RF is defined only over a shared leaf set. Milestone 2 must reconcile explicitly — restrict to the intersection — and record which leaves were dropped, rather than let an implementation quietly assume the sets match. |
| Trees are extremely unbalanced (depth 443 and 604 against ~15 balanced). | Fixed-depth chunking cannot work; summarisation must be budget-driven. Measured separately: a depth-4 chunk yields **7–9 nodes** on these trees, not the ~500 a depth-based cache design had assumed. |
| Isolate TSVs are **8.8 MB** (vibrio) and **12 MB** (clostridium) against **1.3 MB** for both vibrio trees — roughly **7×**. | Metadata, not topology, is the dominant payload. It must be served filtered and per-visible-leaf, never shipped whole (milestone 5). |
| Marginal per-key counts cannot answer an AND query. | The isolate store holds **joint tuples**, not per-key histograms. 254 Bangladeshi isolates and 30 human-source isolates says nothing about how many are both. |

---

## Next: the native core

Directed by the user, 2026-09-20, at the close of milestone 6. Three requirements, which are one
piece of work:

1. **Metrics are not to be written in Python** — they belong in a faster language.
2. **The Newick parser likewise.**
3. **Tree preparation must follow the paper's approach** (Branco, Vaz & Francisco 2024, §1.10).

These converge on one native core rather than three efforts — but **not** by wrapping `TreeDiff`.
An initial claim that "TreeDiff already is a C++ Newick parser, a succinct representation and an RF
implementation, so one core satisfies all three" was **too generous and is withdrawn**. What a
source study actually found:

| requirement | what TreeDiff provides |
|---|---|
| Newick parser | **Rewrite, not wrap.** It takes a `FILE*`, **discards every label** after parsing (`strings.clear()`), and the second tree's parse depends on state left by the first — it is structurally a two-tree routine. Its `add_bit` also resizes the bit vector once per parenthesis, making construction **O(n²)**. |
| succinct representation | **The genuinely reusable asset** — as an idea. `bp_support_sada_extended.hpp` is a renamed copy of sdsl's `bp_support_sada` plus ~10 added operations (`rank10`, `select0`, `first_child`, `next_sibling`, `isleaf`, `post_order_select`, `lca`, `cluster_size`, `num_leaves`, `parent2`). These replace this project's binary-lifting LCA and reverse-pass aggregation with succinct queries. |
| RF distance | Maps 1:1 to the Python implementation — the same `count == container_size` test — and `rf_day.cpp` is an independent Day's-algorithm cross-check, mirroring `_shared_by_day`. A good **oracle**. |
| similarity gradient, `corresponds`, BCN | **Absent entirely.** It does not even retain the LCA for non-matching clades, so not even the `|A|/|B|` lower bound survives. All of §3.3 is net-new C++. |
| a succinct **store** | **Absent.** No serialisation anywhere: the representation is rebuilt from Newick on every invocation. Persisting it is entirely this project's work. |

**Licensing is the binding constraint, and it has a clean resolution.** `TreeDiff` is **GPL-3.0**, as
is the `simongog/sdsl-lite` it vendors; this repository is **MIT**. Linking GPLv3 into an MIT project
does not stay MIT — the combined work becomes GPLv3, with source-disclosure obligations on
distribution. That matters more for an eventual PHYLOViZ merge than for a thesis.

**Decision: build against `xxsds/sdsl-lite` (v3), which is BSD-3-Clause and actively maintained**
(last release July 2026, against the GPLv3 original that needed three patches to build here, §2.2).
Verified to contain every primitive the extended header uses: `bp_support_sada.hpp`,
`rank_support_v5`, `select_support_mcl`, `rmq_support`. The ~10 added operations are reimplemented
here against stock v3 support rather than vendoring the GPLv3 header; they are thin wrappers over
primitives, and the study above records exactly what each one computes.

`TreeDiff` remains in use as an **external-process conformance oracle**, which creates no combined
work and therefore no licensing obligation. That is already how `native/build_treediff.sh` uses it.

**Two hazards found in it, recorded because they bear on trusting the oracle.** A label present in
tree 2 but not tree 1 is default-inserted as `0` by an `unordered_map` lookup and silently maps to
the root — so a mismatched leaf set may give a wrong answer rather than the abort seen in §2.4.
And the parser does not skip whitespace, so a pretty-printed Newick is parsed **wrongly and
silently**; the datasets here are single-line, which is luck rather than design.

**Expected shape of the work**, in the order that keeps a working system at every step:

* a pybind11 module over **BSD sdsl-lite v3**, with the ~10 tree operations reimplemented from the
  primitives rather than vendored
* a **new** Newick parser in C++: string input, labels and branch lengths retained, one tree at a
  time, amortised bit-vector growth (not the O(n²) append), whitespace handled
* **serialisation** of the succinct representation, which has no precedent to copy — the store
  behind `TreeReader`, with the columnar store retained as the reference implementation
* the **correspondence layer** — Jaccard gradient and best-corresponding-node — in C++, in-process
  (§9.1, §9.2). This is net-new code, it is 12.6 s of the 13 s a pair currently takes, and it is
  shared by every metric, so it is written once and belongs on the native side of the boundary
* **contract change first**: split `MetricResult` so correspondence is separate from a metric's
  scalars (§9.1). Doing this before the first C++ metric is written is the point — afterwards the
  coupling is baked into a binary
* RF in C++ as a **subprocess** metric, checked against the Python implementation's 6,825; the
  Python one stays registered as oracle and fallback
* **Triplet** as the second metric (§9.4) — `trip_sht` already runs on the real pair in 2.3 s, so it
  is mostly a matter of wiring it to the subprocess contract
* measured throughout: space (§2.1 predicts ~4x like-for-like) and time, as a thesis result in its
  own right, replicating the paper's reported trade-off on a dataset it did not use

**Open risk**, worth retiring early: that sdsl-lite v3 builds and binds cleanly here. The GPLv3
original needed three patches and is unmaintained (§2.2); v3 is the reason to expect better, not a
guarantee of it. This is the first thing to test, before any porting.

---

## Deferred by decision

Designed for, not built. Recorded so the reasoning survives and so the absence is not read as an
oversight.

**A ranked-list endpoint for divergent clades** — `GET /api/comparisons/{pair}/divergent`, returning
the most-changed clades with their node ids, sizes and similarity. Held pending the frontend's
interaction model (user, 2026-09-20).

The gap it would close is real and measured. `order=difference` (§6) *guides a descent*; it does not
enumerate. Recall of the 50 most-diverged substantial clades is 14% at a budget of 100 — seven times
`order=size`, but still missing most of them. That is structural rather than a tuning problem: these
trees are 443 levels deep, so reaching a specific clade costs budget on its entire ancestor chain,
and a greedy descent follows one path at a time.

Ordering supports **browsing**; a ranked list supports **jumping** — the client shows the list, and
clicking an entry issues `slice(root=<id>)` directly, paying nothing for the path. The two are
complementary, and the list is the one that actually answers "where do these trees disagree". It is
cheap to add: the similarity column is already stored, so it is an `argsort` plus a size filter.

**Measuring Phylo.io's BCN approximation against this project's exact one** — quantifying how often
MinHash/LSH retrieval of ten candidates misses the true best corresponding node, and by how much.
The exact search here is ground truth for it. Method, and three ways to get it wrong, are recorded
under *References and provenance → What is adopted from Phylo.io*. Waits on the new frontend, like
all comparison work.

**A comment-density pass over the whole codebase, once the project is done** (user, 2026-09-23).

The comments are currently written for someone building the thing — they carry the reasoning, the
rejected alternative and the measurement that settled it, because that is what this stage of the
work needed and because much of it fed this document. That density is a working artefact, not a
house style, and it should not be what a reader inherits.

The pass is deferred rather than done now for one reason: the reasoning is still live. A comment
explaining why correspondence is computed for every pair is load-bearing while that is still being
revisited, and becomes noise once it is settled. Stripping it early would mean re-deriving it.

**The criterion, so the pass is mechanical.** Keep a comment when it says something the code cannot:

* a **non-obvious constraint** — 1-based versus 0-based indexing against TreeDiff, `find_close(i) + 1`
  for `num_leaves`, why an inclusive bound is required where a strict one looks natural
* a **measured number** that justifies a choice — 41 KB positional against 236 KB keyed, 27 MB RSS
  under 264 MB of upload
* a **security or correctness property** that is invisible locally — why "not yours" and "does not
  exist" return the same 404, why ownership is checked before the store is opened
* a **pointer to the record** — a `§n` reference, so the long form is findable without being inlined

Remove a comment when it restates the code, narrates the obvious sequence of a function, explains a
decision this document already holds in full, or is addressed to whoever is writing it rather than
whoever is reading it. Module docstrings should survive as orientation; the running commentary
inside functions is where most of the cut is.

The `§n` references make this safe: the reasoning has somewhere to live that is not the source file,
so cutting a comment loses nothing. That is what this document is for, and the pass is partly a test
of whether it has been doing its job.

**Comparing two datasets the user already owns** — `POST /api/v1/comparisons` takes a bundle of
files; there is no way to say "compare these two ids". A user who uploads pair A and pair B cannot
compare A's left tree against B's. §24.7 removed the listing that implied otherwise, since it
advertised pairs nobody could request. The pieces are all there — `compute_pair` takes two stored
ids — so this is an endpoint and a queue entry, not new machinery.

**Quotas and disk limits** — nothing bounds how much one owner may store. Deliberate (user,
2026-09-23): not needed for the thesis, and sizing a quota needs usage that does not exist yet. The
pieces it would attach to are in place — `datasets_for` gives an owner's holdings, and
`retention.remove_comparison` reports bytes freed, so a running total is a query rather than new
bookkeeping.

**Other deferrals** carried from earlier sections: the succinct representation (§2.1, after
correctness); the subprocess metric kind (§3.5, contract defined, not wired); a crosswalk between
label spaces for trees typed under different schemes (§1.7, `label_match` field reserved);
scoped/dynamic per-subtree metrics; and the `trueLeafCount` change in the rendering library, whose
wire half arrived in §4.3.

---

## 27. `GET /trees/{id}/ancestor`: the one thing a panel cannot work out

Added (2026-09-24) after "find this leaf in the other tree" put a single dot on screen.

### 27.1 Why a client cannot answer it

A leaf's cross-tree match is **exact** — leaves correspond by label, so it is the same sequence type
— and therefore the match is itself a leaf. A panel rooted at a leaf shows one dot and no context,
which is the opposite of what the action is for.

Widening has to happen on the receiving side, and that side cannot do it. Each panel holds its tree
only as **the slice it asked for** (§4). A node arriving from the other panel is by construction
outside that slice, so its size, its parent and its ancestors are all unknown locally. This is not
an oversight in the client; it is the direct consequence of never shipping whole trees, and it is
the first place that trade-off has cost something.

An earlier client-side attempt asked correspondence about the leaf's **parent clade** instead,
hoping a clade would be large enough. It was wrong twice. A clade corresponds by best overlap,
which is an approximation, so it traded an exact answer for a guess; and it resolved to a tip
anyway, because Jaccard gives a two-leaf cherry `{a, b}` an overlap of 0.5 with the bare leaf
`{a}`, which nothing beats where the trees disagree. Measured over 400 sampled leaves of
vibrio-nj vs vibrio-upgma, that rule returned a single leaf **400 times out of 400**.

### 27.2 A ceiling on the climb, tried and withdrawn

Climbing to the first ancestor holding 20 leaves looks sufficient and appears not to be, because
branch lengths do not make topology. On the ladder-shaped clades UPGMA produces, a tip's ancestors
step

```
1 leaf  ->  2 leaves  ->  3,311 leaves
```

so the smallest ancestor meeting a floor of 20 is a tenth of the tree — at which point the slice
budget summarises it and the tip that was asked about **disappears behind a wedge**.

The first answer was a second bound, `max_leaves`, set by the caller to its own leaf budget, on the
reasoning that a subtree which fits is drawn tip for tip. **This was wrong, and it shipped.** It
overrode `min_leaves`, so on exactly the ladders that motivated it the climb stopped at the two-leaf
step. Measured over all 17,645 leaves of vibrio-nj -> vibrio-upgma with a 60-leaf ceiling:

| widened subtree | jumps | |
|---|---|---|
| 2 leaves | 428 | 2.43% |
| 3–5 leaves | 898 | 5.09% |
| 6–19 leaves | 3,433 | 19.46% |
| 20–60 leaves | 11,847 | 67.14% |
| over 60 | 1,039 | 5.89% |

**27% landed below the floor the endpoint exists to guarantee**, and 2.4% on two dots and a line —
which says the leaf exists and nothing about where it sits. The user reported it from the screen
before the sweep did, because the sweep only asserted `leaves > 1`: a test written to the bug it had
just seen rather than to the promise being made.

The ceiling is removed. Keeping the target drawn is `keep`'s job on the slice (§27.4), and `keep`
works at any size, so the climb is free to go as wide as the floor requires. Two mechanisms for one
problem, and the weaker one silently won.

End to end on the pair that showed the original bug (clostridium leaf `2368` -> vibrio): the match
is vibrio leaf `2368`, widened to a 20-leaf clade, drawn as 20 of 20 leaves with **zero wedges**,
with the target leaf among them.

### 27.3 Cost

A handful of integers off the memory-mapped `parent` and `leaf_count` columns — no topology is
built and nothing is sent but four numbers. The response reports `climbed` and `reached_root` so a
caller is told when the climb ran out of tree rather than being handed a number that silently
missed the request.

One bug found by the test rather than by reasoning: the `parent` column is **unsigned**, so the
root's `-1` arrives as `4,294,967,295`. A `parent < 0` guard never fires and the climb walks off
the end of the column. The bound is `0 <= parent < n_nodes`.

### 27.4 `keep`: the widened view must still contain what was asked for

`/ancestor` cannot always stay under its ceiling. When a tip's only parent is
enormous the first step is unbounded (§27.2), and the widened root is then large
enough that the slice budget summarises the target back into a wedge — the jump
answers "roughly here" instead of "there it is". Measured over all 17,645 leaves
of vibrio-nj -> vibrio-upgma: **5.89% widened past the 60-leaf ceiling, 1.42%
past a thousand**, one of them to the whole tree.

So `GET /trees/{id}/slice` takes **`keep`**: one node that must be drawn as
itself. The summariser sorts the child holding it ahead of all others, so the
path down is expanded before the budget is spent elsewhere. Nothing is added to
its allotment — see below.

**A bug this nearly shipped.** The first version also topped the keep-child's
allotment up to 2, on the reasoning that two units are the difference between a
wedge and an expansion. That unit comes out of the one held back for each
sibling still to come, so the loop ran out early, dropped those siblings
entirely rather than folding them into wedges, and **lost their leaves** — 1,127
of 17,646 in the first test that ran. Sorting first is the whole mechanism:
going first means `remaining` is still untouched, which is exactly when
`remaining - siblings_left` is largest. The conservation assertion caught it,
which is the argument for asserting conservation on every slice rather than
trusting the allocator.

`keep` is best-effort and costs one tip per sibling passed on the way down, so a
node deeper than the budget stays behind a wedge — with 60 tips, a 60-deep path
spends them all before arriving. Real jumps climb one level, so this is a limit
rather than a problem, and leaves conserve either way.

### 27.4b A silent fallback hid the whole thing

The jump's error handling was `.catch(() => focus(storedId))` — on any failure, root at the bare
node. That is the single dot the endpoint exists to remove, produced deliberately, with nothing on
screen to say a call had failed.

It went unnoticed because the running dev server had been started **before** `/ancestor` existed and
was not launched with `--reload`. Every jump 404'd. The tests passed, the sweep passed on all three
pairs, and the screen kept showing one dot — the failure mode was indistinguishable from the bug
being fixed, which is exactly what made it invisible.

A wrong view that looks deliberate is worse than an error. The view no longer moves on failure and
the panel says why. `test_support/renderHook` gained an async `act` so the case is actually covered:
widening fails, the path stays empty, an error is set.

### 27.4c Saying which one it is

Landing in the right neighbourhood is only half of "find this leaf in the other tree". Among twenty
tips, one of which is the answer, the panel still has to say which — so the arrival is signalled
three ways, none of which is a legend:

The node **flashes five times** in red — deliberately outside the divergence ramp (blue → cyan →
green → yellow) so it cannot be read as a value on the scale — and is dark between flashes, because
what draws the eye is the change rather than the colour. `flashes` and `flashInterval` are
comparison options, so the count is the caller's decision rather than a constant in the library.

**Nothing is said when it works.** A successful jump is already visible — the panel moved and the
leaf flashed — so a line naming it is noise on a screen that already holds two trees. Only failure
speaks, as a modal (`ui/Notice`), because a jump that does not happen leaves the panel it would have
changed looking perfectly fine: a quiet note beside it reads as decoration rather than as the answer
to what was just clicked. That is also why it is `jumpError` on `SideState` and not `error`, which
describes the slice on screen.

**The signal is consumed; the state is not.** Two earlier versions were wrong here:

1. A permanent marker, painted by a node reducer from `arrivedAt`. It went on claiming the node was
   special for as long as the panel stayed open, when what happened is that the view came here once,
   and it competed with the divergence colouring for the same attention.
2. Flashing whenever `arrivedAt` was set. `arrivedAt` *must* persist — it is the slice's `keep`, so
   the node stays drawn on any later re-slice of the same root — but the signal must not. After a
   second jump the other way **both panels lit up**, the one just navigated to and the one still
   holding the previous arrival, and every window resize replayed it.

So the view records each arrival as spent once flashed, and resets that when the panel navigates
away, so the same leaf arriving again is a new arrival.

**The library's `highlightByKey` had to grow an option.** It centred *and* zoomed to `ratio` 0.7,
which on a freshly fitted twenty-leaf subtree crops the surrounding structure — the exact context
the widening exists to provide. `highlightByKey(key, { center: false })` blinks in place; the panel
was just re-rooted around the node, so it is on screen already.

### 27.4d The third colour, and the leaf that is simply not there

A user asked why some branches were black. They were right to ask, and nothing was wrong with the
drawing: a leaf reconciliation dropped has **no counterpart**, so it has no similarity, and the
comparison operator leaves it exactly as the tree drew it. That rule is deliberate and tested —
absent data must look absent, never a fabricated mid-scale colour. Verified on the pair in question:
all eleven black leaves had `similarity = NaN` and were absent from the other tree; all nine
coloured ones scored 1.000 and were present.

What was wrong is that **the legend ran "identical → diverged" and never mentioned black**, leaving
a picture with three appearances and a key for two. Across species that is most of a panel:
clostridium-upgma against vibrio-nj shares 17,489 of 27,962 leaves, so 10,473 are drawn this way.

So those branches are drawn **red** (`absentColor`), and the gradient legend gains a matching
`absentLabel` row, as does the export's colour key. Red rather than the tree's own black: black is
also what an unstyled branch looks like, so "no data" and "nothing has happened here" read as the
same picture, and the whole point is that these two are different.

The row is shown **whenever the option is set** — in both panels, always, exactly like the gradient
beside it. A first version showed it only when such a branch was in view, which is wrong for the
same reason a disappearing axis would be: a key that comes and goes as you navigate is a key you
cannot learn, and its absence reads as "none here" only to someone who already knows the rule.
(That version also had to detect the condition, which it did by walking the layout rather than by
noticing absences while colouring — a reducer runs only when the renderer asks it to, so a legend
driven by that side effect describes whatever happened to be drawn last. Removing the condition
removed the problem.)

Those branches are drawn at the **same width** as branches that do carry a value. Two different
answers, not two degrees of confidence: a thinner line would read as a weaker version of the same
statement rather than a different kind of one.

Legend and colour-key text is sentence case throughout: **Identical**, **Diverged**, **Not in the
other tree**.

**Red forced the flash to move.** A located node blinked in `#ff0000`, which now means "not in the
other tree" on the same screen — a momentary *look here* sharing a hue with a permanent claim about
a branch. The blink colour became an option (`highlightColor`) and the app sets magenta `#d400ff`,
the one part of the wheel nothing else in the view claims: the ramp runs blue → cyan → green →
yellow and absence is red.

The same finding renamed a legend entry in the export. "diverged — no counterpart in the other tree"
was wrong twice over once black exists, since *that* is what having no counterpart looks like; the
yellow end means "shares few leaves with its best match".

**And the menu now answers instead of greying out.** "Find this leaf in the other tree" stays
clickable for a leaf with no counterpart and reports it: *not in the other tree* is the result of
asking, not a reason the question cannot be put, and a disabled item leaves the reader to work out
which of the two it is. A clade is still refused outright, because there the action is the wrong
tool (§27.1).

### 27.5 The sweep

`tools/validate_navigation.py` drives the real route functions — not a
reimplementation — over a whole pair:

* **Navigation.** Expand every wedge from the root until the tree is exhausted.
  Asserts each slice is rooted where it was asked, that its arrays agree in
  length, that every returned node lies inside the requested interval, that
  leaves conserve, and that the union over the whole walk is **exactly** the
  tree's leaf set: no leaf unreachable, none drawn twice, no internal node drawn
  as a leaf.
* **Every leaf, both directions.** For each leaf: the counterpart is in range,
  its **label matches**, the widened root is a true ancestor of it by interval
  containment, the reported size matches the tree, it holds **at least
  `min_leaves`** unless the climb reached the root, and slicing there actually
  **draws the target as itself**. That floor check replaced a `> 1` that let
  two-leaf landings pass — the assertion has to be the promise, not the last
  bug. Leaves without a counterpart are cross-checked
  against reconciliation's dropped count.

Result over all three pairs — 669 navigation slices covering 63,253 leaves, and
**every leaf of every tree jumped in both directions**:

| pair | jumps checked | mislabelled | under the floor | target not drawn | median landing |
|---|---|---|---|---|---|
| vibrio-nj ↔ vibrio-upgma | 35,290 | 0 | 0 | 0 | 35 / 29 leaves |
| clostridium-upgma ↔ vibrio-upgma | 34,980 | 0 | 0 | 0 | 35 / 51 leaves |
| clostridium-upgma ↔ vibrio-nj | 34,978 | 0 | 0 | 0 | 29 / 51 leaves |

Unmatched leaves equal reconciliation's dropped count exactly in all six
directions (1, 156, 10,472, 10,473 …), so no leaf silently loses its
counterpart.

**One false alarm worth recording**, because it is the same trap as §27.3 and
caught a third time: the sweep initially read `corresponds` straight from the
store and tested `target < 0`. The column is unsigned, so "no counterpart"
(`0xFFFFFFFF`) read as a valid node id. The API already translates it to `null`
and the client already skips nulls, so nothing was wrong with the product — but
an unsigned sentinel has now produced a false negative, a real bug and a broken
test in three separate places. Anything reading these columns directly must
translate first.

---

## 28. The library: what belongs in it, and what does not

Moved here from `code/lib/README.md`, which keeps the module map and the API surface. The *why*
lives in one file; the *what* lives beside the code it describes.

### 28.1 The boundary

`phylo-tree-viewer` is a standalone npm package and is **backend-agnostic**. Nothing under its
`src/` imports anything outside it, which is what makes it publishable and is checked rather than
asserted. The dependency arrow points one way: app → lib.

**Data in, not fetch.** The library takes trees, isolate counts and colours through options and
setters and never makes a request. That is what lets the same package serve `lib_demo`, which reads
static files, and `web`, which reads a slicing API — two consumers whose data sources have nothing
in common.

**Composable operators.** Each interaction is an operator in its own file, talking to the viewer
only through its public surface: events, the node- and edge-reducer pipelines, the collapse hook and
the right-reserve hook. Any subset attaches to any viewer, and two viewers stay independent. This is
what made the comparison view possible without a "comparison mode" inside the viewer.

**Structure-preserving transforms.** Sibling ordering and reflection change the drawing, never the
topology, the parent/child links or the branch lengths. A displayed tree is always a legal
representation of the input.

### 28.2 What the server pushed back into the library

Three things arrived from the frontend and were deliberately pushed down into the library, each for
the same reason: they are statements about *how a comparison is presented*, and the library is what
presents it.

* **`trueLeafCount`** (§4.3). A server-summarised clade has no children to count, so walking it
  reports 1 and every wedge draws at minimum size regardless of whether it hides ten leaves or ten
  thousand. The consumer supplies the real count.
* **Honouring an incoming `collapsed` flag.** `prepareTree` decided collapse with a predicate, so a
  server that had already decided which clades were wedges could not say so and they rendered as
  leaves.
* **The comparison report** (`export/comparison_report.ts`). The frontend built it first. It was
  moved because the panels, the gradient, the wedges and the bars are all drawn here: a report
  assembled elsewhere describes a picture it cannot see. What stayed in the app is the one thing the
  library must not know — the shape of this backend's JSON.

### 28.3 Export: one layout, three files

`renderReport` produces HTML. The PNG and PDF are **rasterised from that same HTML** rather than
laid out again, through an SVG `foreignObject` — the technique `snapshot.ts` already uses for the
panel overlays. Re-implementing the layout per format is how two of the three quietly stop matching
the third.

The PDF is written by hand rather than with a library: a page per slice, each carrying a JPEG,
because a PDF embeds JPEG verbatim (`DCTDecode`) while a PNG would have to be decoded and
re-deflated. That is where a hand-rolled writer would stop being worth it.

Two bugs shipped in the first version of this and were found by opening the file, not by a test:

1. The report's CSS was scoped to `body`, and a `foreignObject`'s root is a plain `div`, so **none
   of it applied** — the PDF came out in the browser's default serif with its text against the left
   edge. The rules are scoped to `.report` now, which the `body` also carries.
2. Height was measured before the embedded images had decoded, so the figures measured zero, the
   document was rasterised taller than the canvas, and the last third was **cut off**. `measure`
   awaits `img.decode()` first.

Both are the same lesson: a rasteriser is only as correct as the layout it measures, and neither
failure is visible from inside the code.

---

## 29. The frontend: a thin seam over a slicing API

`code/web` is React 19 + Vite. It owns navigation and menus; the library owns rendering. The seam is
narrow on purpose.

### 29.1 One `createComparison`, then `setTree`

The two panels are built **once**. Navigation replaces their contents rather than rebuilding them,
because tearing down and re-creating two Sigma renderers on every expansion is expensive and loses
the camera. Providers are read through refs rather than captured, since the library keeps the
functions it was given at construction and a closure over the first slice would serve it forever.

### 29.2 The budget is a property of the viewport

How many leaves to ask for is computed from the panel's measured height at ~14px a leaf, quantised
to 25 so a layout settling from 600px to 577px does not cost a second request. It returns **zero**
before measurement rather than a placeholder, so a panel makes one request instead of two.

This replaced a fixed budget of 400, which in a 700px panel is 1.7px a leaf: the terminals fused
into a solid black bar. Asking the server for more than the client can draw is this project's
central failure in miniature — the request succeeds, the bytes arrive, and the picture is worse.

### 29.3 The URL names what is on screen

Comparison, both navigation paths, and every view option are in the hash. Refreshing a view of two
17,645-leaf trees must come back to it, and a link that does not carry the presentation would show
the recipient a different figure from the one being described. Only non-defaults are written, so old
links still open. `replaceState`, not a hash assignment, or Back would mean "undo one expand".

Keeping the options in `App`'s state while the navigation lived in the URL is exactly how the two
came to disagree — a refresh restored the trees with the colouring reset under them.

### 29.4 Menus answer, they do not grey out

A context menu item is **omitted** when it could never apply where the menu was opened, and **shown
with a reason** when it applies but cannot run. The one deliberate exception is "Find this leaf in
the other tree" for a leaf with no counterpart: *not in the other tree* is the result of asking, not
a reason the question cannot be put, so it stays clickable and reports (§27.4d). A clade is refused
outright, because there the action is the wrong tool — a clade corresponds by best overlap, and
offering to jump presents a guess as a location.

### 29.5 What the panels are told, and what they work out

The frontend never invents a comparison value. `similarity` is carried **on the node** rather than
looked up by id, because a stored id is a pre-order index *within one tree* and the two trees'
ranges overlap — a lookup painted one panel with the other tree's numbers. Divergence is `1 −
similarity`, and feeding the raw similarity to a scale labelled identical → diverged drew every
shared clade at the diverged end.

### 29.6 Robustness, measured rather than assumed

Two tools, deliberately different in kind:

* `code/server/tools/validate_navigation.py` — expands every wedge of a tree until it is exhausted
  and jumps **every leaf in both directions**, checking one invariant exhaustively against the real
  route functions (§27.5).
* `code/server/tools/simulate_usage.py` — walks the API over HTTP the way the frontend does, through
  the middleware, validation and JSON serialisation, and spends most of its effort on what a client
  can get *wrong*: budget and root boundaries, eight refusal cases including path traversal in a
  tree id, a real upload through to ready and sliceable, three bad uploads, delete and
  double-delete, and 36 concurrent slices. **54 checks, 0 failures.**

The happy path is covered by the unit suites; a server is robust to the extent that it says no
clearly, which is what the second tool measures.


---

## 30. The metric is the uploader's choice, and it lives on the row

Asked for (2026-09-24) after the frontend shipped: the upload had no say in which metric was
computed, so every comparison got `rf`.

### 30.1 The pipeline already supported it; nothing exposed it

`build_pair` and `run_comparison` have always taken a list, and §9 had already established why
several are cheap: **the reconciliation and the clade correspondence are done once per pair and
every metric runs against them**, so a second metric costs only its own work rather than another
best-match search. What was missing was a way for the request to say so.

### 30.2 On the comparison row, not on the worker

`run_comparison` took its metrics from a **worker** argument, which the CLI supplied. That is the
wrong place, and quietly so: a worker flag applies to whatever job the worker happens to claim, so
two comparisons uploaded with different choices both get whichever flag the running worker was
started with — and which one you get depends on which process picks you up.

The request is what knows what was asked for, so `Comparison.metrics` holds it (comma-separated,
defaulting to `rf`), and the worker prefers the row over its own default. An explicit argument still
wins, which is what lets a rebuild ask for something specific.

### 30.3 Refuse by name, before reading a byte

An unknown metric is a **422 naming what the server does have**, not a silent fall back to the
default. A typo that fell back would produce a comparison the user did not ask for and cannot tell
apart from one they did — minutes later, in another process.

It is validated before the bundle is read. The names are in the request, so refusing after streaming
seventy-five megabytes to disk would be work spent to reach an answer that was available at once.
Duplicates are dropped rather than computed twice: asking for the same metric twice is a slip.

### 30.4 The client asks what exists

The panel reads `GET /api/v1/metrics` rather than carrying a list. Metrics are plugins (§11), so a
hardcoded list is a second registry that goes stale the moment one is added — and `available` is a
fact about the *deployment*: a metric can be registered and have no runtime. Only available ones are
offered, and the chooser appears only when there is more than one. If the call fails the panel
offers nothing and the upload proceeds on the server's default, which is the honest fallback — not
being able to choose beats choosing something absent.

Manifest descriptions are written for someone implementing against the metric and run to a
paragraph, so the form shows the first sentence and leaves the rest to the endpoint.

### 30.5 What this exposed in the simulation

`tools/simulate_usage.py` checked that an upload "reaches a terminal state". It passed — while the
trees it was sending had a **trifurcating root**, which the ingest refuses (`assert_rooted_binary`).
Failure is terminal too. The check now requires *ready* and reports the error when it is not, and a
non-binary tree is one of the bad-upload cases rather than the accidental content of the good one.

The same weak-assertion mistake as §27.2's `leaves > 1`: an assertion has to encode the promise, not
the last thing that went wrong.


---

## 31. Removing a comparison, from the list

The `DELETE` endpoint has existed since §26; nothing in the frontend reached it, so the only way to
remove anything was curl. Added (2026-09-25) for the demo deployment, where other people will be
uploading.

**A sibling control, not a nested one.** The row is already a button. A remove button *inside* it
would be invalid markup, and the browser's own repair of that puts a destructive action where a
click meant to open the comparison can land. It sits beside the row instead, at 45% opacity until
the row is hovered or it is focused — a list of red buttons competing with the rows would be the
loudest thing on the page, and this is the rarest action on it.

**The confirmation is the same `Notice` the failed jump uses** (§27.4c), given an optional `confirm`
action rather than a second component: a separate confirm dialog is the same markup with one more
button, and two of them drift. Cancel comes first and takes focus, and **both Escape and the
backdrop dismiss** — the fastest way out of the dialog must not be the irreversible one. Both
buttons disable while the request is in flight, since a second click would be a second `DELETE`
against a row the first one has already made a 404.

**What it removes** is stated before it happens: the comparison, both trees, and any typing data
only it was using. Trees another comparison still references are kept — verified on the running
service, where deleting an uploaded pair took its two trees with it and left the three catalogue
pairs and their three trees untouched.

### 31.1 The catalogue pairs are deletable too

There is no marker distinguishing a pair the offline sweep built from one someone uploaded — §19
made that deliberate, so that "a comparison exists" means one thing and the listing does not have to
union the database with a directory scan. The consequence is that the demo's own exhibits can be
removed by anyone using it, and under mock auth (§25) *everyone is the same user*, so one visitor
can delete what another came to see.

Left as it is for now, with the owner informed: restoring them is `phylodelta build-all --if-empty`,
and a guard would be either a `seeded` column or a refusal keyed on id — both of which reintroduce
the two-kinds-of-comparison distinction that §19 removed on purpose. Worth doing only if it actually
happens.


---

## 32. An unrooted NJ tree is resolved at the root, not refused

Found by the user uploading `aureus-rapidnj-tree.nwk` (29,208 leaves) against
`staphylococcus-nj-tree.nwk` (10,659, every one of them also in aureus). The job failed with
`ValueError: 1 internal node(s) are not binary, first at pre-order index 0 with 3 child(ren)`.

**What the file is.** Every node binary except the root, which has three children — the file ends
`...):12.938,'10103':0,'9630':3.4802);`. That is how rapidNJ and most neighbour-joining tools write
an **unrooted** tree: three is the unrooted degree, and the root is only where the file had to begin.
The staphylococcus NJ tree happens to be written binary; the rule cannot depend on which tool wrote it.

**Decision (the user's call, 2026-09-25):** resolve a root of degree exactly three at ingest, after
unary suppression (§1.4). The child on the **longest branch** stays under the root; the other two
are joined under a new node with a zero-length branch. Recorded as `resolved_root` in `meta.json`
and in `GET /trees/{id}`.

**Alternatives considered.**

| | |
|---|---|
| refuse, with a clear message | honest, but every NJ tree in the wild fails, over a convention — the argument §1.4 already accepted for unary roots |
| midpoint rooting | a less arbitrary root, but it re-roots the *whole* tree: every clade can differ from the file, where resolving adds exactly one |
| **resolve on the longest branch** | chosen: one clade added, none lost, and root-to-leaf distances unchanged |

**Why longest and not first.** First would make the stored tree depend on which clade the tool
happened to write first; the test writes the same tree both ways and requires the same clades.
Longest is also the branch that most separates one part of the tree from the rest, the usual choice
when there is no outgroup. NaN lengths count as shorter than any; ties go to file order.

**What it costs, stated rather than hidden.** Rooted RF compares clades, and an unrooted tree has
none until it is rooted, so *any* root the server picks is a choice the source file did not make.
Resolving adds one clade, `{the two joined children}`, which can move RF by one. For aureus that is
one clade in 29,206. The larger point is a finding in its own right: **rooted RF between two NJ
trees measures their rootings as well as their topologies.** An unrooted metric would not, and is
the right one to add if NJ pairs become the main use.

**Still refused, and now by name.** Four or more children at the root, or any multifurcation below
it, is a real polytomy, not a convention: resolving it means choosing among many binary trees.
`assert_rooted_binary` raises `NotRootedBinary`, and the worker reports it as
`The left tree (a.nwk) was not accepted: it is not a binary tree: its root has 4 children …` —
naming the side and the file, not an exception class and a pre-order index the user has never seen.

**Measured.** The aureus tree resolves in 83 ms (58,415 nodes = 2 × 29,208 − 1). The uploaded pair
went through the HTTP API and the worker to *ready* in 0.9 s: RF 10,657, 18,549 aureus leaves
dropped to reconcile to the shared 10,659.


---

## 33. A found leaf stays marked until the user clears it

Reverses the "five flashes, then nothing" of §27.4c, on the first real usage evidence: a supervisor
asked that a leaf found with *Find this leaf in the other tree* either blink for longer or keep a
different colour until a button removes it. In use, the leaf was lost the moment the flashing
stopped, while the eye was still going back and forth between the panels.

**Decision:** flash, then stay. The leaf still flashes five times in magenta — the change is what
draws the eye — and then stays magenta. The panel header names it, **"Found: 6555 ×"**; the × or
Escape clears it. A new jump moves the mark, and there is one mark across both panels, so marks
never pile up.

**Why not blink for longer.** Any fixed duration is wrong for someone: too short for whoever looked
away, too long for whoever has already found the leaf. Blinking that lasts is also what WCAG 2.2.2
asks to be stoppable beyond five seconds — so a longer blink needs a stop control anyway, which is
this design with the distraction left in.

**What §27.4c was protecting against still holds** — for a mark the *view* leaves behind unasked,
which would go on claiming a node is special. A mark the user asked for, named on screen and with a
visible way to remove it, is their state rather than the view's claim. That is why the library
default stays temporary (`persistHighlight: false`, so `lib_demo` is unchanged) and the app opts in.

**Two things a lasting mark needed that a flash did not:**

* **Held by key, not by graph id.** Graph ids are minted by layout, and a lasting mark outlives
  re-layouts — a resize, the cladogram/phylogram switch, a re-slice. The operator now keeps the
  node's key and resolves it on every draw.
* **Independent of the colouring.** `setEnabled(false)` cleared the highlight, so switching the
  divergence colouring off would have taken the user's mark with it. A persistent mark survives.

**Escape is claimed by whatever it closes.** The context menu, the View options menu and the
notice all close on Escape; each now calls `preventDefault()`, and the view clears the mark only on
an Escape nobody claimed — closing a menu must not also remove the mark.

Verified in the browser: the mark and chip still there after six seconds; Escape clears both;
Escape with a menu open closes the menu and keeps the mark; a jump in the other direction moves the
mark to the other panel; × clears it.

---

## 32. Measured against Phylo.io

The measurement the whole project exists to support, taken 2026-09-25 and deferred until now
because a like-for-like comparison only becomes meaningful once there is a frontend that uses the
slicing API (see *Corrections*, on the earlier premature comparison).

### 32.1 Method

A **ladder of nine pairs**, 1,000 to 282,320 leaves, built from the real vibrio pair: pruned
subsamples below it, nested relabelled copies above. Nesting rather than joining N copies under one
root, because a flat join halves the effective depth and the search's pruning bound depends on shape
(§15.1). Every rung verified as a genuine pair — 100% shared leaf sets, depth 79 to 191.

Both tools, same pair, same origin, uncompressed, same real Chrome 154, viewport 1440x900, one fresh
page each. What is timed is a cold start to an interactive comparison. Memory through CDP after a
forced GC; never `performance.memory` (see *Corrections*).

**PhyloDelta is the median of six samples per rung after a discarded warm-up. phylo.io is a single
sample**, because at the top rungs one sample costs minutes. That asymmetry is stated rather than
hidden: the effect sizes are large and monotone across seven points, which is what makes n=1
tolerable for the shape, and it is still a limitation.

### 32.2 Result

| leaves | phylo.io | PhyloDelta | server precompute |
|---|---|---|---|
| 1,000 | 0.8 s · 4.1 MB | 0.62 s · 3.6 MB | 2.0 s |
| 2,500 | 1.8 s · 7.9 MB | 0.52 s · 3.6 MB | 2.0 s |
| 5,000 | 3.7 s · 14.4 MB | 0.61 s · 3.6 MB | 2.0 s |
| 10,000 | 8.6 s · 29.2 MB | 0.58 s · 3.6 MB | 2.5 s |
| 17,645 | 17.9 s · 58.7 MB | 0.61 s · 3.6 MB | 2.6 s |
| 35,290 | 48.7 s · 115.6 MB | 0.58 s · 3.6 MB | 3.0 s |
| 70,580 | **153.2 s · 230.2 MB** | **0.59 s · 3.6 MB** | 5.6 s |
| 141,160 | did not complete in 240 s | 0.66 s · 3.6 MB | 14.4 s |
| 282,320 | did not complete in 240 s | 0.53 s · 3.6 MB | 49.8 s |

At 70,580 leaves — the largest rung both complete — **260x faster on 64x less memory**.

### 32.3 The mechanism, which is not the one we expected

**Phylo.io does not render the whole tree either.** Its drawn output is roughly constant across the
ladder: ~460 to ~670 SVG paths, ~5,800 to ~6,900 DOM nodes. The intuitive story — "they draw
everything, we draw a slice" — is false, and an examiner reaching for it is answered by their own
counts.

What differs is upstream. Phylo.io **parses and models the entire tree in the browser** to draw its
subset, so its heap is exactly linear in leaves (115.6 -> 230.2 MB for a doubling) while its DOM is
flat. PhyloDelta never receives the tree: 3.6 MB and ~0.6 s at every size, because what crosses the
wire is sized by the viewport rather than by the data.

That is a stronger claim than the one this was set up to test, and a more defensible one: it does
not depend on drawing less, only on holding less.

**What it costs.** Up to 49.8 s of offline precompute at 282,320 leaves, and a server at all.
Phylo.io needs neither, and that belongs in the same table rather than in a footnote.

### 32.4 Two harness bugs, one of which nearly became a finding

* **A degradation that was not there.** The first ladder — n=1 per cell — reported PhyloDelta at
  2.7 s and 3.6 s on the top two rungs, a 9x jump that looked like a real limit and had a plausible
  story (a bigger tree to summarise). A direct probe could not reproduce it: the same request burst
  took ~30 ms, and the API slice is **6-10 ms at every rung including 282,320**. With six samples
  the medians are flat. Single samples at sub-second scale were measuring the laptop.
* **`page.waitForFunction(fn, {timeout})` puts options in the THIRD argument.** Passed second, they
  are the page function's argument, so the 30 s default was in force for the whole run. It changed
  no outcome, but only because nothing needed between 30 s and the intended budget.

Both are the §27.2 lesson again in a new place: the first version of a measurement tends to confirm
whatever it was built expecting.

### 32.5 Limitations

* Phylo.io at n=1 per rung.
* "Did not complete in 240 s" is a budget, **not** a crash. An unbounded attempt was not run, so no
  claim is made that it cannot finish. A renderer observed at 7.5 GB during an earlier uncapped run
  suggests it may, expensively.
* Rungs above 17,645 leaves are **synthetic**. Real data in `datasets/` stops at 27,962.

Tooling: `code/bench/harness/{ceiling,repeat_phylodelta,probe_latency}.mjs`,
`code/server/tools/{make_ladder,build_ladder_stores}.py`. Results in `code/bench/results/`.


---

## References and provenance

Where every algorithm and every implementation came from. Bibliographic details are taken from the
reference list of Branco et al. (2024) where it cites them, and verified against Crossref
otherwise — none is quoted from memory.

### Algorithms implemented or planned

| what | source | used here |
|---|---|---|
| **Robinson-Foulds distance** | Robinson, D.F.; Foulds, L.R. *Comparison of phylogenetic trees.* Math. Biosci. **1981**, 53, 131–147 | the metric itself (§3) |
| **Weighted RF (wRF)** | Robinson, D.F.; Foulds, L.R. *Comparison of weighted labelled trees.* Combinatorial Mathematics VI, Springer **1979**, 748, 119–126 | not implemented here; TreeDiff's variant used for cross-checking (§2.3) |
| **Linear-time RF** | Day, W.H. *Optimal algorithms for comparing trees with labeled leaves.* J. Classif. **1985**, 2, 7–28 | the interval/cluster test used as an independent cross-check in `_shared_by_day` (§3.2) |
| **RF over succinct representations** | Branco, A.P.; Vaz, C.; Francisco, A.P. *Computing RF Tree Distance over Succinct Representations.* Algorithms **2024**, 17, 15. doi:10.3390/a17010015 | **the reference this backend follows** — node identity, interval encoding, the LCA formulation (§1.10) |
| **Triplet distance** | Critchlow, D.E.; Pearl, D.K.; Qian, C. *The triples distance for rooted bifurcating phylogenetic trees.* Syst. Biol. **1996**, 45, 323–334 | planned second metric (§9.4) |
| **Triplet/quartet, arbitrary degree** | Brodal, G.S.; Fagerberg, R.; Mailund, T.; et al. *Efficient Algorithms for Computing the Triplet and Quartet Distance Between Trees of Arbitrary Degree.* SODA **2013**. doi:10.1137/1.9781611973105.130 | the algorithm behind tqDist, and most likely behind TreeDiff's `trip_sht` |
| **Quartet distance** | Estabrook, G.F.; McMorris, F.; Meacham, C.A. *Comparison of undirected phylogenetic trees based on subtrees of four evolutionary units.* Syst. Zool. **1985**, 34, 193–200 | candidate metric (§9.4) |
| **Geodesic distance (BHV space)** | Billera, L.J.; Holmes, S.P.; Vogtmann, K. *Geometry of the space of phylogenetic trees.* Adv. Appl. Math. **2001**, 27, 733–767 — exact algorithm: Kupczok, A.; von Haeseler, A.; Klaere, S. J. Comput. Biol. **2008**, 15, 577–591 | candidate metric; scalar only (§9.3) |
| **Succinct trees / balanced parentheses** | Navarro, G. *Compact Data Structures: A Practical Approach.* CUP **2016**; Navarro, G.; Sadakane, K. *Fully Functional Static and Dynamic Succinct Trees.* ACM Trans. Algorithms **2014**, 10, 1–39 | the representation the native core targets (§2.1) |
| **Jaccard gradient + best corresponding node** | **the approach is Phylo.io's, adopted here** — Robinson, Dylus & Dessimoz (2016), implementation in `phylo-io/src/worker_bcn.js`. What differs is exactness and placement, not the idea (see below) | the similarity gradient (§9.1) |

### Implementations used

| software | role here | origin | licence |
|---|---|---|---|
| **TreeDiff** | **conformance oracle**, run as an external process. Source study in §Next; **not linked** | `github.com/pedroparedesbranco/TreeDiff` — the reference implementation of Branco et al. (2024) | **GPL-3.0** |
| `rf_postorder`, `rf_nextsibling` | the two oracle binaries actually used | TreeDiff | GPL-3.0 |
| `rf_day` | **rejected** as an oracle — returns 11,831 comparing a tree with itself (§2.5) | TreeDiff | GPL-3.0 |
| `trip_treediff`, `trip_sht` | triplet distance; planned second metric (§9.4) | TreeDiff | GPL-3.0 |
| **sdsl-lite** (original) | what TreeDiff vendors; needed three patches to build (§2.2) | Gog, S.; Beller, T.; Moffat, A.; Petri, M. *From Theory to Practice: Plug and Play with Succinct Data Structures.* SEA **2014**. `github.com/simongog/sdsl-lite` | **GPL-3.0** |
| **sdsl-lite v3** | **the library the native core will build against** (§Next) | `github.com/xxsds/sdsl-lite`, actively maintained | **BSD-3-Clause** |
| **tqDist** | candidate for quartet distance | Sand, A.; Holt, M.K.; Johansen, J.; et al. *tqDist: a library for computing the quartet and triplet distances between binary or general trees.* Bioinformatics **2014**. doi:10.1093/bioinformatics/btu157 | to verify before use |
| **GTP** / R `distory` | candidate for geodesic distance; natural `subprocess` metrics (§9.2) | GTP implements Owen & Provan; `distory` is on CRAN | to verify before use |
| **Phylo.io** | the comparison target this project measures against | Robinson, O.; Dylus, D.; Dessimoz, C. *Phylo.io: Interactive Viewing and Comparison of Large Phylogenetic Trees on the Web.* Mol. Biol. Evol. **2016**. doi:10.1093/molbev/msw080 | — |
| `phylodiff` | examined and **rejected** — its RF is incorrect (see *Corrections*) | — | — |

### Data

| dataset | origin |
|---|---|
| vibrio / clostridium trees and isolate metadata | **EnteroBase** — Zhou, Z.; Alikhan, N.F.; Mohamed, K.; et al. *The EnteroBase user's guide…* Genome Res. **2020**, 30, 138–152 |
| goeBURST trees (out of scope, §1.8) | Francisco, A.P.; Bugalho, M.; Ramirez, M.; Carriço, J.A. *Global optimal eBURST analysis of multilocus typing data using a graphic matroid approach.* BMC Bioinform. **2009**, 10, 152 |

### What is adopted from Phylo.io, and what is not

Recorded precisely because the distinction belongs in a contributions chapter and overclaiming there
is a real error. **The per-clade similarity used in this project is Phylo.io's approach**: score each
clade by the maximum Jaccard overlap of its leaf set against clades of the other tree, and colour by
that score. This was taken from Phylo.io, not arrived at independently.

Their implementation, `phylo-io/src/worker_bcn.js:89-135`:

    var matches = target_forest.query(node.min_hash, 10)   // MinHash/LSH -> 10 candidates
    var inter   = Array.from(r).filter(x => l.has(x)).length
    var union   = [...new Set([...l, ...r])].length
    var jj      = inter / union
    if (jj > max_jacc) { max_jacc = jj; BCN = e }

What is contributed here is not the measure but **how and where it is computed**:

| | Phylo.io | here |
|---|---|---|
| candidate set | **approximate** — MinHash/LSH retrieval of the 10 nearest | **exact** — every clade of the other tree is evaluated |
| method | JavaScript `Set` intersection per candidate | two binary searches over a contiguous leaf range, vectorised (§3.3) |
| when | in the browser, at view time, in a worker | **once, offline**, at precompute |
| result | held in the page | stored positionally and served sliced (§3.6, §5.1) |

The approximation is not a defect on their part — it is forced by doing the search in a browser
while the user waits, and MinHash is a reasonable answer to that. It is exactly the constraint this
project removes by moving the work offline, which is the same argument as §4.1 for topology: the
browser should not be doing this at all.

The empirical work behind the exact search is also this project's: the measurement that the cheap
LCA-ratio shortcut understates similarity on **653 clades** where it reports below 0.1 and the true
best match exceeds 0.5 (§3.3). That is the evidence that an exact search is worth its 12.6 s, and
it is the kind of claim only an offline implementation can afford to test.

#### A measurement this makes available, not yet taken

Because the search here is **exact**, it is ground truth for the same measure computed
approximately. That makes a question answerable that Phylo.io cannot answer about itself: **how
often does MinHash/LSH retrieval of ten candidates miss the true best corresponding node, and by how
much?** Every clade where their score is lower than ours is a case where the approximation cost
accuracy, and the gap is quantifiable per clade.

This is the same shape of measurement as the LCA-ratio comparison in §3.3 — cheap estimator against
exact answer, on real data — and it would be a result in its own right rather than a benchmark: not
"ours is faster" but "here is what that approximation costs, measured".

**Three cautions before running it**, since a careless version would attribute differences to the
wrong cause:

* **Leaf-set handling differs.** Phylo.io filters leaves with an `is_leaf` test on a `"|__|"`
  separator in the label; this project reconciles the two leaf sets explicitly and reports what was
  dropped (§3.1). Any comparison must confirm both are scoring the same clades over the same taxa,
  or the missing ST 211 alone will produce spurious disagreement.
* **A lower score is not necessarily an LSH miss.** It could equally be a difference in how
  unmatched leaves are treated. The two causes have to be separated before anything is claimed.
* **Their score is stored per node as `elementS[target_uid]`** (`worker_bcn.js`), so extracting it
  means driving the application rather than reading a file. The harness for that already exists:
  `code/bench/` drives both applications headlessly with CDP instrumentation, and is parked
  (§Deferred) rather than absent.

Worth doing only once the new frontend exists, since that is when a like-for-like comparison becomes
meaningful at all (see *Corrections*, on the earlier premature comparison).

### Licensing position

This repository is **MIT**. TreeDiff and the original sdsl-lite are **GPL-3.0**; linking either into
a distributed work makes the combined work GPL-3.0. The position taken (§Next):

* **TreeDiff is used only as a separate process** — a conformance oracle invoked by the test suite
  and by `native/build_treediff.sh`. Running a program creates no combined work and no obligation.
* **No GPL-3.0 source is vendored or linked.** The native core builds against **sdsl-lite v3
  (BSD-3-Clause)**, and the ~10 tree operations TreeDiff added to sdsl's header are reimplemented
  here from stock primitives rather than copied.

This is a deliberate, recorded choice, not an oversight. The alternative — relicensing the backend
GPL-3.0 and vendoring directly — is less work and may suit a PHYLOViZ merge better; it was not taken
because it forecloses options for a few hours' saving.

---

## Corrections — things that turned out not to be true

Recorded because they changed the design, and because the reasoning that produced them was
plausible enough to be worth warning against.

**A depth-based chunking cache.** An earlier architecture document specified fetching subtrees by
depth, `maxDepth: 4, maxNodes: 500`. Measured against the real trees, depth-4 yields **7–9 nodes**.
On trees this unbalanced, depth is nearly uncorrelated with node count, so the bound that was meant
to be operative never binds. The caching strategy from that document survives; its API shape does
not.

**`performance.memory` as a memory measurement.** It reported phylo.io using 22 MB both before *and*
after building 2,002 SVG elements. Chrome quantises the value for security and it is GC-dependent.
Memory is half the thesis claim, so it is measured through the Chrome DevTools Protocol
(`Runtime.getHeapUsage` after a forced `HeapProfiler.collectGarbage`) instead.

**An early comparison of the demo application against phylo.io.** The demo was reported as ~34×
faster. It was not: instrumentation showed it had built **91 and 13** graph nodes against phylo.io's
2,002, because an `expandCollapse.depth: 4` setting — not the node budget, which never binds (see
above) — had collapsed the tree. The two were not rendering comparable amounts of work. The
comparison is deferred until there is a frontend that uses the slicing API, which is the thing
actually worth measuring.

**`phylodiff`'s RF implementation is incorrect** — it shares one iterator across all outer
iterations, and was verified to score three identical clusters as one. It is a structural reference
only, never an oracle. Milestone 2 validates against the 200 published pairs in phylo.io's
`distance_testing.json`, cross-checked against `phangorn::RF.dist` and against `TreeDiff`, the
reference C++ implementation of the paper in §1.10 — the closest thing available to an authoritative
oracle, being by the authors of the algorithm being followed.
