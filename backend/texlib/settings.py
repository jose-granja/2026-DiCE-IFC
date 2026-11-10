"""
Settings for DiCE-IFC's texture library (ADR 016).

A small, read-mostly service: it lists the curated CC0 textures realistic
materials draws and, in development, serves their files. It never receives
anything from a model — the browser chooses textures itself and only reads
from here (frontend/AGENTS.md §1). Everything a deployment sets is an
environment variable.
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def env_flag(name: str, default: bool = False) -> bool:
    return os.environ.get(name, "1" if default else "0").strip().lower() in {"1", "true", "yes", "on"}


DEBUG = env_flag("DJANGO_DEBUG")

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY", "")
if not SECRET_KEY:
    if not DEBUG:
        raise RuntimeError("Set DJANGO_SECRET_KEY (or DJANGO_DEBUG=1 for development).")
    SECRET_KEY = "development-only-not-secret"

ALLOWED_HOSTS = [h.strip() for h in os.environ.get("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,backend").split(",") if h.strip()]
CSRF_TRUSTED_ORIGINS = [o.strip() for o in os.environ.get("DJANGO_CSRF_TRUSTED_ORIGINS", "").split(",") if o.strip()]

# Where everything lives under the app's own origin: nginx (and `next dev`'s
# rewrite) send `/texture-library/` here.
URL_PREFIX = "texture-library/"

# The built texture files. Served by nginx in production; by Django only when
# TEXTURE_SERVE_FILES is on (development).
TEXTURE_LIBRARY_ROOT = Path(os.environ.get("TEXTURE_LIBRARY_ROOT", BASE_DIR / "library"))
TEXTURE_FILES_URL = f"/{URL_PREFIX}files/"
TEXTURE_SERVE_FILES = env_flag("TEXTURE_SERVE_FILES", default=DEBUG)
# Downloads from Poly Haven and ambientCG, kept so a rebuild fetches nothing twice.
TEXTURE_CACHE_DIR = Path(os.environ.get("TEXTURE_CACHE_DIR", BASE_DIR / "cache"))
# The curated list the library is built from (reviewed like code).
TEXTURE_SELECTION = Path(os.environ.get("TEXTURE_SELECTION", BASE_DIR / "textures" / "selection.json"))
# The admin and the review page, for curating; off unless asked for.
TEXTURE_ADMIN = env_flag("TEXTURE_LIBRARY_ADMIN", default=DEBUG)

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "textures",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "texlib.urls"
WSGI_APPLICATION = "texlib.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

DB_PATH = Path(os.environ.get("TEXTURE_DB_PATH", BASE_DIR / "data" / "db.sqlite3"))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": DB_PATH}}

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = f"/{URL_PREFIX}static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# Behind nginx, which terminates TLS.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_PATH = f"/{URL_PREFIX}"
CSRF_COOKIE_PATH = f"/{URL_PREFIX}"
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
X_FRAME_OPTIONS = "DENY"
SECURE_CONTENT_TYPE_NOSNIFF = True
