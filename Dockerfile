FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS app
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer poppler-utils fontconfig fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation fonts-dejavu-core fonts-noto-core && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 DATABASE_PATH=/data/opendots.sqlite
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p /data && chown node:node /data
COPY --from=build /app/dist ./dist
COPY --from=build /app/deployment/business.env ./deployment/business.env
USER node
EXPOSE 4310
CMD ["npm", "start"]

FROM node:24-bookworm-slim AS browser
ENV NODE_ENV=production BROWSER_HOST=0.0.0.0 BROWSER_PORT=4311 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright
COPY --from=build /app/dist/server ./dist/server
USER node
EXPOSE 4311
CMD ["node", "dist/server/browser/index.js"]
