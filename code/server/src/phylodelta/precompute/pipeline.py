"""Offline precomputation.

Everything expensive happens here, once, ahead of time. That is the central
trade of this backend: the thesis measures what the *browser* spends, so work is
moved off the request path wherever it can be moved at all. This CLI is allowed
to take hours.

    uv run phylodelta ingest-trees        # Newick -> store/trees/
    uv run phylodelta compute-pairs       # comparisons -> store/pairs/
    uv run phylodelta ingest-isolates     # isolate TSVs -> store/isolates/
    uv run phylodelta build-all           # all three, in order
"""

from __future__ import annotations

import argparse
import itertools
import sys
import time
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


def _ingest_into(sources, trees_dir: Path) -> int:
    for source in sources:
        started = time.perf_counter()
        arrays = parse_newick_file(source.path, fast=True)
        # Canonicalise before storing: the store promises a rooted binary tree,
        # and vibrio-nj arrives with a unary root. Asserting afterwards means a
        # dataset that cannot be canonicalised fails ingest loudly rather than
        # producing subtly wrong comparisons later.
        arrays, suppressed = suppress_unary(arrays)
        assert_rooted_binary(arrays)
        parsed_ms = (time.perf_counter() - started) * 1000

        directory = trees_dir / source.id
        meta = write_tree(
            directory,
            arrays,
            TreeMeta(
                id=source.id,
                species=source.species,
                method=source.method,
                source=source.path.name,
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
            owner_id=SINGLE_OWNER,
            kind=db.DatasetKind.TREE,
            display_name=f"{meta.species} {meta.method}".strip(),
            store_path=f"trees/{meta.id}",
            source_name=meta.source,
        )
        total = store_bytes(directory)
        print(
            f"{meta.id:<22} {meta.n_leaves:>7,} leaves  {meta.n_nodes:>7,} nodes  "
            f"depth {meta.max_depth:>4}  {total / 1024:>8,.0f} KB  "
            f"{total / meta.n_nodes:>5.1f} B/node  in {parsed_ms:,.0f} ms"
            + (f"  ({suppressed} unary node(s) suppressed)" if suppressed else "")
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
    manifests = registry.discover()
    loaded = {name: registry.load(name) for name in wanted}

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

    for left_id, right_id in pairs:
        pair_id = f"{left_id}__{right_id}"
        started = time.perf_counter()

        left_arrays = readers[left_id].to_arrays()
        right_arrays = readers[right_id].to_arrays()
        try:
            left_r, right_r, report = reconcile(left_arrays, right_arrays)
        except ValueError as exc:
            # No shared labels at all: nothing to compare, and saying so beats
            # writing an empty result that looks computed.
            print(f"{pair_id:<34} skipped: {exc}", file=sys.stderr)
            continue

        same_species = readers[left_id].meta.species == readers[right_id].meta.species
        notes: dict = {
            "reconciliation": {
                "shared_leaves": report.shared,
                "dropped_from_left": report.dropped_left,
                "dropped_from_right": report.dropped_right,
                "label_match": "identity",
                "same_species": same_species,
            }
        }
        if not same_species:
            notes["caution"] = (
                f"{readers[left_id].meta.species} vs {readers[right_id].meta.species}: "
                "sequence types are numbered per species, so leaves matched by "
                "identical labels are not the same organisms."
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

            # Report whatever this metric actually produced, rather than
            # assuming RF's keys: a scalar-only metric has no shared_clusters.
            scalars = "  ".join(
                f"{k}={v:,.6g}" if isinstance(v, (int, float)) else f"{k}={v}"
                for k, v in list(result.summary.items())[:2]
            )
            columns = ",".join(result.column_names) or "scalars only"
            print(
                f"{pair_id:<34} {name:<10} {scalars:<34} [{columns}]  "
                f"{store_bytes(directory) / 1024:>6,.0f} KB  "
                f"in {time.perf_counter() - metric_started:,.1f} s"
            )

        prepared.files.cleanup()

        dropped = len(report.dropped_left) + len(report.dropped_right)
        print(
            f"{'':<34} shared work {shared_ms / 1000:,.1f} s, "
            f"correspondence {store_bytes(correspondence_dir) / 1024:,.0f} KB"
            + (f", {dropped:,} leaf/leaves dropped to reconcile" if dropped else "")
            + ("  [CROSS-SPECIES: labels matched by coincidence]" if not same_species else "")
        )
    return 0


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

    sub.add_parser("ingest-isolates", help="parse datasets/isolated_data/*.tsv into the store")
    sub.add_parser("build-all", help="ingest-trees, compute-pairs and ingest-isolates, in order")
    sub.add_parser("list-metrics", help="show the registered metric plugins")

    args = parser.parse_args(argv)
    if args.command == "ingest-trees":
        return ingest_trees()
    if args.command == "compute-pairs":
        return compute_pairs(metrics=args.metrics, only=args.only, force=args.force)
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
