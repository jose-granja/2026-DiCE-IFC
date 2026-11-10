"""Settings for the tests: development, with nothing read from the environment that matters."""

import os

os.environ["DJANGO_DEBUG"] = "1"
os.environ.setdefault("TEXTURE_LIBRARY_ADMIN", "1")

from .settings import *  # noqa: E402,F403

# No collected admin files in a test run: say nothing about their folder.
WHITENOISE_AUTOREFRESH = True
