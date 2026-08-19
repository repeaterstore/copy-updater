#!/bin/sh
# NOT what production runs. railway.json sets a `startCommand`, and that
# overrides the Dockerfile's CMD — so this file is only used by anything that
# runs the image directly. Both have to be kept in step; the rebuild step below
# sat here unexecuted for a full day because only this one was updated.
# Railway mounts the volume at /data owned by root, shadowing the build-time
# chown in the Dockerfile — the app then fails mid-capture with
# "EACCES: permission denied, mkdir '/data/snapshots'". Ownership has to be
# fixed at container start, after the mount exists. The server itself still
# runs unprivileged as pwuser.
set -e

chown -R pwuser:pwuser /data

# The stale-cache rebuild is not here: the server does it for itself on start-up
# from instrumentation.ts, where its imports resolve against the build Next
# traced. Run as a separate process against the standalone output it failed
# every boot with "Cannot find module 'diff'".
exec su -s /bin/sh pwuser -c "node_modules/.bin/tsx scripts/migrate.ts && node server.js"
