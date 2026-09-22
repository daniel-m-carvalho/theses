# Running it

```sh
docker compose up --build
```

| | |
|---|---|
| API | <http://localhost:8001/api/v1/datasets> |
| API docs | <http://localhost:8001/docs> |
| demo | <http://localhost:3001> |

## The store starts empty

The image carries **code only**. Everything under `store/` is derived from
`datasets/`, and building it takes minutes to hours depending on tree size — so
it is not baked into the image and not rebuilt on every deploy. A fresh volume
means `/api/v1/datasets` returns nothing until you populate it:

```sh
docker compose run --rm phylodelta-service phylodelta build-all
```

That ingests the trees, computes comparisons and ingests the isolate metadata
onto the volume, where it survives restarts and redeploys. Re-run it when
`datasets/` changes; it is safe to run again.

Individual stages, if you want them separately:

```sh
docker compose run --rm phylodelta-service phylodelta ingest-trees
docker compose run --rm phylodelta-service phylodelta compute-pairs --metric rf --metric triplet
docker compose run --rm phylodelta-service phylodelta ingest-isolates
```

## Ports

`8001` and `3001` on the host; `8000` and `80` inside. Override with
`PHYLODELTA_PORT` and `PHYLODELTA_DEMO_PORT`.

The demo proxies `/api/v1/` to the service, so the browser, the API and the page
share one origin and no CORS configuration is involved.

## Two things this deployment does not yet do

**The demo does not use the API.** `lib_demo` was written before the backend
existed and reads its trees from files it bundles. The proxy is wired and ready,
but until a frontend is written against the slicing API the two containers are
independent. See DECISIONS.md — `lib_demo` is deliberately frozen.

**Nothing computes on request.** Every API request is a memory-mapped read;
comparisons are precomputed by `build-all`. If users are to upload their own
trees, a comparison becomes minutes of work on the request path, which needs a
job queue and a status endpoint that do not exist. `proxy_read_timeout 600s` is
a stopgap for that, not a solution.

## Subprocess metrics

`triplet` and `rf-treediff` shell out to TreeDiff, which is **not** in the image
— it is GPL-3.0 and this project is MIT, so it is used as a separate program
and not vendored. Without it those metrics report `available: false` at
`/api/v1/metrics` and `rf` still works. To include them, run
`native/build_treediff.sh` in a derived image and accept the licensing
consequences for that image.
