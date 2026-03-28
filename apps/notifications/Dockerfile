FROM node:18.16-alpine

# Override at build time: docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) ...
ARG GIT_COMMIT=unknown
ARG IMAGE_TAG=unknown
ARG BUILD_TIME=unknown
ENV GIT_COMMIT=$GIT_COMMIT
ENV IMAGE_TAG=$IMAGE_TAG
ENV BUILD_TIME=$BUILD_TIME

RUN apk add --no-cache --virtual .gyp python3 make g++ 

WORKDIR /notifications

# Use writable dir for npm cache (avoids "mkdir /root: read-only file system" in some environments)
ENV NPM_CONFIG_CACHE=/tmp/.npm
ENV HOME=/notifications

RUN apk add --no-cache python3 py3-pip build-base

COPY package*.json ./

# Quick fix for CI where we don't run as root user
# https://stackoverflow.com/questions/14836053/how-can-i-change-the-cache-path-for-npm-or-completely-disable-the-cache-on-win
RUN npm config set cache ./.npm --global
RUN --mount=type=cache,target=./.npm npm i --verbose

COPY . .

RUN npm run build

ENV PATH="${PATH}:/notifications/node_modules/.bin"

# Run the command on container startup
CMD ["npm", "run", "start"]
