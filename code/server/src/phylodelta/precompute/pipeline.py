"""Offline precomputation.

Everything expensive happens here, once, ahead of time. That is the central
trade of this backend: the thesis measures what the *browser* spends, so work is
moved off the request path wherever it can be moved at all. This CLI is allowed
to take hours.

    uv run phylodelta ingest-trees        # Newick -> store/trees/
    uv run phylodelta compute-pairs       # comparisons -> store/pairs/
    uv run phylodelta ingest-isolates     # isolate TSVs -> store/isolates/
    uv run phylodelta build-all           # all three, in order
    uv run phylodelta worker              # process uploaded comparisons
"""

from __future__ import annotations

import argparse
import itertools
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from .. import catalogue, config, db
from ..api.identity import SINGLE_OWNER
from ..isolates.ingest import ingest_all as ingest_isolates_all
from ..metrics import registry
from ..metrics.contract import validate_result
from ..metrics.runners import MetricFailed, PreparedPair
from ..metrics.project import project, project_correspondence
from ..metrics.store import CORRESPONDENCE_DIR, write_correspondence, write_pair
from ..trees.correspondence import compute_correspondence
from ..trees.materialise import MaterialisedPair
from ..trees.newick import parse_newick_file
from ..trees.normalise import assert_rooted_binary, suppress_unary
from ..trees.reconcile import reconcile
from ..trees.store import TreeMeta, read_tree, store_bytes, write_tree


def ingest_trees(datasets_dir: Path | None = None, store_dir: Path | None = None) -> int:
    sources = catalogue.discover_tree_sources(datasets_dir)
    if not sources:
        print("no supported .nwk files found", file=sys.stderr)
        return 1

    from ..trees import native

    print(f"parser: {native.describe()}", file=sys.stderr)
    db.create_schema()

    trees_dir = Path(store_dir or config.STORE_DIR) / "trees"
    with db.using_store(trees_dir.parent):
        db.create_schema()
        return _ingest_into(sources, trees_dir)


@dataclass(frozen=True, slots=True)
class IngestedTree:
    """What ingesting one tree produced. Returned rather than printed so the
    CLI and the job worker can report it differently."""

    meta: TreeMeta
    suppressed: int
    parsed_ms: float
    size_bytes: int


def ingest_tree_file(
    path: Path,
    trees_dir: Path,
    dataset_id: str,
    owner_id: str,
    species: str,
    method: str,
    display_name: str = "",
    source_name: str = "",
) -> IngestedTree:
    """Parse one Newick file into a tree store and record who owns it.

    Extracted from the catalogue loop so the job worker ingests an *uploaded*
    tree through exactly this code. The alternative — a second ingestion path
    for uploads — would be the same twenty lines with its own bugs, and the
    canonicalisation below is precisely where they would hide.
    """
    started = time.perf_counter()
    arrays = parse_newick_file(path, fast=True)
    # Canonicalise before storing: the store promises a rooted binary tree,
    # and vibrio-nj arrives with a unary root. Asserting afterwards means a
    # dataset that cannot be canonicalised fails ingest loudly rather than
    # producing subtly wrong comparisons later.
    arrays, suppressed = suppress_unary(arrays)
    assert_rooted_binary(arrays)
    parsed_ms = (time.perf_counter() - started) * 1000

    directory = trees_dir / dataset_id
    meta = write_tree(
        directory,
        arrays,
        TreeMeta(
            id=dataset_id,
            species=species,
            method=method,
            source=source_name or path.name,
            n_nodes=arrays.n_nodes,
            n_leaves=arrays.n_leaves,
            max_depth=arrays.max_depth,
            suppressed_unary=suppressed,
        ),
    )
    # Ownership lives in the database; the store path does not name an
    # owner, which is what keeps sharing a table rather than a migration.
    db.register_dataset(
        dataset_id=meta.id,
        owner_id=owner_id,
        kind=db.DatasetKind.TREE,
        display_name=display_name or f"{species} {method}".strip(),
        store_path=f"trees/{meta.id}",
        source_name=meta.source,
    )
    return IngestedTree(meta, suppressed, parsed_ms, store_bytes(directory))


def _ingest_into(sources, trees_dir: Path) -> int:
    for source in sources:
        done = ingest_tree_file(
            path=source.path,
            trees_dir=trees_dir,
            dataset_id=source.id,
            owner_id=SINGLE_OWNER,
            species=source.species,
            method=source.method,
        )
        meta = done.meta
        print(
            f"{meta.id:<22} {meta.n_leaves:>7,} leaves  {meta.n_nodes:>7,} nodes  "
            f"depth {meta.max_depth:>4}  {done.size_bytes / 1024:>8,.0f} KB  "
            f"{done.size_bytes / meta.n_nodes:>5.1f} B/node  in {done.parsed_ms:,.0f} ms"
            + (f"  ({done.suppressed} unary node(s) suppressed)" if done.suppressed else "")
        )
    return 0


def compute_pairs(
    store_dir: Path | None = None,
    metric_name: str | None = None,
    metrics: list[str] | None = None,
    only: str | None = None,
    force: bool = False,
) -> int:
    """Compute comparisons for every comparable pair and write them to the store.

    This is the expensive half of the backend, and it is why the backend exists
    in this shape: a comparison is computed once here, offline, so that serving
    it later is a memory-mapped range read. The thesis measures the browser, not
    this.

    **Several metrics are computed in one pass over a pair**, because the
    expensive part is shared. Reconciliation and clade correspondence are done
    once, then each metric runs against them; adding a second metric costs only
    that metric's own work, not another best-match search.
    """
    store = Path(store_dir or config.STORE_DIR)
    trees_dir = store / "trees"
    if not trees_dir.is_dir():
        print("no tree store; run `phylodelta ingest-trees` first", file=sys.stderr)
        return 1

    wanted = list(metrics or ([metric_name] if metric_name else ["rf"]))
    manifests, loaded = load_metrics(wanted)

    readers = {
        p.name: read_tree(p)
        for p in sorted(trees_dir.iterdir())
        if (p / "meta.json").exists()
    }

    # Any two trees sharing leaf labels are comparable. Cross-species pairs are
    # included: whether such a comparison is meaningful is the user's judgement,
    # and the reconciliation report records exactly what was matched.
    pairs = [(left, right) for left, right in itertools.combinations(sorted(readers), 2)]
    if only:
        pairs = [p for p in pairs if f"{p[0]}__{p[1]}" == only]
    if not pairs:
        print("no comparable pairs found", file=sys.stderr)
        return 1

    # Scoped to the store being built. compute_pairs now records a row per
    # pair, and a database write that escapes this scope lands in whatever
    # store the process defaulted to — which is how ingest once wrote its
    # stores to a temp directory and its ownership rows to the real database.
    with db.using_store(store):
        db.create_schema()
        return _compute_each(store, pairs, wanted, loaded, manifests, readers, force)


def _compute_each(store, pairs, wanted, loaded, manifests, readers, force) -> int:
    for left_id, right_id in pairs:
        pair_id = f"{left_id}__{right_id}"
        try:
            computed = compute_pair(
                store, left_id, right_id, wanted, loaded, manifests,
                readers=readers, force=force,
            )
        except NotComparable as exc:
            # The CLI sweeps every combination, most of which are not meant to
            # be compared; saying so and moving on is right here. A worker
            # computing a pair the user explicitly uploaded fails instead.
            print(f"{pair_id:<34} skipped: {exc}", file=sys.stderr)
            continue
        # The sweep records what it computed, so the catalogue and upload
        # routes agree on what a comparison is — see db.record_computed_pair.
        db.record_computed_pair(
            pair_id=pair_id, left_id=left_id, right_id=right_id,
            owner_id=SINGLE_OWNER,
            display_name=f"{left_id} vs {right_id}",
        )
        for line in computed.report_lines:
            print(line)
    return 0


class NotComparable(ValueError):
    """The two trees share no leaf labels, so there is nothing to compare.

    Raised rather than returned so neither caller can forget it: the CLI turns
    it into a skip, the worker into a failed job with this as the reason.
    Writing an empty result that looks computed would be worse than both.
    """


@dataclass(frozen=True, slots=True)
class PairComputed:
    pair_id: str
    notes: dict
    shared_ms: float
    metrics_written: list[str]
    report_lines: list[str]


def load_metrics(wanted: list[str]):
    """Discover manifests and load the named metrics. Once per run, not per pair."""
    manifests = registry.discover()
    return manifests, {name: registry.load(name) for name in wanted}


def compute_pair(
    store: Path,
    left_id: str,
    right_id: str,
    wanted: list[str],
    loaded: dict,
    manifests: dict,
    readers: dict | None = None,
    force: bool = False,
) -> PairComputed:
    """Reconcile two trees, build their correspondence, and run every metric.

    One pass per pair, because the expensive part is shared: reconciliation
    and the clade correspondence are done once and then each metric runs
    against them, so a second metric costs only its own work rather than
    another best-match search (§9). Measured: 12.6 s of shared work against
    0.1 s for RF itself.

    Extracted from the sweep so the job worker computes an uploaded pair
    through exactly this code rather than a parallel implementation.
    """
    pair_id = f"{left_id}__{right_id}"
    started = time.perf_counter()
    lines: list[str] = []

    readers = readers or {}
    for tree_id in (left_id, right_id):
        if tree_id not in readers:
            readers[tree_id] = read_tree(store / "trees" / tree_id)

    left_arrays = readers[left_id].to_arrays()
    right_arrays = readers[right_id].to_arrays()
    try:
        left_r, right_r, report = reconcile(left_arrays, right_arrays)
    except ValueError as exc:
        raise NotComparable(str(exc)) from None

    left_species = readers[left_id].meta.species
    right_species = readers[right_id].meta.species
    # An uploaded tree need not declare a species, and `None` is the honest
    # answer there — not `True`. Reporting two undeclared trees as the same
    # species would manufacture a reassurance nobody gave: the caution below
    # exists precisely because matching labels across species is a coincidence,
    # and "we do not know" must not read as "we checked".
    declared = bool(left_species and right_species)
    same_species = (left_species == right_species) if declared else None

    notes: dict = {
        "reconciliation": {
            "shared_leaves": report.shared,
            "dropped_from_left": report.dropped_left,
            "dropped_from_right": report.dropped_right,
            "label_match": "identity",
            "same_species": same_species,
        }
    }
    if declared and not same_species:
        notes["caution"] = (
            f"{left_species} vs {right_species}: "
            "sequence types are numbered per species, so leaves matched by "
            "identical labels are not the same organisms."
        )
    elif not declared:
        notes["caution"] = (
            "Species was not declared for these trees, so whether their labels "
            "denote the same organisms could not be checked. Sequence types are "
            "numbered per species; if these are different species, matching "
            "labels are a coincidence."
        )

    # Once per pair, before any metric. Metrics receive it in RECONCILED
    # indexing; what is stored is projected onto the stored trees, so the
    # two forms are not interchangeable and this is not loaded from disk.
    correspondence = compute_correspondence(left_r, right_r)
    correspondence_dir = store / "pairs" / pair_id / CORRESPONDENCE_DIR
    if force or not (correspondence_dir / "meta.json").exists():
        write_correspondence(
            correspondence_dir,
            project_correspondence(
                correspondence,
                report.left_source_index, report.right_source_index,
                left_arrays.n_nodes, right_arrays.n_nodes,
            ),
            pair_id, left_id, right_id, left_arrays, right_arrays, notes,
        )
    shared_ms = (time.perf_counter() - started) * 1000

    # Written only if some metric actually needs files, and once per form
    # however many metrics ask for it.
    prepared = PreparedPair(
        pair_id=pair_id, left=left_r, right=right_r,
        correspondence=correspondence,
        files=MaterialisedPair(
            pair_id=pair_id, left=left_r, right=right_r,
            directory=Path(store) / "scratch" / pair_id,
        ),
    )

    written: list[str] = []
    try:
        for name in wanted:
            metric_started = time.perf_counter()
            try:
                result = loaded[name](prepared)
            except MetricFailed as exc:
                print(f"{pair_id:<34} {name:<10} failed: {exc}", file=sys.stderr)
                continue
            # Before anything is written: a metric that renamed a column, or
            # stopped producing one, fails here rather than being discovered by
            # a frontend rendering an empty overlay.
            validate_result(result, manifests[name])
            result.notes.update(notes)
            # Values are indexed by the reconciled trees; the API serves the
            # stored trees. Project before writing, never after.
            result = project(
                result,
                report.left_source_index, report.right_source_index,
                left_arrays.n_nodes, right_arrays.n_nodes,
            )
            directory = store / "pairs" / pair_id / name
            write_pair(
                directory, result, pair_id, left_id, right_id, left_arrays, right_arrays
            )
            written.append(name)

            # Report whatever this metric actually produced, rather than
            # assuming RF's keys: a scalar-only metric has no shared_clusters.
            scalars = "  ".join(
                f"{k}={v:,.6g}" if isinstance(v, (int, float)) else f"{k}={v}"
                for k, v in list(result.summary.items())[:2]
            )
            columns = ",".join(result.column_names) or "scalars only"
            lines.append(
                f"{pair_id:<34} {name:<10} {scalars:<34} [{columns}]  "
                f"{store_bytes(directory) / 1024:>6,.0f} KB  "
                f"in {time.perf_counter() - metric_started:,.1f} s"
            )
    finally:
        # Materialised Newick can be hundreds of KB per tree; a metric raising
        # must not leave it in the store.
        prepared.files.cleanup()

    dropped = len(report.dropped_left) + len(report.dropped_right)
    lines.append(
        f"{'':<34} shared work {shared_ms / 1000:,.1f} s, "
        f"correspondence {store_bytes(correspondence_dir) / 1024:,.0f} KB"
        + (f", {dropped:,} leaf/leaves dropped to reconcile" if dropped else "")
        + ("  [CROSS-SPECIES: labels matched by coincidence]" if same_species is False else "")
    )
    return PairComputed(pair_id, notes, shared_ms, written, lines)


def build_all() -> int:
    """Everything, in dependency order. Comparisons need the trees ingested."""
    for step, run in (
        ("trees", ingest_trees),
        ("comparisons", compute_pairs),
        ("isolates", ingest_isolates_all),
    ):
        print(f"--- {step}")
        code = run()
        if code != 0:
            print(f"stopped: {step} failed", file=sys.stderr)
            return code
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="phylodelta", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("ingest-trees", help="parse datasets/gen_trees/*.nwk into the columnar store")

    pairs = sub.add_parser("compute-pairs", help="compute comparisons into store/pairs/")
    pairs.add_argument(
        "--metric", action="append", dest="metrics",
        help="registered metric name; repeatable. Several in one run share the "
             "reconciliation and correspondence work. Default: rf",
    )
    pairs.add_argument("--only", help="restrict to one pair id, e.g. vibrio-nj__vibrio-upgma")
    pairs.add_argument(
        "--force", action="store_true",
        help="recompute correspondence even if it is already stored",
    )

    worker = sub.add_parser(
        "worker",
        help="process uploaded comparisons from the queue (runs until stopped)",
    )
    worker.add_argument(
        "--once", action="store_true",
        help="drain the queue and exit, instead of waiting for more",
    )
    worker.add_argument(
        "--poll", type=float, default=2.0, metavar="SECONDS",
        help="how long to wait when the queue is empty (default: 2)",
    )
    worker.add_argument(
        "--metric", action="append", dest="metrics",
        help="metric to compute for each uploaded pair; repeatable. Default: rf",
    )
    worker.add_argument(
        "--lease", type=int, default=None, metavar="SECONDS",
        help="treat a job as abandoned after this long without a heartbeat "
             "(default: 300). Must exceed the time a healthy job can go "
             "without heartbeating, or a slow job is run twice.",
    )

    sub.add_parser("ingest-isolates", help="parse datasets/isolated_data/*.tsv into the store")
    sub.add_parser("build-all", help="ingest-trees, compute-pairs and ingest-isolates, in order")
    sub.add_parser("list-metrics", help="show the registered metric plugins")

    args = parser.parse_args(argv)
    if args.command == "ingest-trees":
        return ingest_trees()
    if args.command == "compute-pairs":
        return compute_pairs(metrics=args.metrics, only=args.only, force=args.force)
    if args.command == "worker":
        from .jobs import work
        from ..db import jobs as queue

        return work(
            once=args.once,
            poll_seconds=args.poll,
            metrics=args.metrics,
            lease_seconds=args.lease or queue.DEFAULT_LEASE_SECONDS,
        )
    if args.command == "ingest-isolates":
        return ingest_isolates_all()
    if args.command == "build-all":
        return build_all()
    if args.command == "list-metrics":
        for name, manifest in registry.discover().items():
            caps = ", ".join(k for k, v in manifest.capabilities.items() if v) or "-"
            print(f"{name:<10} {manifest.title:<24} kind={manifest.kind:<11} [{caps}]")
        return 0
    parser.error(f"unknown command {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
