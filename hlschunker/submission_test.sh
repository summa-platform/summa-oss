#!/bin/sh

cd "`dirname "$0"`"

docker exec -it hlschunker /app/chunk_submission_test.py
