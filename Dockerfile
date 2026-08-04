# WorkBuddy credits dashboard - container scheme (collector: file / WebDAV sync)
# Runtime uses only Node builtins (node:http / node:sqlite), no npm deps.
# Data files (wb-*.json, credits.db) are NOT baked into the image for security:
# docker-compose bind-mounts the project dir so desktop/container share one data set.
FROM node:22-alpine

LABEL maintainer="workbuddy-credits-tool"

WORKDIR /app

COPY package.json ./
COPY wb-gui.mjs wb-gui.html ./
COPY src/ ./src/

ENV WB_COLLECTOR=file
ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "wb-gui.mjs"]
