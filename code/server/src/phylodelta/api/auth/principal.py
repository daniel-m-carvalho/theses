"""Who a request is for, once something has decided.

One type, whatever authenticated the request. A mock principal and one built
from a Google token are the same shape, so nothing downstream can tell them
apart — which is the property that makes swapping the interceptor a real swap
rather than a rewrite.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class Principal:
    """An authenticated caller.

    ``subject`` is the **owner id**: the value that goes into `Dataset.owner_id`
    and decides what this caller can see. Everything else is descriptive.
    """

    subject: str

    #: Which authority vouched for this. Kept because `subject` alone is not
    #: unique across issuers — two providers can both mint `sub: "12345"` — so
    #: a deployment trusting more than one must namespace. See `owner_id`.
    issuer: str = ""

    email: str = ""
    display_name: str = ""
    scopes: frozenset[str] = field(default_factory=frozenset)

    #: True when nothing was actually verified. Carried so the fact is
    #: visible in logs and at /health rather than being invisible once the
    #: principal looks like any other.
    mock: bool = False

    @property
    def owner_id(self) -> str:
        """The id datasets are owned by.

        Namespaced by issuer where there is one. Without this, adding a second
        identity provider would silently merge two people who happen to share a
        subject id — one would inherit the other's data. With it, ids from
        different issuers cannot collide.

        Unnamespaced when no issuer is configured, which keeps the
        single-operator deployment's existing `local` ownership readable
        instead of orphaning every row on upgrade.
        """
        return f"{self.issuer}:{self.subject}" if self.issuer else self.subject
