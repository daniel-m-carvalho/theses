// Succinct tree operations over a balanced-parentheses bit vector.
//
// The operations TreeDiff added to sdsl's header, reimplemented here from stock
// sdsl-lite v3 primitives rather than vendored. That is a licensing decision as
// well as a practical one: TreeDiff and the sdsl it copies are GPL-3.0 and this
// repository is MIT (DECISIONS.md at the repository root, References and provenance). Each is a thin
// wrapper; what matters is that v3 provides the primitives they need.

#pragma once

#include <sdsl/bit_vectors.hpp>
#include <sdsl/bp_support_sada.hpp>
#include <sdsl/rank_support_v5.hpp>
#include <sdsl/select_support_mcl.hpp>
#include <sdsl/util.hpp>
#include <sdsl/io.hpp>

#include <stdexcept>
#include <string>
#include <vector>

namespace phylodelta {

struct BpTree {
    sdsl::bit_vector bv;
    sdsl::bp_support_sada<> bp;
    sdsl::rank_support_v5<10, 2> rank10;  // "10" == a leaf

    BpTree() = default;

    // Copy and move have to be written out. sdsl's rank/select supports hold a
    // *pointer* to the bit vector they index, and the implicit versions copy
    // that pointer — leaving the support aimed at the source object's vector,
    // which is then destroyed. The result is a structure that looks valid and
    // reads freed memory; here it surfaced as an assertion inside int_vector
    // the first time a loaded tree was queried. `set_vector` re-aims them.
    BpTree(const BpTree& other)
        : bv(other.bv), bp(other.bp), rank10(other.rank10) {
        rebind();
    }
    BpTree(BpTree&& other) noexcept
        : bv(std::move(other.bv)), bp(std::move(other.bp)),
          rank10(std::move(other.rank10)) {
        rebind();
    }
    BpTree& operator=(const BpTree& other) {
        if (this != &other) {
            bv = other.bv;
            bp = other.bp;
            rank10 = other.rank10;
            rebind();
        }
        return *this;
    }
    BpTree& operator=(BpTree&& other) noexcept {
        if (this != &other) {
            bv = std::move(other.bv);
            bp = std::move(other.bp);
            rank10 = std::move(other.rank10);
            rebind();
        }
        return *this;
    }

    void rebind() {
        bp.set_vector(&bv);
        rank10.set_vector(&bv);
    }

    // Serialise only the bit vector; rebuild rank/select support on load.
    //
    // The supports are derived, so storing them would be storing a cache. They
    // cost ~1 ms to construct for 35k nodes, which is once per process against
    // a file roughly four times smaller. TreeDiff has no serialisation at all,
    // so there is no precedent here to follow or to diverge from.
    void save(const std::string& path) const { sdsl::store_to_file(bv, path); }

    static BpTree load(const std::string& path) {
        BpTree tree;
        if (!sdsl::load_from_file(tree.bv, path)) {
            throw std::runtime_error("could not read a bit vector from " + path);
        }
        tree.build_support();
        return tree;
    }

    explicit BpTree(const std::string& parens) {
        bv = sdsl::bit_vector(parens.size(), 0);
        for (size_t i = 0; i < parens.size(); ++i) {
            bv[i] = (parens[i] == '(') ? 1 : 0;
        }
        build_support();
    }

    void build_support() {
        bp = sdsl::bp_support_sada<>(&bv);
        rank10 = sdsl::rank_support_v5<10, 2>(&bv);
    }

    size_t size() const { return bv.size() / 2; }

    // The honest space figure: the bit vector alone is 2 bits per node, but
    // rank/select support is what makes the operations O(1)-ish and it is not
    // free. Reporting the vector without its supports would flatter the
    // representation by an order of magnitude.
    size_t size_bytes() const {
        return sdsl::size_in_bytes(bv) + sdsl::size_in_bytes(bp)
             + sdsl::size_in_bytes(rank10);
    }
    size_t bitvector_bytes() const { return sdsl::size_in_bytes(bv); }

    // Batch forms, so a benchmark measures the operation rather than the
    // per-call binding overhead.
    std::vector<size_t> num_leaves_many(const std::vector<size_t>& positions) const {
        std::vector<size_t> out;
        out.reserve(positions.size());
        for (size_t p : positions) out.push_back(num_leaves(p));
        return out;
    }
    std::vector<size_t> lca_many(const std::vector<size_t>& us,
                                 const std::vector<size_t>& vs) const {
        std::vector<size_t> out;
        out.reserve(us.size());
        for (size_t k = 0; k < us.size(); ++k) out.push_back(lca(us[k], vs[k]));
        return out;
    }
    size_t find_close(size_t i) const { return bp.find_close(i); }
    size_t enclose(size_t i) const { return bp.enclose(i); }
    size_t preorder(size_t i) const { return bp.rank(i); }          // 1-based
    size_t select(size_t k) const { return bp.select(k); }
    bool is_leaf(size_t i) const { return bv[i + 1] == 0; }

    // Leaves beneath a node: the count of "10" patterns inside its span.
    //
    // A leaf is the pair "()" == "10", occupying two positions. sdsl's rank
    // counts patterns wholly before its argument, so the closing position must
    // be passed as find_close(i) + 1 — otherwise the pattern that *ends* at the
    // close is not counted, and every leaf reports zero. TreeDiff's vendored
    // header omits the +1 against its own indexing; the convention is not
    // transferable, and this was caught by checking against the columnar store
    // rather than by reading either implementation.
    size_t num_leaves(size_t i) const {
        return rank10(find_close(i) + 1) - rank10(i);
    }
    // Nodes in the subtree, which is what a cluster size means here.
    size_t cluster_size(size_t i) const { return (find_close(i) - i + 1) / 2; }

    size_t lca(size_t u, size_t v) const {
        if (u > v) std::swap(u, v);
        if (u == 0) return 0;
        return bp.double_enclose(u, v);
    }
};


}  // namespace phylodelta
