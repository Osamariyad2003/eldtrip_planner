"""Test settings: production-like, but without the HTTPS redirect.

CI runs with no provider keys and all outbound HTTP mocked (section 14).
"""

from .settings import *

DEBUG = False
SECRET_KEY = "test-only-key"
ALLOWED_HOSTS = ["*"]
SECURE_SSL_REDIRECT = False
SECURE_HSTS_SECONDS = 0

ORS_API_KEY = ""
RATE_LIMIT_PER_MINUTE = 1000

DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}

# The locmem cache behaves like the production database cache for our use
# (add / incr / get / set) without needing a table created per test.
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "test",
    }
}

STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}

LOGGING["root"]["level"] = "CRITICAL"
