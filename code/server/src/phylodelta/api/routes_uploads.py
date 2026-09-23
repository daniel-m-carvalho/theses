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

from .. import db, uploads
from . import errors
from .identity import current_owner
from .routes_meta import API_PREFIX
from .schemas import ComparisonStatusResponse, UploadAccepted

router = APIRouter(prefix=f"{API_PREFIX}/comparisons", tags=["comparisons"])


def _isoformat(value) -> str | None:
    return value.isoformat() if value is not None else None


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
) -> UploadAccepted:
    """Receive a bundle and record it as pending.

    Defined with `def` rather than `async def` on purpose: reading an upload is
    blocking file I/O, and FastAPI runs a sync endpoint on a threadpool. In an
    `async def` the same reads would stall the event loop for every other
    request in the process — with 75 MB bundles, visibly.
    """
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
        created_at=_isoformat(record.created_at) or "",
        finished_at=_isoformat(record.finished_at),
        error=record.error,
        ready=record.status is db.ComparisonStatus.READY,
    )
