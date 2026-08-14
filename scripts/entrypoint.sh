#!/bin/sh
# Railway mounts the volume at /data owned by root, shadowing the build-time
# chown in the Dockerfile — the app then fails mid-capture with
# "EACCES: permission denied, mkdir '/data/snapshots'". Ownership has to be
# fixed at container start, after the mount exists. The server itself still
# runs unprivileged as pwuser.
set -e

chown -R pwuser:pwuser /data

# rebuild-stale only does work when the extractor has changed since a version
# was last saved. Its failure is tolerated *here* rather than trusted to the
# script: it catches its own errors and exits 0, but a module that throws while
# being imported never reaches that handler, and `set -e` would then take the
# whole container down over a stale cache. A stale diff is recoverable; a
# container that will not boot is the tool being down.
exec su -s /bin/sh pwuser -c "node_modules/.bin/tsx scripts/migrate.ts && { node_modules/.bin/tsx scripts/rebuild-stale.ts || echo '[entrypoint] rebuild-stale failed; continuing'; } && node server.js"
