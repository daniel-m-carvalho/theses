"""Authentication: the interceptor, and the middleware that runs it.

Two kinds of test here. The first is that the seam holds — nothing downstream
can tell which interceptor ran, and no route escapes it. The second is that the
JWT interceptor actually verifies, which means proving the standard ways of
making a JWT check useless are refused rather than assuming the library handles
them.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from starlette.requests import Request

from phylodelta.api import errors
from phylodelta.api.auth import (
    AuthenticationMiddleware,
    HeaderInterceptor,
    JwtInterceptor,
    MockInterceptor,
    Principal,
    select,
)

ISSUER = "https://accounts.example.org"
AUDIENCE = "phylodelta"
SECRET = "a-shared-secret-for-tests-long-enough-for-hs256"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _hs256_signed_with(claims: dict, secret: str) -> str:
    """An HS256 token whose MAC key is `secret`, assembled without PyJWT."""
    head = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = _b64(json.dumps(claims).encode())
    signing_input = f"{head}.{body}".encode()
    mac = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    return f"{head}.{body}.{_b64(mac)}"


def fake_request(headers: dict[str, str] | None = None) -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request({"type": "http", "method": "GET", "path": "/", "headers": raw})


@pytest.fixture(scope="module")
def rsa_keys():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    public = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    return private, public


def hs256(**overrides) -> str:
    claims = {
        "sub": "user-123",
        "iss": ISSUER,
        "aud": AUDIENCE,
        "exp": int(time.time()) + 300,
        "email": "someone@example.org",
        "name": "Some One",
    }
    claims.update(overrides)
    return jwt.encode(claims, SECRET, algorithm="HS256")


@pytest.fixture
def verifier() -> JwtInterceptor:
    return JwtInterceptor(
        issuer=ISSUER, audience=AUDIENCE, secret=SECRET, algorithms=("HS256",)
    )


# --- the mock ---------------------------------------------------------------

def test_the_mock_accepts_anything_and_says_so(monkeypatch):
    """It verifies nothing -- and the principal records that.

    The flag matters: once a mock principal looks like any other, a deployment
    running unauthenticated is indistinguishable from one that is not.
    """
    monkeypatch.delenv("PHYLODELTA_MOCK_OWNER", raising=False)
    interceptor = MockInterceptor()
    principal = interceptor.authenticate(fake_request())
    assert principal.subject == "local"
    assert principal.mock is True
    # Same principal whatever the request carries, including a bogus token.
    other = interceptor.authenticate(fake_request({"authorization": "Bearer nonsense"}))
    assert other.owner_id == principal.owner_id


def test_the_mock_owner_matches_what_the_pipeline_writes():
    """So a catalogue built by `build-all` is readable in the demo."""
    from phylodelta.api.identity import SINGLE_OWNER

    assert MockInterceptor().authenticate(fake_request()).owner_id == SINGLE_OWNER


# --- selection --------------------------------------------------------------

@pytest.mark.parametrize("value,expected", [("", "mock"), ("none", "mock"), ("mock", "mock"), ("header", "header")])
def test_the_mode_selects_the_interceptor(monkeypatch, value, expected):
    monkeypatch.setenv("PHYLODELTA_AUTH", value)
    assert select().name == expected


def test_an_unknown_mode_is_refused(monkeypatch):
    monkeypatch.setenv("PHYLODELTA_AUTH", "whatever")
    with pytest.raises(RuntimeError, match="expected"):
        select()


def test_jwt_without_an_audience_is_refused():
    """A token minted for another service by the same provider would otherwise
    be accepted here."""
    with pytest.raises(RuntimeError, match="AUDIENCE"):
        JwtInterceptor(issuer=ISSUER, audience="", secret=SECRET)


def test_jwt_without_any_key_is_refused():
    with pytest.raises(RuntimeError, match="JWKS_URL|SECRET"):
        JwtInterceptor(issuer=ISSUER, audience=AUDIENCE)


def test_a_short_hmac_secret_is_refused():
    """RFC 7518 §3.2. A guessable shared secret is not authentication, and a
    warning in a log is not something anyone reads before going live."""
    with pytest.raises(RuntimeError, match="32 bytes"):
        JwtInterceptor(
            issuer=ISSUER, audience=AUDIENCE, secret="short", algorithms=("HS256",)
        )


def test_none_is_not_an_algorithm():
    with pytest.raises(RuntimeError, match="not a signature algorithm"):
        JwtInterceptor(
            issuer=ISSUER, audience=AUDIENCE, secret=SECRET, algorithms=("none",)
        )


# --- the JWT interceptor actually verifies ----------------------------------

def test_a_valid_token_is_accepted(verifier):
    principal = verifier.authenticate(fake_request({"authorization": f"Bearer {hs256()}"}))
    assert principal.subject == "user-123"
    assert principal.email == "someone@example.org"
    assert principal.mock is False


def test_the_owner_id_is_namespaced_by_issuer(verifier):
    """Two providers can both mint `sub: 12345`.

    Without namespacing, adding a second identity provider would silently
    merge two people -- one would inherit the other's datasets.
    """
    principal = verifier.authenticate(fake_request({"authorization": f"Bearer {hs256()}"}))
    assert principal.owner_id == f"{ISSUER}:user-123"
    assert Principal(subject="user-123").owner_id == "user-123"


def test_a_missing_token_is_refused(verifier):
    with pytest.raises(errors.ApiError) as refused:
        verifier.authenticate(fake_request())
    assert refused.value.status == 401
    assert refused.value.code == "token_required"


@pytest.mark.parametrize(
    "header",
    ["Basic abc", "Bearer", "Bearer ", "token abc", ""],
)
def test_a_malformed_authorization_header_is_refused(verifier, header):
    with pytest.raises(errors.ApiError):
        verifier.authenticate(fake_request({"authorization": header}))


def test_an_expired_token_is_refused(verifier):
    token = hs256(exp=int(time.time()) - 3600)
    with pytest.raises(errors.ApiError) as refused:
        verifier.authenticate(fake_request({"authorization": f"Bearer {token}"}))
    assert refused.value.code == "token_expired"


def test_a_token_from_another_issuer_is_refused(verifier):
    token = hs256(iss="https://evil.example.com")
    with pytest.raises(errors.ApiError) as refused:
        verifier.authenticate(fake_request({"authorization": f"Bearer {token}"}))
    assert refused.value.code == "token_invalid"


def test_a_token_for_another_service_is_refused(verifier):
    """A signature proves who minted it, not who it was minted for."""
    token = hs256(aud="some-other-service")
    with pytest.raises(errors.ApiError) as refused:
        verifier.authenticate(fake_request({"authorization": f"Bearer {token}"}))
    assert refused.value.code == "token_invalid"


def test_a_token_signed_with_the_wrong_key_is_refused(verifier):
    token = jwt.encode(
        {"sub": "u", "iss": ISSUER, "aud": AUDIENCE, "exp": int(time.time()) + 300},
        "not-the-secret",
        algorithm="HS256",
    )
    with pytest.raises(errors.ApiError):
        verifier.authenticate(fake_request({"authorization": f"Bearer {token}"}))


def test_a_tampered_token_is_refused(verifier):
    good = hs256()
    head, payload, signature = good.split(".")
    tampered = f"{head}.{payload}x.{signature}"
    with pytest.raises(errors.ApiError):
        verifier.authenticate(fake_request({"authorization": f"Bearer {tampered}"}))


def test_a_token_without_a_subject_is_refused(verifier):
    """There would be nothing to own the data."""
    token = jwt.encode(
        {"iss": ISSUER, "aud": AUDIENCE, "exp": int(time.time()) + 300},
        SECRET,
        algorithm="HS256",
    )
    with pytest.raises(errors.ApiError):
        verifier.authenticate(fake_request({"authorization": f"Bearer {token}"}))


def test_an_unsigned_token_is_refused(verifier):
    """`alg: none` is a token that says it needs no signature."""
    unsigned = jwt.encode(
        {"sub": "u", "iss": ISSUER, "aud": AUDIENCE, "exp": int(time.time()) + 300},
        key="",
        algorithm="none",
    )
    with pytest.raises(errors.ApiError):
        verifier.authenticate(fake_request({"authorization": f"Bearer {unsigned}"}))


def test_algorithm_confusion_is_refused(rsa_keys):
    """The classic attack on a verifier that trusts the token's own `alg`.

    An RS256 deployment publishes its public key. An attacker re-signs a token
    with HS256, using that public key as the HMAC secret; a verifier that reads
    the algorithm from the token will happily verify it and accept a forgery.
    Pinning the algorithms by configuration is what refuses it.
    """
    private, public = rsa_keys
    verifier = JwtInterceptor(
        issuer=ISSUER, audience=AUDIENCE, secret=public, algorithms=("RS256",)
    )
    claims = {"sub": "attacker", "iss": ISSUER, "aud": AUDIENCE, "exp": int(time.time()) + 300}

    # Built by hand: PyJWT refuses to *encode* this, which is good defence in
    # its own right but would mean the test never reached our verifier.
    forged = _hs256_signed_with(claims, secret=public)
    with pytest.raises(errors.ApiError):
        verifier.authenticate(fake_request({"authorization": f"Bearer {forged}"}))

    # The genuine article still works, so the refusal is not just breakage.
    verifier._key = lambda _token: public
    legitimate = jwt.encode(claims, private, algorithm="RS256")
    assert (
        verifier.authenticate(
            fake_request({"authorization": f"Bearer {legitimate}"})
        ).subject
        == "attacker"
    )


def test_refusals_do_not_say_which_check_failed(verifier):
    """Otherwise a forger learns which thing to fix next."""
    wrong_issuer = hs256(iss="https://evil.example.com")
    wrong_audience = hs256(aud="elsewhere")
    bad_signature = jwt.encode(
        {"sub": "u", "iss": ISSUER, "aud": AUDIENCE, "exp": int(time.time()) + 300},
        "wrong",
        algorithm="HS256",
    )
    seen = set()
    for token in (wrong_issuer, wrong_audience, bad_signature):
        with pytest.raises(errors.ApiError) as refused:
            verifier.authenticate(fake_request({"authorization": f"Bearer {token}"}))
        seen.add((refused.value.code, refused.value.detail))
    assert len(seen) == 1, seen


# --- the middleware ---------------------------------------------------------

class Broken:
    name = "broken"

    def authenticate(self, request):
        raise RuntimeError("the identity provider is on fire")


@pytest.fixture
def app_with(monkeypatch):
    from phylodelta import config, db
    from phylodelta.api.app import create_app

    def build(interceptor, tmp_path):
        monkeypatch.setattr(config, "STORE_DIR", tmp_path)
        monkeypatch.setattr(config, "TREES_DIR", tmp_path / "trees")
        monkeypatch.setenv("PHYLODELTA_AUTH", "mock")
        db.reset()
        application = create_app()
        # Replace the selected interceptor with the one under test.
        for layer in application.user_middleware:
            if layer.cls is AuthenticationMiddleware:
                layer.kwargs["interceptor"] = interceptor
        application.middleware_stack = None
        return TestClient(application, raise_server_exceptions=False)

    return build


def test_a_broken_interceptor_fails_closed(app_with, tmp_path):
    """It must not hand the application an unauthenticated request.

    Failing open here would be the worst possible outcome: every route would
    run, and `current_owner` would be the only thing between a stranger and
    somebody's data.
    """
    client = app_with(Broken(), tmp_path)
    response = client.get("/api/v1/datasets")
    assert response.status_code == 503
    assert response.json()["code"] == "auth_unavailable"


def test_health_answers_without_credentials(app_with, tmp_path):
    """So an orchestrator can check liveness without holding a token."""
    client = app_with(HeaderInterceptor(), tmp_path)
    assert client.get("/api/v1/health").status_code == 200


def test_the_documentation_is_public(app_with, tmp_path):
    client = app_with(HeaderInterceptor(), tmp_path)
    assert client.get("/openapi.json").status_code == 200


def test_a_preflight_is_not_refused(app_with, tmp_path):
    """A browser sends OPTIONS without credentials by design; a 401 there would
    surface as a CORS error and hide the real one."""
    client = app_with(HeaderInterceptor(), tmp_path)
    response = client.options(
        "/api/v1/datasets",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200


def test_routes_receive_the_principal_the_interceptor_returned(app_with, tmp_path):
    client = app_with(MockInterceptor(subject="someone-else"), tmp_path)
    body = client.get("/api/v1/me").json()
    assert body["owner_id"] == "someone-else"
    assert body["mock"] is True


def test_swapping_the_interceptor_changes_nothing_downstream(app_with, tmp_path):
    """The property the whole design exists for.

    Two different interceptors, the same routes, the same handlers, the same
    response shape -- only the identity differs. Integrating with PHYLOViZ is
    writing one of these, not touching anything below it.
    """
    mocked = app_with(MockInterceptor(subject="demo-user"), tmp_path).get("/api/v1/me")
    headed = app_with(HeaderInterceptor(), tmp_path).get(
        "/api/v1/me", headers={"X-PhyloDelta-Owner": "real-user"}
    )
    assert mocked.status_code == headed.status_code == 200
    assert set(mocked.json()) == set(headed.json())
    assert mocked.json()["owner_id"] == "demo-user"
    assert headed.json()["owner_id"] == "real-user"
    assert headed.json()["mock"] is False
