"""Asyncpg connection pool + schema bootstrap."""

import os
from pathlib import Path

import asyncpg

_pool: asyncpg.Pool | None = None

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://aims:aims@postgres:5432/aims")
_SCHEMA_PATH = Path(__file__).parent / "schema.sql"


async def init_pool() -> None:
    """Create the asyncpg connection pool and apply schema.sql if tables are missing."""
    global _pool
    _pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=10)
    schema_sql = _SCHEMA_PATH.read_text()
    async with _pool.acquire() as conn:
        await conn.execute(schema_sql)


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("DB pool not initialised — call init_pool() first")
    return _pool
