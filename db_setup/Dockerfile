FROM node:5

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
