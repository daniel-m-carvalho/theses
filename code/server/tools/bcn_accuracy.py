"""What phylo.io's MinHash/LSH approximation costs, measured against exact truth.

Their best-corresponding-node search maximises Jaccard over **ten** candidates
retrieved by LSH (`worker_bcn.js`: `target_forest.query(node.min_hash, 10)`).
This project's search maximises over every node, so for the same clade over the
same taxa:

    ours >= theirs,  always

and every clade where `theirs < ours` is a case where the approximation cost
accuracy. That makes this a measurement *about* their method rather than a race
against it — the question they cannot answer about themselves, because
answering it needs an exact search to compare with.

**The confound this design removes.** A lower score could also come from the
two tools treating unmatched leaves differently (DECISIONS, cautions). Run on a
ladder rung whose two trees have *identical* leaf sets, there are no unmatched
leaves at all, so that explanation is unavailable and a gap can only be the
retrieval.

Clades are joined by **leaf set**, never by node id: the two tools number nodes
differently and neither numbering is part of either's contract.

    uv run python tools/bcn_accuracy.py <phyloio.json> <pair-id> [store]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

from phylodelta import config
from phylodelta.metrics.contract import NO_CORRESPONDENCE
from phylodelta.metrics.store import CorrespondenceReader
from phylodelta.trees.store import read_tree

DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"


def base36(value: int) -> str:
    """JavaScript's `Number.prototype.toString(36)` for an unsigned 32-bit int."""
    if value == 0:
        return "0"
    out = ""
    while value:
        value, digit = divmod(value, 36)
        out = DIGITS[digit] + out
    return out


def fingerprint(sorted_names: list[str]) -> str:
    """The same 2x32-bit FNV-1a the extraction page computes.

    Kept byte-for-byte equivalent to `harness/accuracy.html` — including the
    0x2c separator fold — because the join depends on both sides agreeing, and
    a silent divergence would look like "phylo.io scored nothing" rather than
    like a bug.
    """
    a, b = 0x811C9DC5, 0x01000193
    for name in sorted_names:
        for char in name:
            code = ord(char)
            a = ((a ^ code) * 0x01000193) & 0xFFFFFFFF
            b = ((b + code) & 0xFFFFFFFF) * 0x85EBCA6B & 0xFFFFFFFF
        a = ((a ^ 0x2C) * 0x01000193) & 0xFFFFFFFF
        b = (b ^ 0x2C) & 0xFFFFFFFF
    return f"{base36(a)}.{base36(b)}"


def ours(pair_id: str) -> dict[str, tuple[int, float]]:
    """Exact similarity per clade of the left tree, keyed by leaf-set."""
    store = Path(config.STORE_DIR)
    meta = json.loads((store / "pairs" / pair_id / "rf" / "meta.json").read_text())
    left = read_tree(store / "trees" / meta["left"]).to_arrays()
    corr = CorrespondenceReader(store / "pairs" / pair_id / "correspondence")
    similarity = np.asarray(corr.column("left", "similarity"))

    end = np.asarray(left.subtree_end)
    out: dict[str, tuple[int, float]] = {}
    for i in range(left.n_nodes):
        stop = int(end[i])
        if stop == i + 1:
            continue  # leaves are not clades
        names = sorted(
            left.labels[j] for j in range(i, stop) if int(end[j]) == j + 1
        )
        value = float(similarity[i])
        out[fingerprint(names)] = (len(names), value)
    return out


def main() -> None:
    extract = json.loads(Path(sys.argv[1]).read_text())
    pair_id = sys.argv[2]
    exact = ours(pair_id)

    theirs = extract["clades"]
    matched, missing_key = [], 0
    for clade in theirs:
        found = exact.get(clade["k"])
        if found is None:
            missing_key += 1
            continue
        matched.append((clade["n"], clade["s"], found[1]))

    print(f"phylo.io reported {len(theirs):,} clades; this project has {len(exact):,}")
    print(f"  joined by leaf set: {len(matched):,}   unjoinable: {missing_key:,}")
    print(f"  phylo.io scored {extract['scored']:,}, left unscored {extract['unscored']:,}")

    if not matched:
        print("\nNothing joined — the two are not describing the same clades.")
        return

    sizes = np.array([m[0] for m in matched])
    lsh = np.array([np.nan if m[1] is None else m[1] for m in matched], dtype=float)
    ex = np.array([m[2] for m in matched], dtype=float)

    comparable = ~np.isnan(lsh) & ~np.isnan(ex)
    gap = ex[comparable] - lsh[comparable]
    # Floating point: both sides compute Jaccard in doubles from the same
    # integers, so a true tie is exact to well within this.
    tie = np.abs(gap) < 1e-9
    worse = gap > 1e-9
    better = gap < -1e-9

    n = int(comparable.sum())
    print(f"\ncomparable clades: {n:,}")
    print(f"  LSH found the exact best match : {int(tie.sum()):,}  ({tie.mean():.1%})")
    print(f"  LSH found a worse match        : {int(worse.sum()):,}  ({worse.mean():.1%})")
    if better.any():
        # Cannot happen if both score the same clades over the same taxa, so
        # it is reported as a warning rather than folded into a percentage.
        print(f"  LSH scored HIGHER than exact   : {int(better.sum()):,}  <- investigate")

    if worse.any():
        missed = gap[worse]
        print(f"\nwhere it missed (n={missed.size:,}):")
        print(f"  median gap {np.median(missed):.4f}   mean {missed.mean():.4f}   worst {missed.max():.4f}")
        idx = np.flatnonzero(comparable)[worse]
        order = np.argsort(-gap[worse])[:5]
        print("  worst cases:")
        for rank in order:
            at = idx[rank]
            print(f"    {sizes[at]:>7,} leaves: phylo.io {lsh[at]:.4f} vs exact {ex[at]:.4f}")

        print("\n  by clade size:")
        for lo, hi in ((2, 4), (5, 16), (17, 64), (65, 256), (257, 1024), (1025, 10**9)):
            band = comparable & (sizes >= lo) & (sizes <= hi)
            if not band.any():
                continue
            g = ex[band] - lsh[band]
            miss = g > 1e-9
            label = f"{lo}-{hi}" if hi < 10**9 else f"{lo}+"
            print(
                f"    {label:>10} leaves: {int(band.sum()):>6,} clades, "
                f"{miss.mean():>6.1%} missed, median gap {np.median(g[miss]) if miss.any() else 0:.4f}"
            )

    out = Path(__file__).resolve().parents[2] / "bench" / "results" / "bcn_accuracy.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "pair": pair_id,
        "compare_ms": extract.get("compare_ms"),
        "clades_phyloio": len(theirs),
        "clades_exact": len(exact),
        "joined": len(matched),
        "unjoinable": missing_key,
        "comparable": n,
        "exact_match": int(tie.sum()),
        "worse": int(worse.sum()),
        "higher_than_exact": int(better.sum()),
        "gap_median": float(np.median(gap[worse])) if worse.any() else 0.0,
        "gap_worst": float(gap[worse].max()) if worse.any() else 0.0,
    }, indent=2))
    print(f"\nwritten to {out}")


if __name__ == "__main__":
    main()
