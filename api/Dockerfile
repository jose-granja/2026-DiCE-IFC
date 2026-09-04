# syntax=docker/dockerfile:1

# Django API, development image.
#
# docker-compose_dev.yml bind-mounts ./api over /app and runs `runserver`, so
# this image only has to carry the interpreter and the dependencies. Dev
# dependencies are included, unlike Dockerfile.prod.

FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"

RUN apt-get update \
    && apt-get install --no-install-recommends -y libpq5 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-install-project

COPY . /app

RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen

EXPOSE 8000

CMD ["python", "manage.py", "runserver", "0.0.0.0:8000"]
