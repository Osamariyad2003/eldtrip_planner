"""Django settings for the ELD Trip Planner backend.

Production hardening per NFR-SEC-01..05; environment variables per DEP-01.
"""

from __future__ import annotations

from pathlib import Path
from secrets import token_urlsafe

import environ

BASE_DIR = Path(__file__).resolve().parent.parent

env = environ.Env(
    DEBUG=(bool, False),
    ALLOWED_HOSTS=(list, ["localhost", "127.0.0.1"]),
    CORS_ALLOWED_ORIGINS=(list, ["http://localhost:5173"]),
    ORS_API_KEY=(str, ""),
    NOMINATIM_USER_AGENT=(str, "eld-trip-planner/1.0 (+https://github.com/)"),
    APP_VERSION=(str, "1.0.0"),
    RATE_LIMIT_PER_MINUTE=(int, 30),
    PROVIDER_TIMEOUT_SECONDS=(float, 10.0),
    GEOCODE_CACHE_SECONDS=(int, 60 * 60 * 24),
)
environ.Env.read_env(BASE_DIR / ".env")

# NFR-SEC-04: no shared fallback secret. A published default would become the
# signing key of every deployment that forgets to set SECRET_KEY, so an unset
# key yields a random per-process one instead: it carries the
# "django-insecure-" prefix that `manage.py check --deploy` fails on, and it is
# never a value an attacker can look up in this repository.
SECRET_KEY = env("SECRET_KEY", default="") or f"django-insecure-{token_urlsafe(50)}"
DEBUG = env("DEBUG")
ALLOWED_HOSTS = env("ALLOWED_HOSTS")

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.staticfiles",
    "corsheaders",
    "rest_framework",
    "planner",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "planner.middleware.RequestLogMiddleware",
]

# No CSRF middleware: the API is stateless and unauthenticated, sets no
# cookies and uses no session, so there is no ambient credential for a
# cross-site request to ride on. Cross-origin access is limited by API-06.
#
# That decision is silenced explicitly so the deployment check can run at
# --fail-level WARNING in CI: an accepted warning is recorded here once,
# instead of every other warning being ignored along with it.
SILENCED_SYSTEM_CHECKS = ["security.W003"]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": []},
    }
]

# The app stores no trip data (section 7). SQLite exists only to back the
# provider-response cache table (CacheEntry, FR-GEO-04).
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": env("DATABASE_PATH", default=str(BASE_DIR / "cache.sqlite3")),
    }
}
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.db.DatabaseCache",
        "LOCATION": "provider_cache",
        "TIMEOUT": env("GEOCODE_CACHE_SECONDS"),
        "OPTIONS": {"MAX_ENTRIES": 10_000, "CULL_FREQUENCY": 4},
    }
}

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = False
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "EXCEPTION_HANDLER": "planner.errors.exception_handler",
    "UNAUTHENTICATED_USER": None,
}

# API-06: only the production frontend origin and the local dev server.
CORS_ALLOWED_ORIGINS = env("CORS_ALLOWED_ORIGINS")
CORS_ALLOW_CREDENTIALS = False

# API-05
RATE_LIMIT_PER_MINUTE = env("RATE_LIMIT_PER_MINUTE")

# INT-05, INT-06
PROVIDER_TIMEOUT_SECONDS = env("PROVIDER_TIMEOUT_SECONDS")
ORS_API_KEY = env("ORS_API_KEY")
NOMINATIM_USER_AGENT = env("NOMINATIM_USER_AGENT")
GEOCODE_CACHE_SECONDS = env("GEOCODE_CACHE_SECONDS")
APP_VERSION = env("APP_VERSION")

if not DEBUG:
    # NFR-SEC-01
    SECURE_SSL_REDIRECT = env("SECURE_SSL_REDIRECT", default=True)
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SECURE_HSTS_SECONDS = 31_536_000
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True
    SECURE_CONTENT_TYPE_NOSNIFF = True
    X_FRAME_OPTIONS = "DENY"

# NFR-OBS-01: structured JSON request logs.
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "json": {"()": "planner.logging_config.JsonFormatter"},
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "json"},
    },
    "root": {"handlers": ["console"], "level": "INFO"},
    "loggers": {
        "django.request": {"handlers": ["console"], "level": "ERROR", "propagate": False},
    },
}
