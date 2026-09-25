# phylodelta — the backend.
#
# Two stages, because the native extension needs a C++ compiler that the
# running service does not. The builder compiles it; the runtime gets the
# resulting .so and nothing else. That keeps the image small without giving up
# the 17x faster parser and 5.5x faster correspondence search.
#
# The store is NOT built here. It is derived from datasets/ and can take hours
# at scale, so it belongs on a volume, populated by a job — see deploy/README.md.
# An image carrying only code can be rebuilt and redeployed without recomputing
# anything.

# --- builder ---------------------------------------------------------------
FROM python:3.12-slim AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ git ca-certificates cmake make \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-install-project

COPY src ./src
COPY native ./native
RUN uv sync --frozen

# Optional by design: if this fails the backend still runs, on the Python
# implementations that are the reference anyway. Better a slower image than a
# failed build over an optimisation.
RUN ./native/build.sh || echo "native extension unavailable; using the Python path"

# TreeDiff, for the triplet and rf-treediff metrics. GPL-3.0, and so a separate
# program the metrics run as a subprocess, never linked into this MIT code. It
# is built here for the university deployment, where the image is run and not
# distributed; anyone handing the image itself to others must offer TreeDiff's
# source with it (deploy/README.md). Optional like the extension above: without
# it those two metrics report `available: false` and rf still works.
RUN ./native/build_treediff.sh /app/native/TreeDiff \
 || echo "TreeDiff unavailable; triplet and rf-treediff will report available: false"
# Only the programs the metrics run, not the sources or sdsl: a directory that
# exists whatever happened, so the COPY below never fails the build.
RUN mkdir -p /app/treediff-bin \
 && for b in rf_postorder trip_sht; do \
      [ -x "/app/native/TreeDiff/$b" ] && cp "/app/native/TreeDiff/$b" /app/treediff-bin/ || true; \
    done

# --- runtime ---------------------------------------------------------------
FROM python:3.12-slim

# libstdc++ is needed to load the extension; the compiler is not.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 phylodelta

WORKDIR /app

COPY --from=build /app/.venv /app/.venv
COPY --from=build /app/src /app/src
COPY --from=build /app/pyproject.toml /app/README.md ./
# Only the built extension and the build scripts, not the vendored sources.
COPY --from=build /app/native/*.so /app/native/
COPY --from=build /app/native/build.sh /app/native/
COPY --from=build /app/treediff-bin/ /app/native/TreeDiff/

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PHYLODELTA_STORE=/data/store \
    PHYLODELTA_DATASETS=/data/datasets \
    PHYLODELTA_NATIVE=/app/native \
    PHYLODELTA_PORT=8000

RUN mkdir -p /data/store /data/datasets && chown -R phylodelta:phylodelta /data /app
USER phylodelta

EXPOSE 8000

# One worker by default: the correspondence search already uses every core
# (PHYLODELTA_THREADS), so several workers would oversubscribe the machine rather
# than serve more requests. Raise workers only alongside lowering threads.
CMD ["sh", "-c", "uvicorn phylodelta.api.app:app --host 0.0.0.0 --port ${PHYLODELTA_PORT}"]
