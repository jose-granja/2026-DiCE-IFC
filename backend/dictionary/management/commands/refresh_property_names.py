"""
Update the IFC property names from bSDD, or write the table out.

    python manage.py refresh_property_names                  # every PROPERTY_NAME_LANGUAGES
    python manage.py refresh_property_names --language pt-PT
    python manage.py refresh_property_names --export ../frontend/lib/bsdd/property-names

`--export` writes `<language>.json`, the copy the viewer ships with and falls
back to when this server has none (ADR 017). The admin's "Update from bSDD"
button runs the same update.
"""

import json
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from dictionary.bsdd import RefreshBusy, start_refresh, table
from dictionary.models import PropertyNameRefresh


class Command(BaseCommand):
    help = "Read the IFC dictionary's property names from bSDD."

    def add_arguments(self, parser):
        parser.add_argument("--language", nargs="+", metavar="CODE", help="bSDD language codes (default: PROPERTY_NAME_LANGUAGES).")
        parser.add_argument("--export", metavar="DIR", help="Write each language's table to DIR/<language>.json after updating.")
        parser.add_argument("--no-update", action="store_true", help="With --export: write what the table holds, without asking bSDD.")

    def handle(self, *args, language=None, export=None, no_update=False, **options):
        languages = language or settings.PROPERTY_NAME_LANGUAGES
        if not no_update:
            for code in languages:
                try:
                    refresh = start_refresh(code, "manage.py", background=False)
                except RefreshBusy as busy:
                    raise CommandError(str(busy)) from busy
                if refresh.status != PropertyNameRefresh.DONE:
                    raise CommandError(f"{code}: {refresh.error}")
                self.stdout.write(
                    f"{code}: {refresh.translated} of {refresh.total} properties named "
                    f"({refresh.added} added, {refresh.changed} changed, {refresh.removed} removed)"
                )
        if export:
            folder = Path(export)
            folder.mkdir(parents=True, exist_ok=True)
            for code in languages:
                data = table(code)
                if data is None:
                    raise CommandError(f"{code}: the table has no names to export.")
                path = folder / f"{code}.json"
                path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
                self.stdout.write(f"{code}: {len(data['names'])} names written to {path}")
