# The demo application, served by nginx.
#
# NOTE the build context is `code/`, not `code/lib_demo`. The demo consumes the
# library as a workspace package (`phylo-tree-viewer`), so npm needs the
# workspace root to resolve it — building from the demo directory alone fails
# on an unresolvable dependency.

FROM node:20-alpine AS build

WORKDIR /app

# Workspace manifests first, so a source change does not reinstall.
COPY package.json package-lock.json ./
COPY lib/package.json ./lib/
COPY lib_demo/package.json ./lib_demo/
COPY bench/package.json ./bench/
RUN npm ci

COPY lib ./lib
COPY lib_demo ./lib_demo
RUN npm run build --workspace lib_demo

FROM nginx:1.27-alpine

COPY lib_demo/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/lib_demo/dist /usr/share/nginx/html

EXPOSE 80
