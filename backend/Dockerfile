# The texture library (ADR 016): Django + Django Ninja behind gunicorn.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    TEXTURE_LIBRARY_ROOT=/srv/texture-library \
    TEXTURE_CACHE_DIR=/srv/texture-cache \
    TEXTURE_DB_PATH=/srv/texture-data/db.sqlite3

COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY . .
# The admin's own files, served by whitenoise.
RUN DJANGO_DEBUG=1 python manage.py collectstatic --noinput >/dev/null

RUN useradd --system --uid 10001 texlib \
    && mkdir -p /srv/texture-library /srv/texture-cache /srv/texture-data \
    && chown -R texlib /srv
USER texlib

EXPOSE 8000
# Migrations are idempotent: run on every start. Building the library is a
# separate, explicit step (README: "Texture library").
CMD ["sh", "-c", "python manage.py migrate --noinput && exec gunicorn texlib.wsgi --bind 0.0.0.0:8000 --workers 2 --access-logfile -"]
