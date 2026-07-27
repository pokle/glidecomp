# Toolchain image for the isolated local preview (`bun run preview:container`;
# host driver: web/scripts/container-preview.sh). Built for Apple's container(1),
# but it's a plain OCI image — `docker build` works too.
#
# Why a container: `bun run preview` binds pages dev :3000, the Workers'
# dev-router :8790 and a workerd inspector, coordinates them through wrangler's
# *localhost* dev registry, and keeps D1 + R2 in web/.wrangler/state. All three
# collide with a second copy. Inside a container they're private, so only one
# port needs publishing.
#
# This image holds ONLY the dependency tree — no app source. The source is
# bind-mounted read-only at /src on each run and rsync'd into /app by the
# entrypoint, so editing a file needs a container restart, not an image rebuild.
# node_modules must live in the image rather than come over the mount: the host
# tree is macOS-arm64 (workerd, esbuild, …) and would not load under Linux.
#
# Rebuild this image (REBUILD=1) only when the dependency set changes.

# Node, not the bun image — wrangler is a Node CLI and refuses to run under the
# Bun runtime ("Wrangler does not support the Bun runtime"), which is exactly
# what happens on an image with bun but no node: auth-api dies at startup with
# "Unexpected server response: 101". Node 22 matches CI (.github/workflows).
FROM docker.io/node:22-slim

# procps gives `ps`, which `concurrently` needs to tear down its children when
# one dies. curl drives the readiness wait; rsync stages /src into /app.
RUN apt-get update && apt-get install -y --no-install-recommends procps curl rsync \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g bun

WORKDIR /app

# Manifests only. Keep this list in sync with the root package.json `workspaces`.
COPY package.json bun.lock ./
COPY patches/ ./patches/
COPY web/engine/package.json ./web/engine/
COPY web/frontend/package.json ./web/frontend/
COPY web/samples/package.json ./web/samples/
COPY web/workers/auth-api/package.json ./web/workers/auth-api/
COPY web/workers/competition-api/package.json ./web/workers/competition-api/
COPY web/workers/airscore-api/package.json ./web/workers/airscore-api/
RUN bun install --frozen-lockfile

# D1 and R2 land here as Miniflare SQLite files. The run script mounts a named
# volume over it — that is what isolates one preview's data from another's, and
# from your host checkout's.
VOLUME /app/web/.wrangler/state

EXPOSE 3000

# Deliberately run from the bind mount, not from a baked copy, so edits to the
# entrypoint itself also take effect on a plain restart.
ENTRYPOINT ["bash", "/src/web/scripts/container-preview-entry.sh"]
