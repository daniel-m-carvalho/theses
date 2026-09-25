# Running it

```sh
docker compose up --build
```

| | |
|---|---|
| **the app** | <http://localhost:3001> |
| API | <http://localhost:8001/api/v1/datasets> |
| API docs | <http://localhost:8001/docs> |

Four services: `phylodelta-seed` (builds the example catalogue once, then
exits), `phylodelta-service` (the API), `phylodelta-worker` (computes uploads)
and `phylodelta-web` (the frontend, which proxies `/api/v1/` to the API).
`lib_demo` is not deployed: it is the frozen static-file proof that the library
works without a server.

## The example catalogue builds itself, once

`phylodelta-seed` runs `build-all --if-empty` before the API and the worker
start, so a fresh volume comes up with the example already in it: the three
trees, their comparisons, **and the typing data**, which is what the app's
typing-data switch needs to have anything to switch on.

`--if-empty` makes every later start a no-op, so this costs one run rather than
one per restart. The image still carries **code only** — everything under
`store/` is derived from `datasets/` and lives on the volume, where it survives
restarts and redeploys.

Re-run it by hand when `datasets/` changes; it is safe to run again, and
without `--if-empty` it rebuilds regardless:

```sh
docker compose run --rm phylodelta-service phylodelta build-all
```

The runtime image has no `uv`: the venv is on `PATH`, so commands are
`phylodelta ...`, not `uv run phylodelta ...`.

To start over completely, delete the volume:

```sh
docker compose down -v
```

Individual stages, if you want them separately:

```sh
docker compose run --rm phylodelta-service phylodelta ingest-trees
docker compose run --rm phylodelta-service phylodelta compute-pairs --metric rf --metric triplet
docker compose run --rm phylodelta-service phylodelta ingest-isolates
```

## Ports

`3001` (the app) and `8001` (the API) on the host; `80` and `8000` inside.
Override with `PHYLODELTA_WEB_PORT` and `PHYLODELTA_PORT`, in the
environment or in a `.env` file next to `docker-compose.yml`.

Only `3001` is needed by a browser: the web container proxies `/api/v1/` to the
service, so the page and the API share one origin and no CORS configuration is
involved.

## On the university VM

Authentication is `mock` by default: every request is the same user, and
**anyone who can reach the port can upload and delete**. That is acceptable on
a VM reachable only from the university network or through an SSH tunnel; it is
not acceptable on the open internet. See `PHYLODELTA_AUTH=jwt` in
`docker-compose.yml`.

Set `PHYLODELTA_THREADS` to a number on a shared machine — `0` takes every core.

Deploying a new version:

```sh
git pull
docker compose up -d --build
```

The store lives on the `phylodelta-data` volume and survives this. Only
`docker compose down -v` deletes it.

## The native extension is built in the image

`native/build.sh` compiles with whatever C++ compiler is present (`g++` in the
builder), so the image gets the 17x faster parser and 5.5x faster
correspondence search. Check it with:

```sh
docker compose exec phylodelta-service ls /app/native   # expect phylodelta_native*.so
```

If the compile fails the build still succeeds on the Python path — look for
`native extension unavailable` in the build output.

## Subprocess metrics

`triplet` and `rf-treediff` shell out to TreeDiff, which is **not** in the image
— it is GPL-3.0 and this project is MIT, so it is used as a separate program
and not vendored. Without it those metrics report `available: false` at
`/api/v1/metrics` and `rf` still works. To include them, run
`native/build_treediff.sh` in a derived image and accept the licensing
consequences for that image.
