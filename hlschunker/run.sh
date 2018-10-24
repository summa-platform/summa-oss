#!/bin/sh

cd "`dirname "$0"`"

docker kill hlschunker
docker build -t hlschunker .
docker run --rm --name hlschunker -v "$PWD/config.yaml":/config/config.yaml -v "$PWD/data":/data -p 6000:6000 -it hlschunker
