FROM ubuntu:16.04

RUN apt update && apt install -y curl python3 python3-pip && apt remove -y --purge python3-pip && curl -O https://bootstrap.pypa.io/pip/3.4/get-pip.py && python3 get-pip.py

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
