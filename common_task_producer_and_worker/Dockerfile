FROM node:8.9.1

# install fluent-ffmpeg dependencies
# http://qiita.com/flny/items/798547356dcc47239702
RUN apt-get update && apt-get install -y \
    wget \
    xz-utils \
 && rm -rf /var/lib/apt/lists/*
 
# Is ffmpeg still needed for this module? Seems like legacy residue to me.
# In any case, johnvansickle.com does not provide precompiled ffmpeg releases any more,
# but there is an ubuntu package (see asr module for reference). [UG]
# RUN wget http://johnvansickle.com/ffmpeg/releases/ffmpeg-release-64bit-static.tar.xz \
#     && tar Jxvf ./ffmpeg-release-64bit-static.tar.xz \
#     && cp ./ffmpeg*64bit-static/ffmpeg /usr/local/bin/

RUN mkdir -p /usr/src
WORKDIR /usr/src

COPY package.json /usr/src
# point to registry to speed up, see https://github.com/npm/npm/issues/8836#issuecomment-132302605
RUN npm config set registry https://registry.npmjs.org/
RUN npm install
# copy node modules to other folder in conainer after install
# so that we can mount src files from host
# but still use the installed node_modules from container
# !!! assumes that host folder has a symlink file node_modules to /dist/node_modules
# can be created with ln -s /dist/node_modules node_modules
RUN mkdir -p /dist && cp -r node_modules /dist/node_modules/
COPY . /usr/src
RUN ln -s /dist/node_modules node_modules

CMD [ "npm", "start" ]
