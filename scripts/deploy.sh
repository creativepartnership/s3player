#!/usr/bin/env bash
# Deploys an update (after pulling new code, or after editing infra/.env):
# AWS resources first, then the app. Uses the settings in infra/.env.
#
# Usage: scripts/deploy.sh [--env <name>] [--app-only | --infra-only] [--yes]
#   --env <name>  deploy the environment configured in infra/.env.<name>
#                 (e.g. production); default infra/.env
#   --app-only    only rebuild and publish the app
#   --infra-only  only deploy the AWS resources (and point the local app config at them)
#   --yes         don't ask before CDK creates/widens IAM permissions

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

do_infra=1
do_app=1
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --app-only) do_infra=0 ;;
    --infra-only) do_app=0 ;;
    --yes | -y) ASSUME_YES=1 ;;
    -h | --help)
      sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown option: $arg" ;;
  esac
done

check_prerequisites
load_env
check_aws_credentials
install_deps

if [ "$do_infra" = "1" ]; then
  deploy_infra
  # publish_app builds against this stack's outputs by itself (and leaves the
  # local app config alone); with --infra-only, refresh the local config.
  [ "$do_app" = "1" ] || configure_app
fi
if [ "$do_app" = "1" ]; then
  publish_app
fi
