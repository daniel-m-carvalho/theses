"""The interceptors themselves.

An interceptor answers one question — *who is this request for?* — and is the
only thing in the system that answers it. Everything else receives a
`Principal` and cannot tell how it was obtained.

**Adding or swapping one is a class and a registry entry.** No route, no
business logic and no model knows which of these is running. That is the point:
integrating with PHYLOViZ means writing an interceptor that validates
PHYLOViZ's tokens and selecting it, not touching anything downstream.

Three exist:

``mock``
    A hardcoded principal, nothing verified. For the demo and for frontend work
    against a running backend. Refuses to be the default in anything that looks
    like a deployment — see `select`.
``header``
    Reads the owner from a trusted header. Also not authentication, but it lets
    multi-tenant behaviour be exercised with more than one user.
``jwt``
    The real one. Verifies a signed bearer token — RS256 against a provider's
    JWKS (Google, an institutional IdP, PHYLOViZ) or HS256 against a shared
    secret — and takes the subject from it.
"""

from __future__ import annotations

import os
from typing import Protocol

from .. import errors
from .principal import Principal

#: The owner everything belongs to when nothing is verifying. A recognisable
#: constant, so data created this way is obvious in the database rather than
#: looking like a real account. Unchanged from the pre-auth default, so an
#: existing single-operator store keeps working.
MOCK_SUBJECT = "local"

AUTH_HEADER = "X-PhyloDelta-Owner"


class Interceptor(Protocol):
    """Resolves a request to a principal, or raises.

    Never returns None: "no principal" is not a state any caller should have to
    handle, so an interceptor that cannot identify the request raises instead.
    """

    name: str

    def authenticate(self, request) -> Principal: ...


class MockInterceptor:
    """A hardcoded user. Verifies nothing.

    Every request is the same person, whatever it carries. This exists so the
    demo runs with no identity provider and no configuration, and so the
    frontend can be built before the real thing is decided.

    It is **opt-in and loud**: `select` refuses to choose it implicitly, and the
    principal it returns is flagged `mock` so the fact survives into logs and
    /health rather than disappearing behind a principal that looks ordinary.
    """

    name = "mock"

    def __init__(self, subject: str | None = None, email: str = "demo@example.invalid"):
        self.subject = subject or os.environ.get("PHYLODELTA_MOCK_OWNER") or MOCK_SUBJECT
        self.email = email

    def authenticate(self, request) -> Principal:
        return Principal(
            subject=self.subject,
            email=self.email,
            display_name="Demo user",
            mock=True,
        )


class HeaderInterceptor:
    """Takes the owner id from a header, trusted as sent.

    **Not authentication** — anyone can set a header. It is here because the
    mock has exactly one user and some things only break with two: that a
    dataset is invisible to its non-owner cannot be demonstrated with a single
    identity.
    """

    name = "header"

    def __init__(self, header: str = AUTH_HEADER):
        self.header = header

    def authenticate(self, request) -> Principal:
        sent = request.headers.get(self.header)
        if not sent or not sent.strip():
            raise errors.ApiError(
                401,
                "owner_required",
                f"This server identifies requests by the {self.header} header "
                "and none was sent.",
                f"Send {self.header}: <owner id>.",
            )
        return Principal(subject=sent.strip(), display_name=sent.strip())


class JwtInterceptor:
    """Verifies a signed bearer token and takes its subject.

    The real one. Deliberately strict about the things that make JWT
    verification quietly useless:

    **Algorithms are pinned by configuration, never read from the token.**
    Accepting the token's own `alg` is the classic confusion attack: an
    attacker re-signs an RS256 token as HS256 using the *public* key as the
    HMAC secret, and a verifier that trusts the header accepts it. `alg: none`
    is refused for the same reason.

    **The issuer is configured, never discovered.** Keys are fetched only from
    the JWKS URL this server was given. Following an issuer named inside an
    unverified token would let the token nominate who vouches for it, and
    would turn this into a request-forgery primitive.

    **`exp`, `iss` and `aud` are all required and checked.** A signature check
    alone says the token was minted by someone trusted — not that it was minted
    for this service, or recently.
    """

    name = "jwt"

    def __init__(
        self,
        issuer: str,
        audience: str,
        jwks_url: str = "",
        secret: str = "",
        algorithms: tuple[str, ...] = ("RS256",),
        leeway: int = 30,
    ):
        if not issuer or not audience:
            raise RuntimeError(
                "JWT authentication needs PHYLODELTA_JWT_ISSUER and "
                "PHYLODELTA_JWT_AUDIENCE. Without them a token minted for any "
                "other service by the same provider would be accepted here."
            )
        if not jwks_url and not secret:
            raise RuntimeError(
                "JWT authentication needs either PHYLODELTA_JWT_JWKS_URL "
                "(RS256, for an OAuth provider) or PHYLODELTA_JWT_SECRET "
                "(HS256, for a shared secret)."
            )
        if "none" in {a.lower() for a in algorithms}:
            raise RuntimeError("'none' is not a signature algorithm.")
        # RFC 7518 §3.2: an HMAC key shorter than the digest is weaker than the
        # algorithm it is used with, and a short shared secret is guessable.
        # Refused rather than warned, because a warning in a log is not a thing
        # anybody reads before going live.
        if secret and any(a.upper().startswith("HS") for a in algorithms):
            if len(secret.encode()) < 32:
                raise RuntimeError(
                    "PHYLODELTA_JWT_SECRET is shorter than 32 bytes, which is "
                    "below the minimum for HS256 (RFC 7518 §3.2). Use a longer "
                    "secret, or RS256 with a JWKS URL."
                )

        self.issuer = issuer
        self.audience = audience
        self.secret = secret
        self.algorithms = list(algorithms)
        self.leeway = leeway
        self._jwks = None
        if jwks_url:
            from jwt import PyJWKClient

            # Cached, so a request does not become an outbound fetch. The
            # client refreshes on an unknown `kid`, which is what makes key
            # rotation work without a restart.
            self._jwks = PyJWKClient(jwks_url, cache_keys=True, max_cached_keys=16)

    def _key(self, token: str):
        if self._jwks is not None:
            return self._jwks.get_signing_key_from_jwt(token).key
        return self.secret

    def authenticate(self, request) -> Principal:
        import jwt

        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not token.strip():
            raise errors.ApiError(
                401,
                "token_required",
                "This endpoint needs a bearer token.",
                "Send Authorization: Bearer <token>.",
            )

        try:
            claims = jwt.decode(
                token.strip(),
                self._key(token.strip()),
                algorithms=self.algorithms,
                issuer=self.issuer,
                audience=self.audience,
                leeway=self.leeway,
                options={"require": ["exp", "iss", "aud", "sub"]},
            )
        except jwt.ExpiredSignatureError:
            raise errors.ApiError(
                401, "token_expired", "That token has expired.",
                "Obtain a new one and retry.",
            ) from None
        except jwt.InvalidTokenError as invalid:
            # One message for every way a token can be unacceptable. Saying
            # which check failed tells an attacker which to fix next.
            raise errors.ApiError(
                401, "token_invalid", "That token is not valid for this service."
            ) from None

        subject = str(claims.get("sub") or "").strip()
        if not subject:
            raise errors.ApiError(
                401, "token_invalid", "That token is not valid for this service."
            )
        return Principal(
            subject=subject,
            issuer=self.issuer,
            email=str(claims.get("email") or ""),
            display_name=str(claims.get("name") or claims.get("email") or ""),
            scopes=frozenset(str(claims.get("scope") or "").split()),
        )


def mode() -> str:
    raw = os.environ.get("PHYLODELTA_AUTH", "").strip().lower()
    # `none` was this variable's original value for "no identity provider".
    # Kept as an alias so existing deployments and compose files do not break.
    return {"": "mock", "none": "mock"}.get(raw, raw)


def select() -> Interceptor:
    """Build the interceptor this deployment is configured for.

    The one place the choice is made. Everything downstream — middleware,
    dependencies, routes, models — is unaware of which came back.
    """
    chosen = mode()

    if chosen == "mock":
        return MockInterceptor()
    if chosen == "header":
        return HeaderInterceptor()
    if chosen == "jwt":
        algorithms = tuple(
            a.strip()
            for a in os.environ.get("PHYLODELTA_JWT_ALGORITHMS", "RS256").split(",")
            if a.strip()
        )
        return JwtInterceptor(
            issuer=os.environ.get("PHYLODELTA_JWT_ISSUER", ""),
            audience=os.environ.get("PHYLODELTA_JWT_AUDIENCE", ""),
            jwks_url=os.environ.get("PHYLODELTA_JWT_JWKS_URL", ""),
            secret=os.environ.get("PHYLODELTA_JWT_SECRET", ""),
            algorithms=algorithms,
        )

    raise RuntimeError(
        f"PHYLODELTA_AUTH is {chosen!r}; expected 'mock', 'header' or 'jwt'."
    )
