#!/bin/sh
# Mounted disks (Docker volume, Render disk) may be root-owned: fix ownership, then drop to the unprivileged "node" user.
set -e
mkdir -p "${DATA_DIR:-/app/data}"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "${DATA_DIR:-/app/data}"
  exec su-exec node "$@"
fi
exec "$@"
