#!/bin/sh
set -eu

data_dir=${DATA_DIR:-/app/data}
mkdir -p "$data_dir"
chown -R node:node "$data_dir"

exec su-exec node "$@"
