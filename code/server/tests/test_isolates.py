"""Isolate ingest and composition queries.

Milestone 5's gate: an AND-filter must agree with a naive scan of the original
TSV. The store is a dictionary-encoded, sorted, range-indexed rewrite of that
file, and the only convincing check that the rewrite is faithful is to ask the
file the same question.
"""

from __future__ import annotations

import collections
import csv
import random
from pathlib import Path

import pytest

from phylodelta.isolates.query import (
    UnknownFacet,
    UnknownValue,
    compositions,
    value_counts,
)
from phylodelta.isolates.schema import is_facet, is_identifier, slug
from phylodelta.isolates.store import read_isolates

csv.field_size_limit(10**7)
DATASETS = Path(__file__).resolve().parents[3] / "datasets"


@pytest.fixture(scope="module")
def isolate_store(tmp_path_factory):
    from phylodelta.isolates.ingest import ingest_all

    if not DATASETS.is_dir():
        pytest.skip("datasets not present")
    store = tmp_path_factory.mktemp("store")
    assert ingest_all(datasets_dir=DATASETS, store_dir=store) == 0
    return store / "isolates"


@pytest.fixture(scope="module")
def raw_vibrio():
    """The original TSV, as plain Python rows. The oracle."""
    path = DATASETS / "isolated_data" / "vibrio.tsv"
    if not path.exists():
        pytest.skip("vibrio.tsv not present")
    with open(path, newline="", encoding="utf-8", errors="replace") as fh:
        reader = csv.reader(fh, delimiter="\t")
        header = next(reader)
        rows = [r for r in reader if any(c.strip() for c in r)]
    return header, rows


@pytest.fixture(scope="module")
def vibrio(isolate_store):
    return read_isolates(isolate_store / "vibrio")


def naive(header, rows, leaves, segment_by, filters):
    """Compositions computed by scanning the TSV, with no store involved."""
    st_i = header.index("ST")
    seg_i = header.index(segment_by)
    filter_i = {k: header.index(k) for k in filters}

    def cell(row, i):
        return row[i].strip() if i < len(row) else ""

    out = {}
    for leaf in leaves:
        matched = collections.Counter()
        total = available = 0
        for row in rows:
            if cell(row, st_i) != leaf:
                continue
            available += 1
            if any(cell(row, i) not in filters[k] for k, i in filter_i.items()):
                continue
            total += 1
            matched[cell(row, seg_i) or None] += 1
        out[leaf] = (total, available, dict(matched))
    return out


# --- the gate --------------------------------------------------------------

@pytest.mark.parametrize(
    "segment_by,filters",
    [
        ("Continent", {}),
        ("Source Niche", {}),
        ("Continent", {"Source Niche": ["Human"]}),
        ("Source Type", {"Continent": ["Asia", "Africa"]}),
        # The AND case joint tuples exist for: two keys at once, where marginal
        # counts could not possibly answer it.
        ("Collection Year", {"Country": ["Bangladesh", "India"], "Source Niche": ["Human"]}),
        ("Country", {"Continent": ["Asia"], "Source Type": ["Human"]}),
    ],
)
def test_filtered_composition_matches_a_naive_tsv_scan(
    vibrio, raw_vibrio, segment_by, filters
):
    header, rows = raw_vibrio
    random.seed(7)
    st_i = header.index("ST")
    population = sorted({r[st_i].strip() for r in rows if r[st_i].strip()})
    leaves = random.sample(population, 60) + ["99999999", "NaN"]

    expected = naive(header, rows, leaves, segment_by, filters)
    got = compositions(vibrio, leaves, segment_by, filters)

    assert [c.leaf for c in got] == leaves
    for comp in got:
        want_total, want_available, want_segments = expected[comp.leaf]
        assert comp.total == want_total, comp.leaf
        assert comp.available == want_available, comp.leaf
        assert {s.value: s.count for s in comp.segments} == want_segments, comp.leaf


def test_value_counts_match_a_naive_tsv_scan(vibrio, raw_vibrio):
    header, rows = raw_vibrio
    for key in ("Continent", "Source Niche", "Collection Year"):
        i = header.index(key)
        want = collections.Counter(
            (row[i].strip() if i < len(row) else "") or None for row in rows
        )
        got = {s.value: s.count for s in value_counts(vibrio, key)}
        assert got == {v: c for v, c in want.items() if c}


# --- semantics -------------------------------------------------------------

def test_a_leaf_with_no_isolates_is_reported_not_omitted(vibrio):
    """3.9% of vibrio leaves have no isolate rows; the frontend must be told."""
    (only,) = compositions(vibrio, ["99999999"], "Continent")
    assert only.leaf == "99999999"
    assert only.available == 0 and only.total == 0 and only.segments == []


def test_filtered_out_is_distinguishable_from_no_data(vibrio):
    impossible = compositions(
        vibrio, ["1"], "Continent", {"Source Niche": ["Laboratory"]}
    )[0]
    assert impossible.available > 0, "this leaf does have isolates"
    assert impossible.total == 0, "but none survive the filter"


def test_blank_values_are_a_segment_not_a_dropped_row(vibrio, raw_vibrio):
    """11,699 of 26,629 vibrio rows have no Source Niche; they are still isolates."""
    counts = value_counts(vibrio, "Source Niche")
    blank = [s for s in counts if s.value is None]
    assert blank and blank[0].count == 11_699
    assert sum(s.count for s in counts) == vibrio.meta.n_rows


def test_order_of_requested_leaves_is_preserved(vibrio):
    leaves = ["15", "1", "3", "2"]
    assert [c.leaf for c in compositions(vibrio, leaves, "Continent")] == leaves


def test_duplicate_leaves_are_each_answered(vibrio):
    got = compositions(vibrio, ["1", "1"], "Continent")
    assert len(got) == 2 and got[0].total == got[1].total


def test_empty_leaf_list_is_empty_result(vibrio):
    assert compositions(vibrio, [], "Continent") == []


# --- errors ----------------------------------------------------------------

def test_unknown_facet_is_refused(vibrio):
    with pytest.raises(UnknownFacet):
        compositions(vibrio, ["1"], "Nonexistent")
    with pytest.raises(UnknownFacet):
        compositions(vibrio, ["1"], "Continent", {"Nonexistent": ["x"]})


def test_a_filter_value_that_matches_nothing_is_an_error(vibrio):
    """Silently returning nothing would look the same as a very selective filter."""
    with pytest.raises(UnknownValue, match="Continent"):
        compositions(vibrio, ["1"], "Source Niche", {"Continent": ["Atlantis"]})


# --- facet selection -------------------------------------------------------

def test_identifiers_and_the_join_key_are_not_facets(vibrio):
    names = {f.name for f in vibrio.meta.facets}
    for excluded in ("Uberstrain", "Barcode", "Sample", "Name", "ST", "Comment"):
        assert excluded not in names
    for included in ("Continent", "Country", "Source Niche", "Collection Year"):
        assert included in names


def test_constant_and_identifier_like_columns_are_dropped(vibrio):
    names = {f.name for f in vibrio.meta.facets}
    assert "Differences" not in names, "one distinct value: cannot divide anything"
    assert "HC0" not in names, "17,935 distinct values in 26,629 rows: an identifier"


def test_wide_facets_are_kept_but_not_marked_segmentable(vibrio):
    by_name = vibrio.meta.facet_by_name
    assert by_name["Source Details"].segmentable is False
    assert by_name["Continent"].segmentable is True


def test_slug_is_filesystem_safe():
    assert slug("HC800 (ceBG)") == "hc800_cebg"
    assert slug("Source Niche") == "source_niche"
    assert slug("!!!") == "column"


def test_facet_rules():
    assert is_identifier("Uberstrain") and is_identifier("Data Source(Accession No.)")
    assert not is_facet("ST", 100)
    assert not is_facet("Anything", 1)
    assert not is_facet("Anything", 999_999)
    assert is_facet("Country", 145)


# --- store -----------------------------------------------------------------

def test_sequence_types_index_contiguous_rows(vibrio, raw_vibrio):
    header, rows = raw_vibrio
    st_i = header.index("ST")
    counts = collections.Counter(r[st_i].strip() for r in rows)
    for st in ("1", "3", "15"):
        start, end = vibrio.rows_for(st)
        assert end - start == counts[st]


def test_both_species_ingest_independently(isolate_store):
    """ST numbering restarts per species, so the stores share no namespace."""
    vibrio = read_isolates(isolate_store / "vibrio")
    clostridium = read_isolates(isolate_store / "clostridium")
    assert vibrio.meta.n_rows == 26_629
    assert clostridium.meta.n_rows == 38_597
    # Both have an ST 11, and they are unrelated organisms.
    assert vibrio.rows_for("11") != (0, 0)
    assert clostridium.rows_for("11") != (0, 0)


def test_store_is_much_smaller_than_the_tsv(isolate_store):
    for species, tsv in (("vibrio", "vibrio.tsv"), ("clostridium", "clostridium.tsv")):
        source = (DATASETS / "isolated_data" / tsv).stat().st_size
        stored = sum(
            p.stat().st_size for p in (isolate_store / species).iterdir() if p.is_file()
        )
        assert stored < source / 4, f"{species}: {source} -> {stored}"


# --- the API ---------------------------------------------------------------

@pytest.fixture()
def client(isolate_store, monkeypatch):
    from fastapi.testclient import TestClient

    from phylodelta import config, db
    from phylodelta.api.app import create_app
    from phylodelta.isolates import registry

    db.reset()
    monkeypatch.setattr(config, "STORE_DIR", isolate_store.parent)
    monkeypatch.setattr(config, "ISOLATES_DIR", isolate_store)
    registry.reset_cache()
    yield TestClient(create_app())
    registry.reset_cache()


def test_keys_endpoint(client):
    body = client.get("/api/v1/isolates/vibrio/keys").json()
    assert body["n_isolates"] == 26_629
    assert body["n_sequence_types"] == 18_831
    names = {f["name"] for f in body["facets"]}
    assert "Continent" in names and "Uberstrain" not in names


def test_values_endpoint_for_one_key(client):
    (body,) = client.get(
        "/api/v1/isolates/vibrio/values", params={"key": "Continent"}
    ).json()
    assert body["key"] == "Continent"
    assert body["values"][0]["count"] >= body["values"][-1]["count"]


def test_values_endpoint_accepts_several_keys(client):
    body = client.get(
        "/api/v1/isolates/vibrio/values", params=[("key", "Continent"), ("key", "Source Niche")]
    ).json()
    assert [v["key"] for v in body] == ["Continent", "Source Niche"]


def test_compositions_endpoint(client):
    body = client.post(
        "/api/v1/isolates/vibrio/compositions",
        json={
            "leaves": ["1", "3", "99999999"],
            "segment_by": "Continent",
            "filter": {"Source Niche": ["Human", "Environment"]},
        },
    ).json()
    assert [leaf["leaf"] for leaf in body["leaves"]] == ["1", "3", "99999999"]
    missing = body["leaves"][-1]
    assert missing["available"] == 0 and missing["segments"] == []


def test_unknown_species_does_not_list_what_exists(client):
    """It used to name the available species. That leaks.

    Once datasets are owned, an error message enumerating what exists tells a
    caller about data they cannot reach. The hint now points at /datasets,
    which answers the same question scoped to the caller.
    """
    r = client.get("/api/v1/isolates/nope/keys")
    assert r.status_code == 404
    body = r.json()
    assert body["code"] == "isolates_not_found"
    assert "vibrio" not in body["hint"]
    assert "clostridium" not in body["hint"]
    assert "datasets" in body["hint"]


def test_unknown_key_is_404(client):
    assert client.get(
        "/api/v1/isolates/vibrio/values", params={"key": "Nope"}
    ).status_code == 404
    assert client.post(
        "/api/v1/isolates/vibrio/compositions",
        json={"leaves": ["1"], "segment_by": "Nope"},
    ).status_code == 404


def test_unmatchable_filter_value_is_422_not_an_empty_answer(client):
    r = client.post(
        "/api/v1/isolates/vibrio/compositions",
        json={"leaves": ["1"], "segment_by": "Continent",
              "filter": {"Continent": ["Atlantis"]}},
    )
    assert r.status_code == 422
    assert r.json()["code"] == "unknown_filter_value"


def test_composition_for_a_whole_slice_is_quick(client):
    """The real shape of the request: one call per visible slice."""
    import time

    leaves = [str(n) for n in range(1, 501)]
    started = time.perf_counter()
    r = client.post(
        "/api/v1/isolates/vibrio/compositions",
        json={"leaves": leaves, "segment_by": "Country",
              "filter": {"Source Niche": ["Human"]}},
    )
    elapsed_ms = (time.perf_counter() - started) * 1000
    assert r.status_code == 200
    assert len(r.json()["leaves"]) == 500
    assert elapsed_ms < 200, f"{elapsed_ms:.0f} ms for 500 leaves"
