"""Receiving a comparison bundle.

The upload unit is a **comparison**: two trees and their typing data in one
request (§21). What arrives is stored raw and untouched; parsing and ingestion
happen later, in a job, because a 500k-node tree plus two isolate tables is
seconds of work and a request should not hold a connection open for it.

Three things this module is careful about.

**It streams.** A bundle can be ~75 MB — two 25 MB Newick files and two 12 MB
TSVs — and several concurrent uploads buffered in memory would exhaust a small
container. Files are copied to disk in chunks, and the size limit is enforced
*during* the copy so an oversized upload is refused before it has been written
in full rather than after.

**It validates cheaply at the door, not thoroughly.** A structural check —
non-empty, balanced parentheses, terminated — catches a wrong file immediately,
with an error the user can act on. Full parsing belongs to the job, where a
failure is a recorded status rather than a request that hangs while a 25 MB
file is parsed.

**It leaves nothing behind on failure.** A bundle is accepted whole or not at
all, so a rejected upload does not leave fragments for a later job to trip over.
"""

from __future__ import annotations

import json
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path

from . import config

#: Per file. A 500k-leaf Newick is ~25 MB and an isolate table ~12 MB, so this
#: is generous rather than tight — its job is to stop a mistake or an attack
#: from filling the disk, not to police normal use. The limit is ours to choose
#: because the client will not impose one (§19.6).
DEFAULT_MAX_FILE_BYTES = 128 * 1024 * 1024

#: How much is read at a time. Large enough to be efficient, small enough that
#: the refusal of an oversized file happens promptly.
CHUNK = 1024 * 1024


class UploadRejected(ValueError):
    """The upload cannot be accepted. The message is for the user.

    ``role_hint`` names the field at fault where there is one, so the error can
    point at ``left_tree`` rather than at "the upload".
    """

    def __init__(self, message: str, role_hint: str | None = None):
        super().__init__(message)
        self.role_hint = role_hint


def max_file_bytes() -> int:
    raw = os.environ.get("PHYLODELTA_MAX_UPLOAD_BYTES")
    if not raw:
        return DEFAULT_MAX_FILE_BYTES
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_MAX_FILE_BYTES


def new_id() -> str:
    """An opaque dataset id.

    Not derived from the filename: two users uploading `tree.nwk` must not
    collide, and a name is not an identity (§19.2).
    """
    return uuid.uuid4().hex[:12]


@dataclass(frozen=True, slots=True)
class StoredFile:
    """One file that arrived, as it sits on disk."""

    role: str
    path: Path
    original_name: str
    size_bytes: int


@dataclass(frozen=True, slots=True)
class Bundle:
    """An accepted upload: two trees, optional typing data, one directory.

    The bundle is the unit because a comparison is (§21). Keeping the four
    files together under the comparison's own id means the job that ingests
    them needs one path and no joins, and that discarding a failed or expired
    comparison is one ``rmtree``.
    """

    comparison_id: str
    left_id: str
    right_id: str
    directory: Path
    files: dict[str, StoredFile]
    display_name: str
    #: What the uploader says each tree is. Optional, and empty when not
    #: declared — which the pipeline reports as unknown rather than assuming
    #: the two match.
    left_species: str = ""
    right_species: str = ""


def uploads_dir() -> Path:
    return Path(config.STORE_DIR) / "uploads"


def _stream_to(source, destination: Path, limit: int) -> int:
    """Copy in chunks, refusing as soon as the limit is passed."""
    written = 0
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as out:
        while True:
            chunk = source.read(CHUNK)
            if not chunk:
                break
            written += len(chunk)
            if written > limit:
                # Stop here rather than finish the copy and check afterwards:
                # the point of a limit is not to write the bytes.
                out.close()
                destination.unlink(missing_ok=True)
                raise UploadRejected(
                    f"file exceeds the {_human(limit)} limit", role_hint=destination.stem
                )
            out.write(chunk)
    return written


def _human(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / 1024 / 1024:,.0f} MB"
    if size >= 1024:
        return f"{size / 1024:,.0f} KB"
    return f"{size} bytes"


def _looks_like_newick(path: Path) -> bool:
    """A structural check, not a parse.

    Reads the head and tail rather than the whole file: enough to reject a PDF
    or an empty file, cheap on a 25 MB one. Whether it is *valid* Newick is the
    job\'s problem, where the answer becomes a recorded status rather than a
    request held open while a large file is parsed.
    """
    size = path.stat().st_size
    if size == 0:
        return False
    with path.open("rb") as handle:
        head = handle.read(4096).lstrip()
        handle.seek(max(0, size - 4096))
        tail = handle.read(4096).rstrip()
    return head.startswith(b"(") and tail.endswith(b";")


def _looks_like_table(path: Path) -> bool:
    """Non-empty, with a header naming more than one tab-separated column."""
    if path.stat().st_size == 0:
        return False
    with path.open("rb") as handle:
        first = handle.readline()
    return first.count(b"\t") >= 1


#: role -> (required, checker, suffix)
ROLES = {
    "left_tree": (True, _looks_like_newick, ".nwk"),
    "right_tree": (True, _looks_like_newick, ".nwk"),
    "left_isolates": (False, _looks_like_table, ".tsv"),
    "right_isolates": (False, _looks_like_table, ".tsv"),
}


def accept(
    sources: dict[str, tuple[str, object]],
    display_name: str = "",
    left_species: str = "",
    right_species: str = "",
    root: Path | None = None,
) -> Bundle:
    """Receive a bundle, streaming each file to disk as it arrives.

    ``sources`` maps a role to ``(original_name, file-like)``. The two tree
    roles are required; the isolate roles are optional, because two trees of
    one species carry their typing data in one table and a pair needing none at
    all is legitimate.

    Whole or not at all: any refusal removes everything already written, so a
    rejected upload leaves nothing for a later job to find and mistake for
    work.
    """
    missing = [r for r, (required, _, _) in ROLES.items() if required and r not in sources]
    if missing:
        raise UploadRejected(f"missing required file(s): {', '.join(sorted(missing))}")
    unknown = set(sources) - set(ROLES)
    if unknown:
        raise UploadRejected(f"unexpected file(s): {', '.join(sorted(unknown))}")

    left_id, right_id = new_id(), new_id()
    comparison_id = f"{left_id}__{right_id}"
    directory = (root or uploads_dir()) / comparison_id
    limit = max_file_bytes()

    stored: dict[str, StoredFile] = {}
    try:
        for role, (original_name, handle) in sources.items():
            _, check, suffix = ROLES[role]
            path = directory / f"{role}{suffix}"
            size = _stream_to(handle, path, limit)
            if not check(path):
                raise UploadRejected(
                    f"{original_name!r} does not look like "
                    + (
                        "a Newick tree (expected '(' \u2026 ';')"
                        if suffix == ".nwk"
                        else "a tab-separated table"
                    ),
                    role_hint=role,
                )
            stored[role] = StoredFile(role, path, original_name, size)
    except Exception:
        discard(directory)
        raise

    bundle = Bundle(
        comparison_id=comparison_id,
        left_id=left_id,
        right_id=right_id,
        directory=directory,
        files=stored,
        display_name=display_name or _default_name(stored),
        left_species=left_species.strip(),
        right_species=right_species.strip(),
    )
    _write_manifest(bundle)
    return bundle


def _default_name(stored: dict[str, StoredFile]) -> str:
    left = Path(stored["left_tree"].original_name).stem
    right = Path(stored["right_tree"].original_name).stem
    return f"{left} vs {right}"


def _write_manifest(bundle: Bundle) -> None:
    """Record what arrived, beside what arrived.

    The database says a comparison is pending; the manifest says which file
    plays which role and what it was called. Keeping it in the directory means
    a bundle is self-describing, so an orphaned upload can be identified — and
    cleaned up — without consulting the database.
    """
    manifest = {
        "comparison_id": bundle.comparison_id,
        "left_id": bundle.left_id,
        "right_id": bundle.right_id,
        "display_name": bundle.display_name,
        "left_species": bundle.left_species,
        "right_species": bundle.right_species,
        "files": {
            role: {
                "path": stored.path.name,
                "original_name": stored.original_name,
                "size_bytes": stored.size_bytes,
            }
            for role, stored in bundle.files.items()
        },
    }
    # Written last and atomically: a directory with a manifest is a complete
    # bundle, and one without is debris from an interrupted upload.
    scratch = bundle.directory / "bundle.json.part"
    scratch.write_text(json.dumps(manifest, indent=2))
    scratch.replace(bundle.directory / "bundle.json")


def read_manifest(directory: Path) -> dict:
    return json.loads((Path(directory) / "bundle.json").read_text())


def discard(directory: Path) -> None:
    """Remove a bundle\'s directory. Safe to call more than once."""
    shutil.rmtree(directory, ignore_errors=True)
