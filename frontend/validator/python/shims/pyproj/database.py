from collections import namedtuple

from . import _table

CRSInfo = namedtuple("CRSInfo", "auth_name code name")


def query_crs_info(auth_name=None, *_args, **_kwargs):
    if auth_name not in (None, "EPSG"):
        return []
    names = {code: name for name, code in _table()["names"].items()}
    return [CRSInfo("EPSG", code, names.get(int(code), "")) for code in _table()["crs"]]
