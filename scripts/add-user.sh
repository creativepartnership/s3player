#!/usr/bin/env bash
# Creates a user in your S3Player deployment's Cognito user pool (there's no
# self-signup: every account is created by you).
#
# Usage: scripts/add-user.sh [--env <name>] [email] [Admins|Uploaders|Users] [categories]
#   Admins     everything, including the admin screens
#   Uploaders  browse + upload into their categories
#   Users      browse their categories only
#   categories comma-separated category keys, as defined in Admin → Directories
#              (e.g. "movies,photos"); not used for Admins
# Anything not given on the command line is asked for.

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

load_env
check_aws_credentials

email="${1:-$(ask "Email address" "")}"
[ -n "$email" ] || die "An email address is required."
group="${2:-$(ask "Group (Admins, Uploaders or Users)" "Users")}"
case "$group" in
  Admins | Uploaders | Users) ;;
  *) die "Group must be Admins, Uploaders or Users." ;;
esac
categories=""
if [ "$group" != "Admins" ]; then
  categories="${3:-$(ask "Categories they can access (comma-separated keys, e.g. movies,photos)" "")}"
  [ -n "$categories" ] || warn "No categories: this user won't see anything until you set custom:categories."
fi

create_user "$email" "$group" "$categories"
