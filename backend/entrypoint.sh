#!/bin/sh
# Seed sample videos into /data/videos and the uploads DB table, then start the server.
python -m app.seed

exec uvicorn app.main:app --host 0.0.0.0 --port 8080 --limit-concurrency 10
