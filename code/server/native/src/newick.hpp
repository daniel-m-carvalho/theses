// Newick -> columnar arrays, in one pass, in pre-order.
//
// Not a port of TreeDiff's parser. That one takes a FILE*, discards every
// label once it has built its correspondence map, is structurally a two-tree
// routine (the second parse depends on state the first left behind), grows its
// bit vector one parenthesis at a time — O(n^2) — and does not skip
// whitespace, so a pretty-printed Newick parses wrongly and silently.
//
// This produces exactly what the Python parser produces, column for column, so
// it is a drop-in and can be checked against it on every tree in the corpus.
//
// Iterative, with an explicit stack: the real trees are 604 levels deep and a
// recursive descent parser recurses once per level.

#pragma once

#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace phylocmp {

constexpr uint32_t NO_PARENT = 0xFFFFFFFFu;

struct ParsedTree {
    std::vector<uint32_t> parent;
    std::vector<uint32_t> subtree_end;  // exclusive; leaves have i + 1
    std::vector<uint16_t> depth;
    std::vector<uint32_t> leaf_count;
    std::vector<float> branch_len;      // NaN where the source gave no length
    std::vector<std::string> labels;
    std::string balanced_parens;        // '(' on entering a node, ')' on leaving

    size_t size() const { return parent.size(); }
};

inline bool is_space(char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

inline bool ends_label(char c) {
    return c == '(' || c == ')' || c == ',' || c == ':' || c == ';';
}

// Read `name[:length]` starting at `i`, leaving `i` just past it.
inline void read_label(const std::string& text, size_t& i, std::string& name,
                       float& length) {
    const size_t n = text.size();
    name.clear();
    length = std::nanf("");

    if (i < n && (text[i] == '\'' || text[i] == '"')) {
        const char quote = text[i++];
        while (i < n) {
            if (text[i] == quote) {
                // Newick escapes a quote inside a quoted label by doubling it,
                // so a doubled pair is one literal character, not the end.
                if (i + 1 < n && text[i + 1] == quote) {
                    name.push_back(quote);
                    i += 2;
                    continue;
                }
                ++i;
                break;
            }
            name.push_back(text[i++]);
        }
    } else {
        const size_t start = i;
        while (i < n && !ends_label(text[i])) ++i;
        size_t stop = i;
        // Trim: whitespace around a label is formatting, not part of the name.
        size_t begin = start;
        while (begin < stop && is_space(text[begin])) ++begin;
        while (stop > begin && is_space(text[stop - 1])) --stop;
        name.assign(text, begin, stop - begin);
    }

    if (i < n && text[i] == ':') {
        ++i;
        const size_t start = i;
        while (i < n && !ends_label(text[i])) ++i;
        std::string raw(text, start, i - start);
        try {
            size_t consumed = 0;
            float value = std::stof(raw, &consumed);
            if (consumed > 0) length = value;
        } catch (const std::exception&) {
            // A malformed length is not worth failing a 900 KB file over; it
            // becomes NaN like an absent one, and the topology stands.
        }
    }
}

inline ParsedTree parse_newick(const std::string& text) {
    ParsedTree tree;
    // One allocation each rather than growth per node. TreeDiff resizes its bit
    // vector once per parenthesis, which is very likely the dominant cost in
    // its reported parse times.
    const size_t guess = text.size() / 8 + 16;
    tree.parent.reserve(guess);
    tree.subtree_end.reserve(guess);
    tree.branch_len.reserve(guess);
    tree.labels.reserve(guess);
    tree.balanced_parens.reserve(text.size() / 4 + 16);

    std::vector<uint32_t> open_nodes;  // opened but not yet closed
    std::string name;
    float length = 0.0f;

    auto allocate = [&]() -> uint32_t {
        const uint32_t index = static_cast<uint32_t>(tree.parent.size());
        tree.parent.push_back(open_nodes.empty() ? NO_PARENT : open_nodes.back());
        tree.subtree_end.push_back(0);
        tree.branch_len.push_back(std::nanf(""));
        tree.labels.emplace_back();
        tree.balanced_parens.push_back('(');
        return index;
    };

    const size_t n = text.size();
    size_t i = 0;
    while (i < n) {
        const char c = text[i];
        if (is_space(c)) {
            ++i;
        } else if (c == '(') {
            open_nodes.push_back(allocate());
            ++i;
        } else if (c == ',') {
            ++i;
        } else if (c == ')') {
            if (open_nodes.empty()) {
                throw std::invalid_argument("unbalanced ')' in Newick input");
            }
            const uint32_t index = open_nodes.back();
            open_nodes.pop_back();
            // Everything allocated since `index` is one of its descendants, so
            // the current count is the exclusive end of its interval.
            tree.subtree_end[index] = static_cast<uint32_t>(tree.parent.size());
            tree.balanced_parens.push_back(')');
            ++i;
            read_label(text, i, name, length);
            tree.labels[index] = name;
            tree.branch_len[index] = length;
        } else if (c == ';') {
            break;
        } else {
            const uint32_t index = allocate();
            read_label(text, i, name, length);
            tree.labels[index] = name;
            tree.branch_len[index] = length;
            tree.subtree_end[index] = index + 1;
            tree.balanced_parens.push_back(')');
            if (index == 0) break;  // a bare leaf is the whole tree
        }
    }

    if (!open_nodes.empty()) {
        throw std::invalid_argument("unbalanced '(' in Newick input");
    }
    if (tree.parent.empty()) {
        throw std::invalid_argument("empty tree");
    }

    const size_t count = tree.parent.size();
    tree.depth.assign(count, 0);
    tree.leaf_count.assign(count, 0);

    // Depth forwards: a parent always precedes its children in pre-order.
    for (size_t k = 1; k < count; ++k) {
        const uint32_t p = tree.parent[k];
        const uint32_t d = static_cast<uint32_t>(tree.depth[p]) + 1;
        if (d > 0xFFFFu) {
            throw std::invalid_argument("tree deeper than 65535 levels");
        }
        tree.depth[k] = static_cast<uint16_t>(d);
    }

    // Leaf counts backwards, for the mirror-image reason: by the time the loop
    // reaches a node its children have already contributed.
    for (size_t k = count; k-- > 0;) {
        if (tree.subtree_end[k] == k + 1) tree.leaf_count[k] = 1;
        const uint32_t p = tree.parent[k];
        if (p != NO_PARENT) tree.leaf_count[p] += tree.leaf_count[k];
    }

    return tree;
}

}  // namespace phylocmp
