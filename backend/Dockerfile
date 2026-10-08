# Python 3.12, not whatever is newest: timezonefinder (INT-04) ships binary
# wheels for cp39-cp313 only, so on 3.14 pip falls back to building its C
# extension from source and this image has no compiler. 3.12 is also what CI
# and render.yaml use, so the deployed interpreter matches the tested one.
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

# No SECRET_KEY here: baking one into the image publishes it to anyone who can
# pull the image, and it would outlive any rotation. Set it as a Fly secret:
#   fly secrets set SECRET_KEY=... ORS_API_KEY=...
# Without one, settings.py generates a random per-process key, which is safe
# but logs every process out of nothing in particular - this app has no
# sessions, so it only matters if authentication is ever added.
RUN python manage.py collectstatic --noinput

EXPOSE 8000

# The provider cache and the per-IP rate-limit counters (API-05) live in a
# SQLite table that must exist before the first request. The container's
# filesystem is ephemeral and a Fly release_command runs on a throwaway
# machine, so neither a build step nor a release step would leave the table
# behind: it is created at start, where it is actually needed. Both commands
# are idempotent.
CMD ["sh", "-c", "python manage.py migrate --run-syncdb && python manage.py createcachetable && exec gunicorn --bind :8000 --workers 2 --timeout 120 config.wsgi"]
