FROM node:18-alpine AS base

ARG app_name
ENV APP_NAME=${app_name}

ARG TURBO_TEAM
ENV TURBO_TEAM=$TURBO_TEAM

ARG TURBO_TOKEN
ENV TURBO_TOKEN=$TURBO_TOKEN

RUN apk add --no-cache libc6-compat git python3 py3-pip make g++ bash curl
RUN npm install turbo@1.10.16 --global

WORKDIR /app

FROM base AS builder

# Copy package files for dependency installation
COPY package*.json ./
COPY turbo.json ./
COPY .gitignore ./

# Copy workspace package files
COPY packages/*/package.json packages/
COPY apps/*/package.json apps/

# Install dependencies
RUN CI=true npm ci --maxsockets 1

# Copy source code
COPY . .

# Build the specific app and its dependencies
RUN turbo run build --filter="@pedalboard/${APP_NAME}..."

FROM base AS runner

WORKDIR /app

# Copy built application
COPY --from=builder /app .

# Switch to app directory
WORKDIR /app/apps/${APP_NAME}

# Expose port (apps can override via ENV)
EXPOSE 8000

# Start the application
CMD npm run start