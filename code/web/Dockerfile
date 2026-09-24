# The PhyloDelta frontend, served by nginx, which also proxies /api/v1/ to the
# service so the page and the API share one origin (client.ts uses a relative
# base URL and never needs to know where the backend lives).
#
# The build context is `code/`, not `code/web`: the app consumes the library as
# a workspace package whose entry points are TypeScript source (lib/package.json),
# so npm needs the workspace root and Vite needs lib/src.

FROM node:22-alpine AS build

WORKDIR /app

# Every workspace manifest, because `npm ci` checks the lockfile against all of
# them; only the web app's dependencies are actually installed.
COPY package.json package-lock.json ./
COPY lib/package.json ./lib/
COPY lib_demo/package.json ./lib_demo/
COPY web/package.json ./web/
COPY bench/package.json ./bench/
RUN npm ci --workspace web --include-workspace-root

COPY lib ./lib
COPY web ./web
RUN npm run build --workspace web

FROM nginx:1.27-alpine

COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html

EXPOSE 80
