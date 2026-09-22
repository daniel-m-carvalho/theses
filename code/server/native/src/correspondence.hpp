// Best corresponding clade, by maximum Jaccard overlap of leaf sets.
//
// The measure is Phylo.io's (see DECISIONS.md, References and provenance);
// what differs here is that it is exact and computed offline rather than
// approximated with MinHash/LSH in a browser. This is the expensive half of a
// comparison — 12.6 s of the 13 s a pair took in Python — and it is shared by
// every metric, so it is written once and it is worth making fast.
//
// The pruning bound
// -----------------
// For a source clade A of size a and a target clade C of size c,
//
//     Jaccard(A, C) = |A n C| / (a + c - |A n C|)  <=  min(a, c) / max(a, c)
//
// because the intersection cannot exceed the smaller set. So once some
// candidate has scored `best`, any C with min(a,c)/max(a,c) <= best is
// provably unable to beat it, which confines the search to
//
//     c in (a * best, a / best)
//
// Target clades are therefore visited in order of how close their size is to
// a — nearest first, since those are the likeliest to score well — and the
// window tightens every time `best` improves. The LCA ratio a/|LCA(A)| seeds
// `best` for free, because the LCA contains all of A by construction.
//
// This is exact. It prunes candidates that cannot win, never candidates that
// merely look unlikely, so the result is identical to scanning every clade —
// which is what the equivalence test against the Python implementation checks.
//
// Threading
// ---------
// Each source clade's search is independent: it reads shared read-only data,
// keeps its own scratch buffer, and writes exactly two output slots no other
// iteration touches. Threads therefore need no synchronisation beyond handing
// out work.
//
// Work is handed out **dynamically**, in small chunks from an atomic counter,
// rather than by splitting the range into equal blocks. Clade cost varies by
// three orders of magnitude — a 2-leaf clade is trivial, an 8,441-leaf one is
// not — so equal blocks would leave most threads idle behind whichever drew the
// large clades. The chunk is large enough to amortise the atomic and small
// enough to balance.
//
// The result does not depend on the thread count: index i's answer depends on
// no other index, and ties break on lowest node id within a single iteration.
// That is asserted rather than assumed — reasoning about determinism is how
// race conditions get shipped.
//
// Ties are broken by lowest node index, matching numpy's argmax. Several
// clades scoring equally is common (1,148 nodes on the vibrio pair), and
// without a rule the two implementations return different-but-equally-good
// answers — which would make the native path a behaviour change rather than a
// speed one, and the fallback observably different from the fast path.

#pragma once

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <thread>
#include <vector>

namespace phylodelta {

struct BestMatches {
    std::vector<float> similarity;
    std::vector<uint32_t> corresponds;
};

inline BestMatches best_matches(
    const int64_t* source_leaf_positions,  // target positions, in source leaf order
    const int64_t* source_leaf_start,      // per source node: index into the above
    const int64_t* source_size,            // per source node: leaves beneath it
    const uint8_t* source_is_leaf,
    const int64_t* lca,                    // per source node: a target node index
    size_t n_source,
    const int64_t* target_lo,              // per target node: first leaf position
    const int64_t* target_hi,              // per target node: last leaf position
    const int64_t* target_size,
    size_t n_target,
    const float* seed_similarity,          // the LCA ratio, already computed
    const uint32_t* seed_corresponds,
    unsigned threads = 0) {                // 0 = one per hardware thread

    BestMatches out;
    out.similarity.assign(seed_similarity, seed_similarity + n_source);
    out.corresponds.assign(seed_corresponds, seed_corresponds + n_source);

    // Target clades ordered by size, so the size window is a contiguous range.
    std::vector<uint32_t> by_size(n_target);
    for (size_t j = 0; j < n_target; ++j) by_size[j] = static_cast<uint32_t>(j);
    std::sort(by_size.begin(), by_size.end(), [&](uint32_t x, uint32_t y) {
        return target_size[x] < target_size[y];
    });
    std::vector<int64_t> sizes(n_target);
    for (size_t k = 0; k < n_target; ++k) sizes[k] = target_size[by_size[k]];

    // Grain: big enough that the atomic is not the bottleneck on cheap clades,
    // small enough that one thread cannot monopolise a run of expensive ones.
    constexpr size_t CHUNK = 64;

    if (threads == 0) threads = std::thread::hardware_concurrency();
    if (threads == 0) threads = 1;
    threads = static_cast<unsigned>(
        std::min<size_t>(threads, std::max<size_t>(1, n_source / CHUNK + 1)));

    std::atomic<size_t> next_chunk{0};

    auto worker = [&]() {
      std::vector<int64_t> taxa;  // per thread; shared would be a data race
      while (true) {
        const size_t start = next_chunk.fetch_add(CHUNK, std::memory_order_relaxed);
        if (start >= n_source) break;
        const size_t stop = std::min(start + CHUNK, n_source);

        for (size_t i = start; i < stop; ++i) {
        if (source_is_leaf[i]) continue;

        const int64_t a = source_size[i];
        if (a <= 0) continue;

        // A source clade's taxa are contiguous in SOURCE leaf order; their
        // target positions are not, so they are sorted to allow binary search.
        const int64_t* begin = source_leaf_positions + source_leaf_start[i];
        taxa.assign(begin, begin + a);
        std::sort(taxa.begin(), taxa.end());

        // Seeded from the LCA's *recomputed* score rather than the stored
        // float32, so the comparison is in the same precision throughout and
        // a rounded seed cannot reject a candidate that would have won.
        double best = 0.0;
        uint32_t best_node = static_cast<uint32_t>(lca[i]);

        // Start where c == a and walk outwards, nearest size first.
        size_t right = static_cast<size_t>(
            std::lower_bound(sizes.begin(), sizes.end(), a) - sizes.begin());
        size_t left = right;  // exclusive on the left, inclusive on the right

        auto consider = [&](uint32_t j) {
            const int64_t lo = target_lo[j];
            const int64_t hi = target_hi[j];
            const int64_t overlap =
                (std::upper_bound(taxa.begin(), taxa.end(), hi) -
                 std::lower_bound(taxa.begin(), taxa.end(), lo));
            if (overlap == 0) return;
            const double score =
                static_cast<double>(overlap) /
                static_cast<double>(a + target_size[j] - overlap);
            if (score > best || (score == best && j < best_node)) {
                best = score;
                best_node = j;
            }
        };

        // Establish a real lower bound before the window can be computed: the
        // LCA contains all of A by construction, so it always scores above 0.
        consider(static_cast<uint32_t>(lca[i]));

        while (true) {
            // The window shrinks as `best` rises, so recompute its edges each
            // step rather than fixing them once.
            const double low_bound = a * best;
            const double high_bound = (best > 0.0) ? a / best : 1e18;

            // Inclusive bounds, not strict. A clade that *ties* with the
            // current best sits exactly on the boundary — its intersection is
            // the whole smaller set, so c == a/best — and a strict comparison
            // excludes precisely the ties. That is invisible in the scores,
            // which stay identical, and shows up only as a different-but-equal
            // `corresponds`, so it has to be reasoned about rather than
            // measured.
            const bool can_go_right =
                right < n_target && static_cast<double>(sizes[right]) <= high_bound;
            const bool can_go_left =
                left > 0 && static_cast<double>(sizes[left - 1]) >= low_bound;
            if (!can_go_right && !can_go_left) break;

            // Prefer whichever side is closer to a, so the best candidates are
            // seen first and the window closes sooner.
            bool take_right = can_go_right;
            if (can_go_right && can_go_left) {
                const int64_t d_right = sizes[right] - a;
                const int64_t d_left = a - sizes[left - 1];
                take_right = d_right <= d_left;
            }
            if (take_right) {
                consider(by_size[right]);
                ++right;
            } else {
                --left;
                consider(by_size[left]);
            }
            if (best >= 1.0) break;
        }

        out.similarity[i] = static_cast<float>(best);
        out.corresponds[i] = best_node;
        }
      }
    };

    if (threads == 1) {
        worker();
    } else {
        std::vector<std::thread> pool;
        pool.reserve(threads);
        for (unsigned t = 0; t < threads; ++t) pool.emplace_back(worker);
        for (auto& thread : pool) thread.join();
    }
    return out;
}

}  // namespace phylodelta
