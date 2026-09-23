"""Authentication: one interceptor in front of every route.

The seam PHYLOViZ integration turns on. Swapping how requests are
authenticated means writing an `Interceptor` and selecting it; routes,
business logic and models do not change, because none of them can see which
one is running.
"""

from .interceptors import (
    AUTH_HEADER,
    MOCK_SUBJECT,
    HeaderInterceptor,
    Interceptor,
    JwtInterceptor,
    MockInterceptor,
    mode,
    select,
)
from .middleware import PUBLIC_PATHS, AuthenticationMiddleware
from .principal import Principal

__all__ = [
    "AUTH_HEADER",
    "MOCK_SUBJECT",
    "AuthenticationMiddleware",
    "HeaderInterceptor",
    "Interceptor",
    "JwtInterceptor",
    "MockInterceptor",
    "PUBLIC_PATHS",
    "Principal",
    "mode",
    "select",
]
