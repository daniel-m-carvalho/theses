"""Build every ladder rung through the real upload path, timing each.

This is the benchmark's **server column**, and it is measured rather than
estimated because it is the honest cost of this design: phylo.io does all its
work in the browser, this project moves the expensive part offline, and a
comparison that reported only browser time would be hiding where the work went.

The production path is used deliberately — POST the bundle, let a worker claim
it, poll until ready — so what is timed includes ingest, reconciliation, the
correspondence search and the metric, exactly as a user would pay for it.

    uv run python tools/build_ladder_stores.py <ladder-dir> [api-base]
"""

from __future__ import annotations

import io
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

BASE = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8010/api/v1"


def post_bundle(left: Path, right: Path, name: str) -> str:
    boundary = f"----ladder{uuid.uuid4().hex}"
    buf = io.BytesIO()
    for key, value in (("name", name), ("metrics", "rf")):
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(f'Content-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    for key, path in (("left_tree", left), ("right_tree", right)):
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(
            f'Content-Disposition: form-data; name="{key}"; filename="{path.name}"\r\n'
            f"Content-Type: application/octet-stream\r\n\r\n".encode()
        )
        buf.write(path.read_bytes())
        buf.write(b"\r\n")
    buf.write(f"--{boundary}--\r\n".encode())

    request = urllib.request.Request(
        f"{BASE}/comparisons",
        data=buf.getvalue(),
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        return json.load(response)["id"]


def poll(comparison_id: str, limit: float) -> tuple[str, str | None]:
    deadline = time.time() + limit
    while time.time() < deadline:
        with urllib.request.urlopen(f"{BASE}/comparisons/{comparison_id}/status", timeout=60) as r:
            record = json.load(r)
        if record["status"] in {"ready", "failed"}:
            return record["status"], record.get("error")
        time.sleep(0.5)
    return "timeout", f"not ready within {limit:.0f}s"


def main() -> None:
    ladder = Path(sys.argv[1])
    rungs = sorted({int(p.name.split("-")[1]) for p in ladder.glob("ladder-*-a.nwk")})
    out = []

    print(f"{'leaves':>9} {'upload':>8} {'build':>9} {'total':>9}  status")
    for leaves in rungs:
        left = ladder / f"ladder-{leaves:06d}-a.nwk"
        right = ladder / f"ladder-{leaves:06d}-b.nwk"

        started = time.perf_counter()
        try:
            comparison_id = post_bundle(left, right, f"ladder-{leaves}")
        except urllib.error.HTTPError as failed:
            print(f"{leaves:>9,} {'—':>8} {'—':>9} {'—':>9}  refused: {failed.read()[:80]!r}")
            continue
        accepted = time.perf_counter()

        # Generous, and scaled: the search is quadratic, so a fixed limit would
        # turn "slow" into "failed" at exactly the sizes the thesis is about.
        status, error = poll(comparison_id, limit=max(300.0, leaves / 200))
        finished = time.perf_counter()

        row = {
            "leaves": leaves,
            "id": comparison_id,
            "upload_s": accepted - started,
            "build_s": finished - accepted,
            "total_s": finished - started,
            "status": status,
            "error": error,
            "bytes": left.stat().st_size + right.stat().st_size,
        }
        out.append(row)
        print(
            f"{leaves:>9,} {row['upload_s']:>7.1f}s {row['build_s']:>8.1f}s "
            f"{row['total_s']:>8.1f}s  {status}{f' — {error}' if error else ''}"
        )

    target = Path(__file__).resolve().parents[2] / "bench" / "results" / "server_build.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(out, indent=2))
    print(f"\nwritten to {target}")


if __name__ == "__main__":
    main()
