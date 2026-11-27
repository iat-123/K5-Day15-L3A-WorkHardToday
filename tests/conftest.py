"""Pytest harness cho bộ kiểm thử chạy trên PostgreSQL với schema riêng theo từng phiên."""
import os
import sys

import psycopg
from psycopg import sql
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODEBASE = os.path.join(ROOT, "codebase")
if CODEBASE not in sys.path:
    sys.path.insert(0, CODEBASE)

import store  # noqa: E402

_CREATED_SCHEMA = None


def pytest_configure(config):
    global _CREATED_SCHEMA
    schema = "shop_test_%d" % os.getpid()
    os.environ["VPOST_DB_SCHEMA"] = schema
    ok, err = store.check_connection()
    if ok:
        os.environ["_VPOST_PG_UNAVAILABLE"] = ""
        store.init()
        _CREATED_SCHEMA = schema
    else:
        os.environ["_VPOST_PG_UNAVAILABLE"] = err
        _CREATED_SCHEMA = None


def pytest_unconfigure(config):
    global _CREATED_SCHEMA
    schema = _CREATED_SCHEMA
    _CREATED_SCHEMA = None
    os.environ.pop("_VPOST_PG_UNAVAILABLE", None)
    if not schema:
        return
    try:
        with psycopg.connect(store._dsn(), connect_timeout=store.CONNECT_TIMEOUT, autocommit=True) as conn:
            conn.execute(sql.SQL("drop schema if exists {} cascade").format(sql.Identifier(schema)))
    except Exception:
        pass


@pytest.fixture(autouse=True)
def _truncate_shop_tables(request):
    """Làm sạch mọi bảng trong schema test trước mỗi test dùng DB (thay cho tạo file SQLite mới)."""
    if not _CREATED_SCHEMA or os.environ.get("_VPOST_PG_UNAVAILABLE"):
        return
    mod_ns = request.module.__dict__
    if not any(name in mod_ns for name in ("store", "server", "vpost_api")):
        return
    with store.connect() as c:
        tables = [
            r["tablename"]
            for r in c.execute("select tablename from pg_tables where schemaname = current_schema()")
        ]
        if tables:
            stmt = sql.SQL("truncate table {} restart identity cascade").format(
                sql.SQL(", ").join(sql.Identifier(t) for t in tables)
            )
            c.execute(stmt)
