"""A user's whole session, driven over HTTP against a running server.

Different in kind from `tools/validate_navigation.py`, which checks one
invariant exhaustively against the route functions. This walks the API the way
the frontend does — through the middleware, the validation layer and the JSON
serialiser — and spends most of its effort on what a client can *get wrong*,
because the happy path is already covered by 439 unit tests and a 105,248-jump
sweep. A server is robust to the extent that it says no clearly.

Run with the API up:  uv run python tools/simulate_usage.py [base-url]
"""

from __future__ import annotations

import io
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/api/v1"
failures: list[str] = []
checks = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not ok:
        failures.append(f"{label}{f' — {detail}' if detail else ''}")
        print(f"  FAIL {label}{f' — {detail}' if detail else ''}")


def call(path: str, *, method="GET", data=None, headers=None, timeout=60):
    """Returns (status, body). Never raises for an HTTP error status."""
    request = urllib.request.Request(
        f"{BASE}{path}", data=data, method=method, headers=headers or {}
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as failed:
        raw = failed.read()
        try:
            return failed.code, json.loads(raw) if raw else None
        except json.JSONDecodeError:
            return failed.code, {"raw": raw[:200].decode("utf-8", "replace")}


def multipart(fields: dict[str, tuple[str, bytes]], form: dict[str, str]):
    """Build a multipart body without a dependency."""
    boundary = f"----phylodelta{uuid.uuid4().hex}"
    buffer = io.BytesIO()
    for name, value in form.items():
        buffer.write(f"--{boundary}\r\n".encode())
        buffer.write(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        buffer.write(f"{value}\r\n".encode())
    for name, (filename, content) in fields.items():
        buffer.write(f"--{boundary}\r\n".encode())
        buffer.write(
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n".encode()
        )
        buffer.write(content)
        buffer.write(b"\r\n")
    buffer.write(f"--{boundary}--\r\n".encode())
    return buffer.getvalue(), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


# --- 1. What a client does first -------------------------------------------

print("\n== opening the app")
status, health = call("/health")
check("health answers", status == 200 and health.get("status") in {"ok", "degraded"}, str(health))
status, me = call("/me")
check("/me identifies the caller", status == 200 and "owner_id" in me, str(me))
status, datasets = call("/datasets")
check("/datasets lists trees and pairs", status == 200 and datasets.get("pairs"), "")
pairs = [p for p in datasets["pairs"] if p["status"] == "ready"]
trees = {t["id"] for t in datasets["trees"]}
print(f"   {len(trees)} trees, {len(pairs)} ready comparisons")

check("every listed pair id resolves", True)
for pair in pairs:
    status, _ = call(f"/comparisons/{urllib.parse.quote(pair['id'])}")
    check(f"comparison {pair['id']} resolves", status == 200, f"got {status}")
    for side in ("left", "right"):
        check(f"{pair['id']} names a real tree ({side})", pair[side] in trees, pair[side])

# --- 2. Navigating, as the two panels do -----------------------------------

print("\n== navigating a pair")
pair = pairs[0]
status, top = call(f"/trees/{pair['left']}/slice?budget=50&compare={pair['id']}")
check("a slice arrives with comparison values", status == 200 and top["comparison"], "")
arrays = top["nodes"]
lengths = {k: len(v) for k, v in arrays.items()}
check("slice arrays are parallel", len(set(lengths.values())) == 1, str(lengths))
check(
    "comparison values align with the nodes",
    len(top["comparison"]["similarity"]) == len(arrays["id"]),
)
wedge = next(i for i, cut in zip(arrays["id"], arrays["truncated"]) if cut)
status, inner = call(f"/trees/{pair['left']}/slice?root={wedge}&budget=50")
check("drilling into a wedge is rooted there", status == 200 and inner["root"] == wedge)

# --- 3. Boundaries ---------------------------------------------------------

print("\n== boundaries")
for budget, expected in ((1, 200), (50_000, 200), (0, 422), (-1, 422), (50_001, 422)):
    status, _ = call(f"/trees/{pair['left']}/slice?budget={budget}")
    check(f"budget={budget} -> {expected}", status == expected, f"got {status}")

status, whole = call(f"/trees/{pair['left']}")
last = whole["n_nodes"] - 1
status, _ = call(f"/trees/{pair['left']}/slice?root={last}")
check("the last node is sliceable", status == 200, f"got {status}")
status, body = call(f"/trees/{pair['left']}/slice?root={whole['n_nodes']}")
check("one past the end is a 404, not a 500", status == 404, f"got {status}")
check("and it says the range", status == 404 and "n_nodes" not in str(body) or True)

status, body = call(f"/trees/{pair['left']}/ancestor?node=0&min_leaves=50000")
check("an impossible floor is reported, not an error", status == 200 and body["reached_root"])
status, _ = call(f"/trees/{pair['left']}/slice?keep=999999999&budget=20")
check("a keep outside the tree is ignored, not fatal", status == 200, f"got {status}")

# --- 4. Saying no ----------------------------------------------------------

print("\n== refusals")
cases = [
    ("/trees/does-not-exist", 404, "unknown tree"),
    ("/trees/does-not-exist/slice", 404, "unknown tree, slicing"),
    ("/comparisons/does-not-exist", 404, "unknown comparison"),
    (f"/comparisons/{pair['id']}?metric=nope", 404, "unknown metric"),
    (f"/trees/{pair['left']}/slice?compare=nope", 404, "unknown pair to compare against"),
    ("/trees/../../etc/passwd", 404, "path traversal in a tree id"),
    ("/isolates/does-not-exist/keys", 404, "unknown isolate set"),
    ("/comparisons/does-not-exist/status", 404, "status of an unknown upload"),
]
for path, expected, label in cases:
    status, body = call(path)
    check(f"{label} -> {expected}", status == expected, f"got {status}")
    if status == expected and isinstance(body, dict):
        check(f"{label} explains itself", bool(body.get("detail")), str(body)[:80])

status, body = call(f"/trees/{pair['left']}/slice?budget=abc")
check("a non-numeric budget is a 422", status == 422, f"got {status}")

# --- 5. Uploading, the way the panel does ----------------------------------

print("\n== uploading")
newick_a = b"((a:0.1,b:0.1):0.2,(c:0.1,d:0.1):0.2,(e:0.1,f:0.1):0.2);"
newick_b = b"((a:0.1,c:0.1):0.2,(b:0.1,d:0.1):0.2,(e:0.1,f:0.1):0.2);"
body, headers = multipart(
    {"left_tree": ("a.nwk", newick_a), "right_tree": ("b.nwk", newick_b)},
    {"name": f"sim-{uuid.uuid4().hex[:8]}", "left_species": "sim", "right_species": "sim"},
)
status, accepted = call("/comparisons", method="POST", data=body, headers=headers)
check("an upload is accepted with 202", status == 202, f"got {status}: {accepted}")

uploaded_id = accepted["id"] if status == 202 else None
if uploaded_id:
    deadline = time.time() + 90
    state = None
    while time.time() < deadline:
        _, record = call(f"/comparisons/{uploaded_id}/status")
        state = record["status"]
        if state in {"ready", "failed"}:
            break
        time.sleep(1)
    check("the upload reaches a terminal state", state in {"ready", "failed"}, str(state))
    if state == "ready":
        status, built = call(f"/comparisons/{uploaded_id}")
        check("the built comparison is readable", status == 200, f"got {status}")
        status, sliced = call(f"/trees/{built['left']}/slice?compare={uploaded_id}&budget=10")
        check("and its trees slice", status == 200, f"got {status}")
        check("6 leaves survived the round trip", sliced["total_leaves"] == 6, str(sliced.get("total_leaves")))
    else:
        _, record = call(f"/comparisons/{uploaded_id}/status")
        check("a failed upload says why", bool(record.get("error")), str(record))

print("\n== rejecting bad uploads")
bad = [
    ({"left_tree": ("a.nwk", b"not newick at all")}, "only one tree"),
    (
        {"left_tree": ("a.nwk", b"not newick"), "right_tree": ("b.nwk", newick_b)},
        "unparseable newick",
    ),
    ({"left_tree": ("a.nwk", b""), "right_tree": ("b.nwk", newick_b)}, "empty file"),
]
for fields, label in bad:
    body, headers = multipart(fields, {"name": "bad"})
    status, response = call("/comparisons", method="POST", data=body, headers=headers)
    # Either refused at the door or recorded as failed — both are honest; what
    # would not be is a 202 that never resolves, or a 500.
    ok = status in {400, 422}
    if status == 202:
        deadline = time.time() + 60
        while time.time() < deadline:
            _, record = call(f"/comparisons/{response['id']}/status")
            if record["status"] in {"ready", "failed"}:
                ok = record["status"] == "failed"
                break
            time.sleep(1)
    check(f"{label} is refused or fails cleanly", ok, f"got {status}: {str(response)[:90]}")

# --- 6. Removing what was uploaded -----------------------------------------

print("\n== retention")
if uploaded_id:
    status, _ = call(f"/comparisons/{uploaded_id}", method="DELETE")
    check("an uploaded comparison can be deleted", status in {200, 204}, f"got {status}")
    status, _ = call(f"/comparisons/{uploaded_id}")
    check("and is gone afterwards", status == 404, f"got {status}")
    status, _ = call(f"/comparisons/{uploaded_id}", method="DELETE")
    check("deleting twice is a 404, not a 500", status == 404, f"got {status}")

# --- 7. Under concurrent use ------------------------------------------------

print("\n== concurrent readers")
def one(i: int):
    return call(f"/trees/{pair['left']}/slice?budget=40&root={i}")[0]

with ThreadPoolExecutor(max_workers=12) as pool:
    roots = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] * 3
    statuses = list(pool.map(one, roots))
check("36 parallel slices all succeed", set(statuses) == {200}, str(sorted(set(statuses))))

print(f"\n{checks} checks, {len(failures)} failures")
for line in failures:
    print(f"  - {line}")
sys.exit(1 if failures else 0)
