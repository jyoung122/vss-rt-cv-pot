"""Background task: trim events for monitor rows on a rolling window.

Monitors loop forever; without pruning the `events` table grows without
bound and the /live event feed gets slower over time.  This task runs
every PRUNE_INTERVAL_S and deletes events older than PRUNE_WINDOW_MIN
minutes (by row id, since t_seconds is video-loop time, not wallclock).
"""

import asyncio
import logging
import os

log = logging.getLogger(__name__)

PRUNE_INTERVAL_S = int(os.getenv("MONITOR_PRUNE_INTERVAL_S", "60"))
# Keep ~last N events per monitor. The /live UI only ever shows ~500, so
# 20k per monitor is generous and still bounded.
PRUNE_KEEP_PER_MONITOR = int(os.getenv("MONITOR_PRUNE_KEEP", "20000"))


async def run_pruner() -> None:
    """Loop forever, prune oldest events per monitor.  Cancellable."""
    from app.db import get_pool

    pool = get_pool()
    while True:
        try:
            await asyncio.sleep(PRUNE_INTERVAL_S)
            rows = await pool.fetch("SELECT id FROM monitors")
            total_pruned = 0
            for r in rows:
                monitor_id = r["id"]
                # Keep the newest PRUNE_KEEP_PER_MONITOR rows; delete the rest.
                pruned = await pool.fetchval(
                    """
                    WITH keepers AS (
                        SELECT id FROM events
                        WHERE video_id = $1
                        ORDER BY id DESC
                        LIMIT $2
                    ),
                    deleted AS (
                        DELETE FROM events
                        WHERE video_id = $1
                          AND id NOT IN (SELECT id FROM keepers)
                        RETURNING 1
                    )
                    SELECT COUNT(*) FROM deleted
                    """,
                    monitor_id, PRUNE_KEEP_PER_MONITOR,
                )
                total_pruned += pruned or 0
            if total_pruned:
                log.info(
                    "monitor_pruner.swept",
                    extra={"rows_deleted": total_pruned, "monitors": len(rows)},
                )
        except asyncio.CancelledError:
            log.info("monitor_pruner.cancelled")
            return
        except Exception as exc:
            log.exception("monitor_pruner.error", extra={"error": str(exc)})
            # Back off on persistent failure
            await asyncio.sleep(PRUNE_INTERVAL_S)
