FROM ubuntu:16.04

RUN apt update && apt install -y python3 python3-pip

RUN pip3 install --upgrade pip && hash -r && pip3 install aiohttp==1.0.1 aiohttp-cors==0.4.0 PyYAML

COPY *py /app/

# COPY config.yaml /config/config.yaml
# COPY config.yaml /app/
# don't copy config.yaml; Config file will be maintained in a config directory
# mounted into this container at runtime.

RUN mkdir /config
RUN mkdir /data

WORKDIR /app

EXPOSE 6000

ENTRYPOINT /app/chunker.py --config=/config/config.yaml --data-dir /data
