#!/usr/bin/env bash
# Regenerates app/src/environments/aws-config.ts from your deployed stack's
# outputs, e.g. on a new machine or a fresh clone, before `npm start` in app/.
# Optionally also resyncs the catalog with the media bucket (--resync).
#
# Usage: scripts/configure-app.sh [--env <name>] [--resync]

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

load_env
check_aws_credentials
configure_app
if [ "${1:-}" = "--resync" ]; then
  resync_catalog
fi
