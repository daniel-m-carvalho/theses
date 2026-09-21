#!/usr/bin/env bash
#
# Build TreeDiff (Branco, Vaz & Francisco 2024) and its sdsl-lite dependency.
#
# TreeDiff is the reference C++ implementation of the RF algorithm this backend
# follows. It is used as the conformance oracle for our own implementation, and
# is the intended basis for the succinct-representation store.
#
# Neither project builds unmodified on macOS 27 / arm64 with CMake 4.x and
# Apple clang 21. Four fixes are needed, each documented at its site below.
# None is optional and none is discoverable from the projects' own READMEs.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-$HERE/TreeDiff}"

if [ -d "$DEST" ]; then
  echo "TreeDiff already present at $DEST — remove it to rebuild from scratch." >&2
  exit 0
fi

git clone --depth 1 https://github.com/pedroparedesbranco/TreeDiff.git "$DEST"
cd "$DEST"
git submodule update --init

# --- Fix 1: sdsl-lite predates CMake 3.5 -----------------------------------
# sdsl-lite's CMakeLists declares cmake_minimum_required(VERSION 2.8.7). CMake
# 4.x removed compatibility with < 3.5 and refuses to configure. The env var
# restores the old policy behaviour without editing upstream files.
export CMAKE_POLICY_VERSION_MINIMUM=3.5

# --- Fix 2: sdsl mistakes Apple clang for MSVC ------------------------------
# sdsl's compiler detection tests `CMAKE_CXX_COMPILER MATCHES ".*clang.*"` or
# `CMAKE_CXX_COMPILER_ID STREQUAL "Clang"`. Apple's id is "AppleClang" and
# CMake's default compiler path is /usr/bin/c++, so BOTH tests fail and it
# falls through to the MSVC branch, which defines -DMSVC_COMPILER and makes
# util.hpp include <process.h> — a Windows header. Naming a compiler path that
# literally contains "clang" satisfies the first test.
export CXX=/usr/bin/clang++
export CC=/usr/bin/clang

# --- Fix 3: an upstream typo in louds_tree.hpp ------------------------------
# louds_tree::swap references tree.m_select1 / tree.m_select0, which do not
# exist; the members are m_bv_select1 / m_bv_select0. It survived since 2015
# because swap is a template member that was never instantiated, and because
# older compilers deferred the lookup. Clang 21 diagnoses it at definition
# time. louds_tree is not used by TreeDiff at all, but it is compiled into
# libsdsl, so the build fails without this.
sed -i.bak \
  -e 's/tree\.m_select1/tree.m_bv_select1/' \
  -e 's/tree\.m_select0/tree.m_bv_select0/' \
  sdsl-lite/include/sdsl/louds_tree.hpp

( cd sdsl-lite && ./install.sh ../sdsl )

# --- Fix 4: TreeDiff's Makefile assumes GCC and static linking --------------
# `-static` cannot work on macOS (no static libc is shipped). TreeDiff's own
# README gives the clang recipe; the Makefile just does not default to it.
sed -i.bak \
  -e 's|^  CC = g++|  CC = clang++|' \
  -e 's|^  CFLAGS  = -O3 -Wall -static|  CFLAGS  = -O3 -Wall -std=c++11|' \
  Makefile

# --- Fix 5: wRF accumulates in float32 and loses precision at scale ---------
# The weighted variants store weights and the running distance as `float`, and
# compute wRF by summing every weight in both trees and then correcting
# downward per shared cluster (paper S3.4). On the vibrio UPGMA tree the total
# is 4.78e6 while individual corrections are ~1e0, so the cancellation falls
# below float32 resolution: comparing the tree with ITSELF yields -28.4947
# instead of 0. Rebuilding the same source with double gives 1.95e-08.
# The double build is produced alongside the original, not instead of it, so
# the discrepancy stays reproducible as evidence.
sed 's/float/double/g; s/stof/stod/g' rf_postorder.cpp > rf_postorder_double.cpp
sed 's/float/double/g; s/stof/stod/g' rf_nextsibling.cpp > rf_nextsibling_double.cpp

make
clang++ -O3 -Wall -std=c++11 -I./sdsl/include/ rf_postorder_double.cpp   sdsl/lib/libsdsl.a -o rf_postorder_double
clang++ -O3 -Wall -std=c++11 -I./sdsl/include/ rf_nextsibling_double.cpp sdsl/lib/libsdsl.a -o rf_nextsibling_double

echo
echo "Built in $DEST:"
ls -1 rf_postorder rf_postorder_double rf_nextsibling rf_nextsibling_double rf_day trip_treediff trip_sht

echo
echo "Sanity check against the paper's own documented example (expect RF = 1):"
./rf_postorder tree_examples/treeA.txt tree_examples/treeB.txt
