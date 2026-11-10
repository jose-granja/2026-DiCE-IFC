"""
Build the texture library from textures/selection.json.

    python manage.py build_texture_library            # what is missing
    python manage.py build_texture_library --force    # everything again
    python manage.py build_texture_library --only polyhaven-brick_wall_001

Downloads come from Poly Haven and ambientCG once and are cached; the files
are written under TEXTURE_LIBRARY_ROOT and listed in the database. A texture
taken out of the selection is switched off, not deleted.
"""

import json

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from textures.build import Entry, build_texture
from textures.models import Texture
from textures.sources import AmbientCG, Downloader, PolyHaven


class Command(BaseCommand):
    help = "Build the texture library from the curated selection."

    def add_arguments(self, parser):
        parser.add_argument("--force", action="store_true", help="Rebuild textures already built.")
        parser.add_argument("--only", nargs="+", metavar="SLUG", help="Build just these (source-id).")

    def handle(self, *args, force: bool = False, only: list[str] | None = None, **options):
        try:
            entries = [Entry.from_json(item) for item in json.loads(settings.TEXTURE_SELECTION.read_text())]
        except (OSError, ValueError, KeyError) as error:
            raise CommandError(f"Cannot read {settings.TEXTURE_SELECTION}: {error}") from error

        downloader = Downloader(settings.TEXTURE_CACHE_DIR)
        sources = {"polyhaven": PolyHaven(downloader), "ambientcg": AmbientCG(downloader)}
        root = settings.TEXTURE_LIBRARY_ROOT
        root.mkdir(parents=True, exist_ok=True)

        wanted = [e for e in entries if not only or e.slug in only]
        failed = []
        for index, entry in enumerate(wanted, start=1):
            existing = Texture.objects.filter(slug=entry.slug).first()
            on_disk = existing and all((root / path).exists() for maps in existing.files.values() for path in maps.values())
            if existing and on_disk and not force:
                # Built already: what the selection says about it may still change.
                existing.family, existing.surface, existing.note, existing.enabled = entry.family, entry.surface, entry.note, True
                existing.save(update_fields=["family", "surface", "note", "enabled"])
                continue
            self.stdout.write(f"[{index}/{len(wanted)}] {entry.slug} …")
            try:
                built = build_texture(entry, sources[entry.source], root)
            except Exception as error:  # One texture's trouble must not stop the rest.
                failed.append(entry.slug)
                self.stderr.write(self.style.ERROR(f"  {entry.slug}: {error}"))
                continue
            Texture.objects.update_or_create(
                slug=entry.slug,
                defaults=dict(
                    name=built.name,
                    family=entry.family,
                    surface=entry.surface,
                    source=entry.source,
                    source_id=entry.id,
                    source_url=built.page,
                    licence="CC0-1.0",
                    tile_width=built.tile[0],
                    tile_height=built.tile[1],
                    mean_linear=list(built.mean),
                    lab=list(built.lab),
                    files=built.files,
                    thumb=built.thumb,
                    note=entry.note,
                    enabled=True,
                    built_at=timezone.now(),
                ),
            )

        if not only:
            dropped = Texture.objects.exclude(slug__in=[e.slug for e in entries]).update(enabled=False)
            if dropped:
                self.stdout.write(f"Switched off {dropped} texture(s) no longer in the selection.")
        total = Texture.objects.filter(enabled=True).count()
        self.stdout.write(self.style.SUCCESS(f"{total} textures in the library."))
        if failed:
            raise CommandError(f"{len(failed)} texture(s) failed: {', '.join(failed)}")
