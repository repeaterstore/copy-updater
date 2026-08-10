#!/bin/sh
# Railway mounts the volume at /data owned by root, shadowing the build-time
# chown in the Dockerfile — the app then fails mid-capture with
# "EACCES: permission denied, mkdir '/data/snapshots'". Ownership has to be
# fixed at container start, after the mount exists. The server itself still
# runs unprivileged as pwuser.
set -e

chown -R pwuser:pwuser /data

exec su -s /bin/sh pwuser -c "node_modules/.bin/tsx scripts/migrate.ts && node server.js"
