#!/usr/bin/env bash
#
# Build the native extension against sdsl-lite v3.
#
# Contrast with build_treediff.sh, which needs five patches for the GPL-3.0
# original: this needs none. sdsl-lite v3 is header-only and BSD-3-Clause, so
# there is no library to compile, no CMake, and nothing to link — one clang++
# invocation over one source file.
#
#   ./build.sh          fetch sdsl-lite v3 if absent, then compile
#   ./build.sh clean    remove the built extension

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$(dirname "$HERE")"

if [ "${1:-}" = "clean" ]; then
  rm -f "$HERE"/phylodelta_native*.so
  echo "removed the built extension"
  exit 0
fi

# --- sdsl-lite v3 (BSD-3-Clause, header-only) -------------------------------
# NOT simongog/sdsl-lite, which is GPL-3.0 and would make the combined work
# GPL-3.0 — this repository is MIT. See DECISIONS.md at the repository root, References and provenance.
if [ ! -d "$HERE/sdsl-lite/include" ]; then
  echo "fetching sdsl-lite v3..."
  git clone --depth 1 https://github.com/xxsds/sdsl-lite.git "$HERE/sdsl-lite"
fi

cd "$SERVER"
PYBIND_INCLUDE=$(uv run python -c "import pybind11; print(pybind11.get_include())")
PYTHON_INCLUDE=$(uv run python -c "import sysconfig; print(sysconfig.get_paths()['include'])")
EXT_SUFFIX=$(uv run python -c "import sysconfig; print(sysconfig.get_config_var('EXT_SUFFIX'))")

# Whatever C++ compiler the machine has: clang++ on macOS, g++ in the Docker
# builder. It used to say clang++ outright, and the image has no clang, so the
# build failed inside `|| echo` and every container ran the Python path.
CXX="${CXX:-c++}"

# -undefined dynamic_lookup: the extension resolves Python symbols against the
# interpreter that loads it, rather than linking libpython. Standard for macOS
# extension modules. It is a macOS linker flag; on Linux, unresolved symbols in
# a shared object are already allowed and GNU ld rejects the flag.
PLATFORM_FLAGS=()
if [ "$(uname -s)" = "Darwin" ]; then
  PLATFORM_FLAGS=(-undefined dynamic_lookup)
fi

# -pthread: the correspondence search runs a thread pool.
"$CXX" -O3 -Wall -std=c++17 -shared -fPIC -pthread "${PLATFORM_FLAGS[@]}" \
  -I"$PYBIND_INCLUDE" \
  -I"$PYTHON_INCLUDE" \
  -I"$HERE/sdsl-lite/include" \
  "$HERE/src/module.cpp" \
  -o "$HERE/phylodelta_native${EXT_SUFFIX}"

echo "built $HERE/phylodelta_native${EXT_SUFFIX}"
cd "$SERVER" && uv run python -c "
import sys; sys.path.insert(0, 'native')
import phylodelta_native as nat
t = nat.BpTree('((()())(()()))')
print(f'  self-check: {t.size()} nodes, root has {t.num_leaves(0)} leaves')
"
