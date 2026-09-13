# TRAE/WorkBuddy credits dashboard - container scheme (collector: local / WebDAV sync)
# Runtime uses only Node builtins (node:http / node:sqlite), no npm deps.
# Data files (trae-*.json, credits.db) are NOT baked into the image for security:
# docker-compose bind-mounts the project dir so desktop/container share one data set.
FROM node:22-alpine

LABEL maintainer="trae-credits-tool"

WORKDIR /app

COPY package.json ./
COPY tool.json ./
COPY trae-gui.mjs trae-credits.mjs ./
COPY wb-gui.html wb-gui.state.js wb-gui.core.js wb-gui.render.js wb-gui.chart.js wb-gui.ops.js wb-gui.sync.js wb-gui.actions.js ./
COPY src/ ./src/

ENV WB_COLLECTOR=file
ENV NODE_ENV=production
ENV TZ=Asia/Shanghai
EXPOSE 8133

CMD ["node", "trae-gui.mjs", "8133"]
