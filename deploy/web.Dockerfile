# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY public/ public/
COPY scripts/sync-assets.mjs scripts/render-web-headers.mjs scripts/
COPY server/browser-headers.json server/
COPY src/ src/
RUN npm run build && node scripts/render-web-headers.mjs > /tmp/pdfwork-browser-headers.conf

FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
COPY --from=build /app/dist/ /srv/pdfwork/
COPY --from=build /tmp/pdfwork-browser-headers.conf /etc/nginx/pdfwork-browser-headers.conf
COPY deploy/nginx.conf /etc/nginx/nginx.conf
USER 101:101
EXPOSE 8080
ENTRYPOINT ["nginx", "-g", "daemon off;"]
CMD []

