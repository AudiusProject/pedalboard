FROM node:22-alpine AS base

ARG app_name

# set as env so we dont have to reset arg after multistage build
ENV APP_NAME=${app_name}

ARG TURBO_TEAM
ENV TURBO_TEAM=$TURBO_TEAM

ARG TURBO_TOKEN
ENV TURBO_TOKEN=$TURBO_TOKEN

FROM base AS builder

RUN echo "building ${APP_NAME}"

RUN apk add --no-cache libc6-compat
RUN apk update

WORKDIR /app
RUN npm install turbo@1.10.16 --global

COPY . .
RUN turbo prune "--scope=@pedalboard/${APP_NAME}" --docker

# INSTALL & BUILD
FROM base AS installer

WORKDIR /app

RUN npm install turbo@1.10.16 --global
RUN apk add --no-cache libc6-compat git
RUN apk update
RUN apk add --no-cache python3 py3-pip make g++ bash

# First install dependencies (as they change less often)
COPY .gitignore .gitignore
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/out/package-lock.json ./package-lock.json

RUN echo "installing deps for ${APP_NAME}"
RUN CI=true npm i --maxsockets 1

# Build the project and its dependencies
COPY --from=builder /app/out/full/ .
COPY turbo.json turbo.json

RUN echo "building ${APP_NAME}"
RUN turbo run build "--filter=@pedalboard/${APP_NAME}"...

# RUN
FROM base AS runner
WORKDIR /app

COPY --from=installer /app .

WORKDIR /app/apps/${APP_NAME}

RUN apk add --no-cache curl

CMD npm run start
