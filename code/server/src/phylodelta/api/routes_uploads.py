"""Accepting comparison bundles, and reporting on them.

A comparison arrives in **one request** (§21): both trees and, where the
species differ, both typing tables. One request because a comparison is the
unit the user is asking for — uploading half of one leaves a state with no
meaning, and a multi-step upload would have to invent a session to hold the
halves together.

The request does not compute anything. Ingesting a 500k-node tree and building
its correspondence is seconds to minutes (§15), which is not a thing to do
while a connection is held open and a proxy's read timeout runs. So the
endpoint does exactly three things — receive the bytes, check they are
plausible, record a `pending` row — and returns **202 Accepted**, which is the
status code that means precisely this: taken, not yet done.

What makes that safe is that `pending` datasets are not servable. `dataset_for`
returns only `ready` rows, so between the upload and the job there is no window
in which a half-built store can be read as though it were finished.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, Path, UploadFile, status

from .. import db, retention, uploads
from . import errors
from .identity import current_owner
from .routes_meta import API_PREFIX
from ..metrics import registry as metric_registry
from .schemas import ComparisonRemoved, ComparisonStatusResponse, UploadAccepted

router = APIRouter(prefix=f"{API_PREFIX}/comparisons", tags=["comparisons"])


def _isoformat(value) -> str | None:
    return value.isoformat() if value is not None else None


#: What a bundle is computed with when the request does not say.
DEFAULT_UPLOAD_METRICS = ["rf"]


def _validated_metrics(raw: str | None) -> list[str]:
    """Parse the requested metric names, or refuse with the list that exists.

    Refusing by name is the whole point: a typo that silently fell back to the
    default would produce a comparison the user did not ask for and cannot tell
    apart from one they did, minutes later and in a different process.
    """
    wanted = [name.strip() for name in (raw or "").split(",") if name.strip()]
    if not wanted:
        return list(DEFAULT_UPLOAD_METRICS)

    known = metric_registry.discover()
    unknown = [name for name in wanted if name not in known]
    if unknown:
        raise errors.ApiError(
            422,
            "unknown_metric",
            f"No metric named {', '.join(repr(name) for name in unknown)}.",
            f"This server has: {', '.join(sorted(known))}.",
        )
    # Order preserved, duplicates dropped: asking for the same metric twice is
    # a slip, not a request to compute it twice.
    seen: dict[str, None] = {}
    for name in wanted:
        seen.setdefault(name, None)
    return list(seen)


@router.post(
    "",
    response_model=UploadAccepted,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Upload two trees and their typing data as one comparison.",
    response_description="Accepted for processing; poll the status endpoint.",
)
def upload_comparison(
    owner: str = Depends(current_owner),
    left_tree: UploadFile = File(description="Newick tree, required."),
    right_tree: UploadFile = File(description="Newick tree, required."),
    left_isolates: UploadFile | None = File(
        default=None,
        description=(
            "Typing data for the left tree, tab-separated. Optional: omit it "
            "when there is none, or send it only once when both trees are the "
            "same species."
        ),
    ),
    right_isolates: UploadFile | None = File(
        default=None, description="Typing data for the right tree, tab-separated."
    ),
    name: str | None = Form(
        default=None,
        description="What to call this comparison. Defaults to the two filenames.",
    ),
    left_species: str | None = Form(
        default=None,
        description=(
            "What organism the left tree is. Optional. Given for both trees, "
            "it is what lets the result say whether matching leaf labels mean "
            "the same organisms — sequence types are numbered per species, so "
            "across species an identical label is a coincidence. Left out, the "
            "result says species was not declared rather than assuming."
        ),
    ),
    right_species: str | None = Form(default=None, description="As left_species."),
    metrics: str | None = Form(
        default=None,
        description=(
            "Which comparison metrics to compute, comma-separated. Defaults to "
            "`rf`. GET /api/v1/metrics lists what this server has and which are "
            "available. Several cost little more than one: the reconciliation "
            "and the clade correspondence are done once per pair and every "
            "metric runs against them."
        ),
        examples=["rf", "rf,triplet"],
    ),
) -> UploadAccepted:
    """Receive a bundle and record it as pending.

    The metric choice is validated **first**, before any bytes are read: the
    names are in the request, so refusing an unknown one after streaming a
    hundred megabytes to disk would be work spent to reach an answer that was
    available immediately.

    Defined with `def` rather than `async def` on purpose: reading an upload is
    blocking file I/O, and FastAPI runs a sync endpoint on a threadpool. In an
    `async def` the same reads would stall the event loop for every other
    request in the process — with 75 MB bundles, visibly.
    """
    chosen = _validated_metrics(metrics)

    sources = {
        role: (upload.filename or role, upload.file)
        for role, upload in (
            ("left_tree", left_tree),
            ("right_tree", right_tree),
            ("left_isolates", left_isolates),
            ("right_isolates", right_isolates),
        )
        if upload is not None and upload.filename
    }

    try:
        bundle = uploads.accept(
            sources,
            display_name=(name or "").strip(),
            left_species=(left_species or "").strip(),
            right_species=(right_species or "").strip(),
        )
    except uploads.UploadRejected as rejected:
        raise errors.bad_request(
            "upload_rejected",
            str(rejected),
            (
                f"Check the {rejected.role_hint!r} part of the request."
                if rejected.role_hint
                else "Send left_tree and right_tree as multipart file parts."
            ),
        ) from None

    try:
        db.record_upload(
            comparison_id=bundle.comparison_id,
            left_id=bundle.left_id,
            right_id=bundle.right_id,
            owner_id=owner,
            display_name=bundle.display_name,
            left_source=bundle.files["left_tree"].original_name,
            right_source=bundle.files["right_tree"].original_name,
            store_path=f"pairs/{bundle.comparison_id}",
            metrics=",".join(chosen),
        )
    except Exception:
        # The bytes are on disk but nothing refers to them. Remove them rather
        # than leave an orphan that no owner can reach and no job will claim.
        uploads.discard(bundle.directory)
        raise

    return UploadAccepted(
        id=bundle.comparison_id,
        status="pending",
        left_id=bundle.left_id,
        right_id=bundle.right_id,
        poll=f"{API_PREFIX}/comparisons/{bundle.comparison_id}/status",
    )


@router.get(
    "/{comparison_id}/status",
    response_model=ComparisonStatusResponse,
    summary="Whether an uploaded comparison is ready yet.",
)
def comparison_status(
    owner: str = Depends(current_owner),
    comparison_id: str = Path(description="The id returned by the upload."),
) -> ComparisonStatusResponse:
    """Poll here after uploading.

    Answers in every status, including `failed` — which is the point. A client
    that can only observe success has to distinguish "still working" from
    "never going to work" by waiting, and the honest answer is available here
    as soon as the job records it.
    """
    record = db.comparison_for(owner, comparison_id)
    if record is None:
        # Same 404 for "not yours" as for "no such id" — see api/access.py.
        raise errors.not_found(
            "comparison_not_found",
            f"No comparison {comparison_id!r}.",
            "GET /api/v1/datasets lists what you have.",
        )
    return ComparisonStatusResponse(
        id=record.id,
        status=record.status.value,
        display_name=record.display_name or record.id,
        metrics=[m for m in (record.metrics or "").split(",") if m],
        created_at=_isoformat(record.created_at) or "",
        finished_at=_isoformat(record.finished_at),
        error=record.error,
        ready=record.status is db.ComparisonStatus.READY,
    )


@router.delete(
    "/{comparison_id}",
    response_model=ComparisonRemoved,
    summary="Delete a comparison and the data only it was using.",
)
def delete_comparison(
    owner: str = Depends(current_owner),
    comparison_id: str = Path(description="The comparison to remove."),
) -> ComparisonRemoved:
    """Remove a comparison, its trees and its typing data.

    **This is the only way data leaves.** There is no expiry clock and no
    quota: a comparison lives until someone deletes it (§26). A sweep that
    removed results on a timer would risk taking one out from under work in
    progress, which on a single research VM is the worse failure.

    Removes the derived stores as well as the rows — removing the row alone
    would leave the expensive half on disk, which is the problem this solves.
    Trees still referenced by another comparison are kept.

    Deleting a comparison that is **currently being computed** is allowed. The
    worker notices its row has gone and discards what it built, rather than
    finishing into a comparison nobody can reach.
    """
    removed = retention.remove_comparison(owner, comparison_id)
    if removed is None:
        # The same 404 a stranger gets, so deletion cannot probe for existence.
        raise errors.not_found(
            "comparison_not_found",
            f"No comparison {comparison_id!r}.",
            "GET /api/v1/datasets lists what you have.",
        )
    return ComparisonRemoved(
        id=removed.comparison_id,
        datasets_removed=removed.datasets,
        bytes_freed=removed.bytes_freed,
    )
