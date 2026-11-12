"""The IFC property-name table: reading bSDD, updating, the admin button and the API (ADR 017)."""

import json

import pytest
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import Client

from dictionary.bsdd import BsddError, RefreshBusy, fetch_property_names, run_refresh, start_refresh
from dictionary.models import PropertyName, PropertyNameRefresh

DICTIONARY = "https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3"
ENGLISH = {"FireRating": "Fire Rating", "IsExternal": "Is External", "NetSideArea": "Net Side Area", "Status": "Status"}
PORTUGUESE = {"FireRating": "Classe de Resistência ao Fogo", "IsExternal": "É Exterior", "NetSideArea": "Net Side Area", "Status": "Estado"}


class FakeResponse:
    def __init__(self, status: int, body):
        self.status_code, self.body = status, body

    def json(self):
        if isinstance(self.body, Exception):
            raise self.body
        return self.body


class FakeBsdd:
    """bSDD's dictionary-properties endpoint, paged, with nothing sent anywhere."""

    def __init__(self, names=None, page=2, status=200, total_extra=0):
        self.names = names or {"EN": ENGLISH, "pt-PT": PORTUGUESE}
        self.page, self.status, self.total_extra = page, status, total_extra
        self.asked: list[dict] = []

    def get(self, url, *, params, headers, timeout):
        self.asked.append({"url": url, **params})
        if self.status != 200:
            return FakeResponse(self.status, {})
        names = self.names[params.get("languageCode", "EN")]
        items = [{"code": code, "name": name, "uri": f"{DICTIONARY}/prop/{code}"} for code, name in names.items()]
        offset, limit = int(params["Offset"]), min(int(params["Limit"]), self.page)
        return FakeResponse(200, {
            "propertiesTotalCount": len(items) + self.total_extra,
            "properties": items[offset:offset + limit],
        })


def refresh(language="pt-PT", session=None):
    queued = PropertyNameRefresh.objects.create(language=language, dictionary=DICTIONARY)
    return run_refresh(queued.pk, session=session or FakeBsdd())


def test_every_page_is_read_in_the_language_asked_for():
    bsdd = FakeBsdd()
    names = fetch_property_names(bsdd, DICTIONARY, "pt-PT")
    assert names["FireRating"].name == "Classe de Resistência ao Fogo"
    assert names["FireRating"].uri == f"{DICTIONARY}/prop/FireRating"
    assert [ask["Offset"] for ask in bsdd.asked] == [0, 2]
    assert {ask["languageCode"] for ask in bsdd.asked} == {"pt-PT"}
    assert all(ask["url"].endswith("/api/Dictionary/v1/Properties") and ask["Uri"] == DICTIONARY for ask in bsdd.asked)


def test_a_list_shorter_than_bsdd_says_is_refused():
    with pytest.raises(BsddError, match="4 of the 5"):
        fetch_property_names(FakeBsdd(total_extra=1), DICTIONARY)


@pytest.mark.django_db
def test_an_update_keeps_every_property_and_knows_which_are_translated():
    run = refresh()
    assert run.status == PropertyNameRefresh.DONE, run.error
    assert (run.total, run.translated, run.added, run.changed, run.removed) == (4, 3, 4, 0, 0)
    fire = PropertyName.objects.get(language="pt-PT", code="FireRating")
    assert (fire.name, fire.english) == ("Classe de Resistência ao Fogo", "Fire Rating")
    assert not PropertyName.objects.get(code="NetSideArea").translated


@pytest.mark.django_db
def test_an_override_outlives_an_update_and_a_property_bsdd_dropped_goes():
    refresh()
    PropertyName.objects.filter(code="IsExternal").update(override="Exterior")
    portuguese = {**PORTUGUESE, "FireRating": "Resistência ao Fogo"}
    del portuguese["Status"]
    english = {code: name for code, name in ENGLISH.items() if code != "Status"}
    run = refresh(session=FakeBsdd({"EN": english, "pt-PT": portuguese}))
    assert (run.added, run.changed, run.removed) == (0, 1, 1)
    assert PropertyName.objects.get(code="IsExternal").shown == "Exterior"
    assert PropertyName.objects.get(code="FireRating").name == "Resistência ao Fogo"
    assert not PropertyName.objects.filter(code="Status").exists()


@pytest.mark.django_db
def test_a_failed_update_leaves_the_table_as_it_was():
    refresh()
    run = refresh(session=FakeBsdd(status=500))
    assert run.status == PropertyNameRefresh.FAILED
    assert "500" in run.error
    assert PropertyName.objects.filter(language="pt-PT").count() == 4


@pytest.mark.django_db
def test_one_update_per_language_at_a_time():
    PropertyNameRefresh.objects.create(language="pt-PT", dictionary=DICTIONARY, status=PropertyNameRefresh.RUNNING)
    with pytest.raises(RefreshBusy):
        start_refresh("pt-PT", background=False)


@pytest.mark.django_db
def test_the_api_lists_only_translated_names_and_overrides():
    refresh()
    PropertyName.objects.filter(code="NetSideArea").update(override="Área Lateral Líquida")
    response = Client().get("/texture-library/api/property-names/pt-PT")
    assert response.status_code == 200
    assert "max-age=300" in response["Cache-Control"]
    body = response.json()
    assert body["language"] == "pt-PT" and body["dictionary"] == DICTIONARY and body["version"] == 1
    assert body["names"] == {
        "FireRating": "Classe de Resistência ao Fogo",
        "IsExternal": "É Exterior",
        "NetSideArea": "Área Lateral Líquida",
        "Status": "Estado",
    }


@pytest.mark.django_db
def test_no_table_is_a_404_so_the_viewer_uses_its_own_copy():
    assert Client().get("/texture-library/api/property-names/pt-PT").status_code == 404
    assert Client().get("/texture-library/api/property-names/..%2Fadmin").status_code == 404


@pytest.mark.django_db
def test_the_admin_button_updates_the_table(monkeypatch, settings):
    settings.PROPERTY_NAME_REFRESH_IN_BACKGROUND = False
    monkeypatch.setattr("dictionary.bsdd.default_session", lambda: FakeBsdd())
    admin = get_user_model().objects.create_superuser("admin", "admin@example.invalid", "x")
    client = Client()
    client.force_login(admin)

    page = client.get("/texture-library/admin/dictionary/propertyname/")
    assert b"Update from bSDD" in page.content

    response = client.post("/texture-library/admin/dictionary/propertyname/refresh/", follow=True)
    assert response.redirect_chain[-1][0] == "/texture-library/admin/dictionary/propertynamerefresh/"
    assert b"3 of 4 properties have a name" in response.content
    run = PropertyNameRefresh.objects.get()
    assert (run.status, run.requested_by) == (PropertyNameRefresh.DONE, "admin")
    assert PropertyName.objects.count() == 4


@pytest.mark.django_db
def test_a_get_starts_nothing():
    admin = get_user_model().objects.create_superuser("admin", "admin@example.invalid", "x")
    client = Client()
    client.force_login(admin)
    client.get("/texture-library/admin/dictionary/propertyname/refresh/")
    assert not PropertyNameRefresh.objects.exists()


@pytest.mark.django_db
def test_the_command_exports_the_copy_the_viewer_ships(monkeypatch, tmp_path):
    monkeypatch.setattr("dictionary.bsdd.default_session", lambda: FakeBsdd())
    call_command("refresh_property_names", "--language", "pt-PT", "--export", str(tmp_path))
    exported = json.loads((tmp_path / "pt-PT.json").read_text(encoding="utf-8"))
    assert exported["names"]["FireRating"] == "Classe de Resistência ao Fogo"
    assert "NetSideArea" not in exported["names"]
    assert exported == Client().get("/texture-library/api/property-names/pt-PT").json()
