"""The README's walkthrough must keep working.

Documentation that is not executed drifts, and this README is the deliverable
handed to whoever writes the frontend — a broken example there costs someone a
morning. Rather than restate the URLs here, where they could drift from the
README just as easily, the GET examples are **extracted from the README itself**
and replayed.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

README = Path(__file__).resolve().parents[1] / "README.md"

#: Every `localhost:8000/...` URL the README shows, in order.
URL_PATTERN = re.compile(r"localhost:8000(/api/v1/[^\s'\"\\|]+)")


def documented_paths() -> list[str]:
    """GET paths only — the method is read from the curl line that carries them."""
    seen, out = set(), []
    for line in README.read_text(encoding="utf-8").splitlines():
        if "-X POST" in line:
            continue
        for match in URL_PATTERN.finditer(line):
            path = match.group(1).rstrip(".,")
            if path not in seen:
                seen.add(path)
                out.append(path)
    return out


@pytest.fixture(scope="module")
def client(): 
    from phylodelta import config
    from phylodelta.api.app import create_app

    if not (config.TREES_DIR / "vibrio-upgma" / "meta.json").exists():
        pytest.skip("the real store is not built; run `phylodelta build-all`")
    return TestClient(create_app())


def test_the_readme_actually_shows_some_requests():
    paths = documented_paths()
    assert len(paths) >= 8, f"only found {len(paths)}: has the README changed shape?"


@pytest.mark.parametrize("path", documented_paths())
def test_every_documented_get_still_works(client, path):
    response = client.get(path)
    assert response.status_code == 200, f"{path} -> {response.status_code} {response.text[:200]}"


def test_the_documented_post_still_works(client):
    """The compositions example, which carries a body and so cannot be scraped."""
    response = client.post(
        "/api/v1/isolates/vibrio/compositions",
        json={
            "leaves": ["1", "3", "15"],
            "segment_by": "Continent",
            "filter": {"Source Niche": ["Human", "Environment"]},
        },
    )
    assert response.status_code == 200
    leaves = response.json()["leaves"]
    assert [leaf["leaf"] for leaf in leaves] == ["1", "3", "15"]
    # The distinction the README makes a point of.
    assert leaves[0]["total"] == 0 and leaves[0]["available"] == 1


def test_the_documented_error_shape_is_what_is_served(client):
    body = client.get("/api/v1/trees/nope").json()
    assert set(body) == {"detail", "code", "hint"}
    assert body["code"] == "tree_not_found"


def test_the_conservation_identity_the_readme_states(client):
    body = client.get("/api/v1/trees/vibrio-upgma/slice", params={"budget": 500}).json()
    wedges = sum(body["nodes"]["truncated"])
    assert (
        body["displayed_leaves"] - wedges + body["hidden_leaves"]
        == body["total_leaves"]
    )
