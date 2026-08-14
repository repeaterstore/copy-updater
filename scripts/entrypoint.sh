#!/bin/sh
# Railway mounts the volume at /data owned by root, shadowing the build-time
# chown in the Dockerfile — the app then fails mid-capture with
# "EACCES: permission denied, mkdir '/data/snapshots'". Ownership has to be
# fixed at container start, after the mount exists. The server itself still
# runs unprivileged as pwuser.
set -e

chown -R pwuser:pwuser /data

# rebuild-stale only does work when the extractor has changed since a version
# was last saved, and always exits 0 — see the script for why the boot must not
# depend on it.
exec su -s /bin/sh pwuser -c "node_modules/.bin/tsx scripts/migrate.ts && node_modules/.bin/tsx scripts/rebuild-stale.ts && node server.js"
