"""
Reading the IFC dictionary's property names from bSDD, and updating the table.

Two languages per run: English, to know which names bSDD actually translated
(where it has none it answers in English), and the language asked for. Each is
`/api/Dictionary/v1/Properties`, a thousand properties a page — three pages
for IFC 4.3. Nothing about any model is sent: the request names the dictionary
and the language, and that is all (frontend/AGENTS.md §1).

A run that fails, or reads less than bSDD says the dictionary holds, changes
nothing: the table keeps what it had.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import timedelta
from typing import Protocol

import requests
from django.conf import settings
from django.db import connections, transaction
from django.utils import timezone

from .models import PropertyName, PropertyNameRefresh

PAGE = 1000
# Far beyond IFC 4.3's 2 501: a dictionary that keeps paging is not IFC.
MAX_PROPERTIES = 20_000
# A run that has not finished by then died with its worker; another may start.
STALE_AFTER = timedelta(minutes=15)


class BsddError(Exception):
    pass


class RefreshBusy(Exception):
    pass


class Session(Protocol):
    def get(self, url: str, *, params: dict, headers: dict, timeout: float) -> requests.Response: ...


@dataclass(frozen=True)
class BsddProperty:
    code: str
    name: str
    uri: str


def fetch_property_names(session: Session, dictionary: str, language: str | None = None) -> dict[str, BsddProperty]:
    """Every property of `dictionary`, by code, named in `language` (bSDD's default when None)."""
    found: dict[str, BsddProperty] = {}
    offset = 0
    while True:
        params = {"Uri": dictionary, "Offset": offset, "Limit": PAGE}
        if language:
            params["languageCode"] = language
        try:
            response = session.get(
                f"{settings.BSDD_API.rstrip('/')}/api/Dictionary/v1/Properties",
                params=params,
                headers={"Accept": "application/json"},
                timeout=60,
            )
        except requests.RequestException as error:
            raise BsddError(f"bSDD could not be reached: {error}") from error
        if response.status_code != 200:
            raise BsddError(f"bSDD answered {response.status_code} for {language or 'the default language'}.")
        try:
            body = response.json()
        except ValueError as error:
            raise BsddError("bSDD did not answer with JSON.") from error

        page = body.get("properties") or []
        total = body.get("propertiesTotalCount")
        if not isinstance(total, int) or not isinstance(page, list):
            raise BsddError("bSDD's answer is not a property list.")
        for item in page:
            code, name, uri = (item.get(key) if isinstance(item, dict) else None for key in ("code", "name", "uri"))
            if isinstance(code, str) and code.strip() and isinstance(name, str) and name.strip():
                found[code.strip()] = BsddProperty(code.strip(), name.strip(), uri if isinstance(uri, str) else "")
        offset += len(page)
        if not page or offset >= total:
            break
        if offset >= MAX_PROPERTIES:
            raise BsddError(f"The dictionary lists more than {MAX_PROPERTIES} properties; is it the IFC one?")

    if not found or offset < total:
        raise BsddError(f"bSDD listed {offset} of the {total} properties it reported; nothing was changed.")
    return found


def default_session() -> requests.Session:
    session = requests.Session()
    session.headers["User-Agent"] = "dice-ifc-property-names"
    return session


def run_refresh(refresh_id: int, session: Session | None = None) -> PropertyNameRefresh:
    """Carry out one queued run: read bSDD, then replace the language's table in one transaction."""
    refresh = PropertyNameRefresh.objects.get(pk=refresh_id)
    refresh.status, refresh.started_at = PropertyNameRefresh.RUNNING, timezone.now()
    refresh.save(update_fields=["status", "started_at"])
    session = session or default_session()
    try:
        english = fetch_property_names(session, refresh.dictionary)
        local = fetch_property_names(session, refresh.dictionary, refresh.language)
        now = timezone.now()
        added = changed = 0
        with transaction.atomic():
            existing = {row.code: row for row in PropertyName.objects.select_for_update().filter(language=refresh.language)}
            to_create, to_update = [], []
            for code, prop in local.items():
                english_name = english[code].name if code in english else prop.name
                row = existing.get(code)
                if row is None:
                    to_create.append(PropertyName(
                        language=refresh.language, code=code, name=prop.name, english=english_name, uri=prop.uri, updated_at=now,
                    ))
                elif (row.name, row.english, row.uri) != (prop.name, english_name, prop.uri):
                    row.name, row.english, row.uri, row.updated_at = prop.name, english_name, prop.uri, now
                    to_update.append(row)
            gone = [code for code in existing if code not in local]
            PropertyName.objects.bulk_create(to_create, batch_size=500)
            PropertyName.objects.bulk_update(to_update, ["name", "english", "uri", "updated_at"], batch_size=500)
            PropertyName.objects.filter(language=refresh.language, code__in=gone).delete()
            added, changed = len(to_create), len(to_update)

            refresh.status = PropertyNameRefresh.DONE
            refresh.total = len(local)
            refresh.translated = sum(1 for code, prop in local.items() if prop.name != (english.get(code) or prop).name)
            refresh.added, refresh.changed, refresh.removed = added, changed, len(gone)
            refresh.finished_at = timezone.now()
            refresh.save()
    except Exception as error:  # noqa: BLE001 — every failure is recorded on the run, and the table is left as it was
        refresh.status, refresh.error, refresh.finished_at = PropertyNameRefresh.FAILED, str(error)[:2000], timezone.now()
        refresh.save(update_fields=["status", "error", "finished_at"])
    return refresh


def start_refresh(language: str, requested_by: str = "", *, background: bool | None = None) -> PropertyNameRefresh:
    """
    Queue a run for `language` and start it: on a thread of its own when
    `background` (the admin's button, so the page answers at once), else here.
    """
    with transaction.atomic():
        active = PropertyNameRefresh.objects.filter(
            language=language, status__in=[PropertyNameRefresh.QUEUED, PropertyNameRefresh.RUNNING],
        )
        active.filter(created_at__lt=timezone.now() - STALE_AFTER).update(
            status=PropertyNameRefresh.FAILED, error="Interrupted: it did not finish.", finished_at=timezone.now(),
        )
        if active.exists():
            raise RefreshBusy(f"An update of {language} is already running.")
        refresh = PropertyNameRefresh.objects.create(
            language=language, dictionary=settings.BSDD_IFC_DICTIONARY, requested_by=requested_by,
        )

    if background if background is not None else settings.PROPERTY_NAME_REFRESH_IN_BACKGROUND:
        threading.Thread(target=_run_on_thread, args=(refresh.pk,), daemon=True, name=f"bsdd-{language}").start()
        return refresh
    return run_refresh(refresh.pk)


def _run_on_thread(refresh_id: int) -> None:
    try:
        run_refresh(refresh_id)
    finally:
        # A thread's own database connection is not closed by any request cycle.
        connections.close_all()


def table(language: str) -> dict | None:
    """
    What the viewer reads: the language's translated names by code, or None
    when the table has none. The API and the bundled copy
    (`refresh_property_names --export`) are both this.
    """
    rows = PropertyName.objects.filter(language=language)
    names = {row.code: row.shown for row in rows if row.translated}
    if not names:
        return None
    last = PropertyNameRefresh.objects.filter(language=language, status=PropertyNameRefresh.DONE).first()
    updated = max([row.updated_at for row in rows] + ([last.finished_at] if last and last.finished_at else []))
    return {
        "version": 1,
        "language": language,
        "dictionary": last.dictionary if last else settings.BSDD_IFC_DICTIONARY,
        "updatedAt": updated.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "names": dict(sorted(names.items())),
    }
