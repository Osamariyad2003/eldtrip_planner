# Python 3.12, not whatever is newest.
#
# timezonefinder (INT-04) ships binary wheels for cp39-cp313 only, and cffi,
# which it depends on, is the same. On 3.14 pip falls back to building both
# from source, and python:*-slim has no compiler, so the build dies with
# "No such file or directory: 'gcc'". 3.12 is also the version CI and
# render.yaml pin, so the deployed interpreter matches the tested one.
#
# NOTE: `fly launch` rewrites this file from its own template. Use `fly deploy`
# for subsequent deploys, or this comes back as 3.14 and the build fails again.
ARG PYTHON_VERSION=3.12-slim

FROM python:${PYTHON_VERSION}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /code

COPY requirements.txt /tmp/requirements.txt
RUN set -ex && \
    pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /tmp/requirements.txt

COPY . /code

# No SECRET_KEY baked in: an image layer is readable by anyone who can pull the
# image, and a key committed to a Dockerfile outlives any rotation. Set it,
# and the provider key, as Fly secrets:
#   fly secrets set SECRET_KEY=... ORS_API_KEY=...
RUN python manage.py collectstatic --noinput

EXPOSE 8000

# The provider cache and the per-IP rate-limit counters (API-05) live in a
# SQLite table that must exist before the first request, or every call to
# /api/geocode/ and /api/trips/plan/ returns 500 while /api/health/ still
# answers 200 - a service that looks healthy and serves nothing. The container
# filesystem is ephemeral and a Fly release_command runs on a throwaway
# machine, so the table is created at start, where it is actually needed. Both
# commands are idempotent.
CMD ["sh", "-c", "python manage.py migrate --run-syncdb && python manage.py createcachetable && exec gunicorn --bind :8000 --workers 2 --timeout 120 config.wsgi"]
