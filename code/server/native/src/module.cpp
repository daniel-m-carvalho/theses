// Python bindings for the native core.

#include <pybind11/numpy.h>
#include <pybind11/pybind11.h>
#include <pybind11/stl.h>

#include "bp_tree.hpp"
#include "correspondence.hpp"
#include "newick.hpp"

namespace py = pybind11;
using namespace phylocmp;

namespace {

// Copy a vector into a numpy array. The copy is deliberate: the vector dies
// with the ParsedTree, and handing Python a view into freed memory is the kind
// of bug that survives every test and crashes in production.
template <typename T>
py::array_t<T> to_array(const std::vector<T>& values) {
    py::array_t<T> out(static_cast<py::ssize_t>(values.size()));
    std::copy(values.begin(), values.end(), out.mutable_data());
    return out;
}

py::dict parse_to_dict(const std::string& text) {
    ParsedTree tree = parse_newick(text);
    py::dict out;
    out["parent"] = to_array(tree.parent);
    out["subtree_end"] = to_array(tree.subtree_end);
    out["depth"] = to_array(tree.depth);
    out["leaf_count"] = to_array(tree.leaf_count);
    out["branch_len"] = to_array(tree.branch_len);
    out["labels"] = py::cast(tree.labels);
    out["balanced_parens"] = py::cast(tree.balanced_parens);
    return out;
}

py::tuple best_matches_py(
    py::array_t<int64_t, py::array::c_style | py::array::forcecast> source_leaf_positions,
    py::array_t<int64_t, py::array::c_style | py::array::forcecast> source_leaf_start,
    py::array_t<int64_t, py::array::c_style | py::array::forcecast> source_size,
    py::array_t<uint8_t, py::array::c_style | py::array::forcecast> source_is_leaf,
    py::array_t<int64_t, py::array::c_style | py::array::forcecast> lca,
    py::array_t<int64_t, py::array::c_style | py::array::forcecast> target_lo,
    py::array_t<int64_t, py::array::c_style | py::array::forcecast> target_hi,
    py::array_t<int64_t, py::array::c_style | py::array::forcecast> target_size,
    py::array_t<float, py::array::c_style | py::array::forcecast> seed_similarity,
    py::array_t<uint32_t, py::array::c_style | py::array::forcecast> seed_corresponds) {

    const size_t n_source = static_cast<size_t>(source_size.size());
    const size_t n_target = static_cast<size_t>(target_size.size());

    BestMatches result = best_matches(
        source_leaf_positions.data(), source_leaf_start.data(), source_size.data(),
        source_is_leaf.data(), lca.data(), n_source,
        target_lo.data(), target_hi.data(), target_size.data(), n_target,
        seed_similarity.data(), seed_corresponds.data());

    return py::make_tuple(to_array(result.similarity), to_array(result.corresponds));
}

}  // namespace

PYBIND11_MODULE(phylocmp_native, m) {
    m.doc() = "Native core: Newick parsing and succinct tree operations.";
    m.attr("NO_PARENT") = NO_PARENT;

    m.def("parse_newick", &parse_to_dict, py::arg("text"),
          "Parse Newick into columnar arrays plus a balanced-parentheses "
          "string. Returns the same columns as the Python parser, so the two "
          "can be checked against each other.");

    m.def("best_matches", &best_matches_py,
          py::arg("source_leaf_positions"), py::arg("source_leaf_start"),
          py::arg("source_size"), py::arg("source_is_leaf"), py::arg("lca"),
          py::arg("target_lo"), py::arg("target_hi"), py::arg("target_size"),
          py::arg("seed_similarity"), py::arg("seed_corresponds"),
          "Best corresponding clade by maximum Jaccard overlap. Exact: the "
          "size-window pruning excludes only candidates that provably cannot "
          "win, so the result matches an exhaustive scan.");

    py::class_<BpTree>(m, "BpTree")
        .def(py::init<const std::string&>())
        .def("save", &BpTree::save, py::arg("path"))
        .def_static("load", &BpTree::load, py::arg("path"))
        .def("size", &BpTree::size)
        .def("find_close", &BpTree::find_close)
        .def("enclose", &BpTree::enclose)
        .def("preorder", &BpTree::preorder)
        .def("select", &BpTree::select)
        .def("is_leaf", &BpTree::is_leaf)
        .def("num_leaves", &BpTree::num_leaves)
        .def("cluster_size", &BpTree::cluster_size)
        .def("lca", &BpTree::lca)
        .def("size_bytes", &BpTree::size_bytes)
        .def("bitvector_bytes", &BpTree::bitvector_bytes)
        .def("num_leaves_many", &BpTree::num_leaves_many)
        .def("lca_many", &BpTree::lca_many);
}
