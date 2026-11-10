# shellcheck shell=bash
# Shared helpers for the S3Player scripts. Sourced, not run directly.
# Written for bash 3.2 (the macOS default) as well as newer bash on Linux.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
APP_DIR="$ROOT_DIR/app"
APP_CONFIG_FILE="$APP_DIR/src/environments/aws-config.ts"

# Several deployments (e.g. a test one and production) side by side: each has
# its own settings file, infra/.env.<name>, picked with `--env <name>` on any
# script (or S3PLAYER_ENV=<name>). Without it, infra/.env is used. This runs
# while the script sources this file, so `--env` is removed from the script's
# own arguments before it parses them.
S3PLAYER_ENV="${S3PLAYER_ENV:-}"
_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --env) [ $# -ge 2 ] || { printf 'Error: --env needs a name\n' >&2; exit 1; }; S3PLAYER_ENV="$2"; shift 2 ;;
    --env=*) S3PLAYER_ENV="${1#--env=}"; shift ;;
    *) _args+=("$1"); shift ;;
  esac
done
set -- ${_args[@]+"${_args[@]}"}
unset _args
if [ -n "$S3PLAYER_ENV" ]; then
  case "$S3PLAYER_ENV" in
    *[![:lower:][:digit:]-]*) printf 'Error: --env must be lowercase letters, digits and hyphens\n' >&2; exit 1 ;;
  esac
  ENV_FILE="$INFRA_DIR/.env.$S3PLAYER_ENV"
else
  ENV_FILE="$INFRA_DIR/.env"
fi
ENV_LABEL="${ENV_FILE#"$ROOT_DIR/"}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31mError:\033[0m %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed. $2"
}

check_prerequisites() {
  require_cmd aws "Install the AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  require_cmd node "Install Node.js 22 or newer: https://nodejs.org/"
  require_cmd npm "It comes with Node.js."
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 22 ] || die "Node.js 22 or newer is required (found $(node --version))."
}

# Asks a question with a default; prints the answer. Usage: ask "Question" "default"
ask() {
  local prompt="$1" default="${2:-}" answer
  if [ -n "$default" ]; then
    read -r -p "$prompt [$default]: " answer
    printf '%s' "${answer:-$default}"
  else
    read -r -p "$prompt: " answer
    printf '%s' "$answer"
  fi
}

# Yes/no question. Usage: if confirm "Question" y; then ...
confirm() {
  local prompt="$1" default="${2:-y}" answer hint="[Y/n]"
  [ "$default" = "n" ] && hint="[y/N]"
  read -r -p "$prompt $hint: " answer
  answer="${answer:-$default}"
  case "$answer" in
    [Yy]*) return 0 ;;
    *) return 1 ;;
  esac
}

# Loads infra/.env and derives the variables the other scripts use.
load_env() {
  [ -f "$ENV_FILE" ] || die "$ENV_LABEL not found. Run scripts/setup.sh${S3PLAYER_ENV:+ --env $S3PLAYER_ENV} first (or copy infra/.env.example)."
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  # An empty AWS_PROFILE would make the AWS CLI look for a profile named "".
  if [ -z "${AWS_PROFILE:-}" ]; then unset AWS_PROFILE; fi
  : "${S3PLAYER_ENV_NAME:?S3PLAYER_ENV_NAME is not set in $ENV_LABEL}"
  : "${AWS_REGION:?AWS_REGION is not set in $ENV_LABEL}"
  # infra/bin/s3player.ts reads the same file (and only that one).
  export S3PLAYER_ENV_FILE="$ENV_FILE"
  export AWS_DEFAULT_REGION="$AWS_REGION"
  export CDK_DEFAULT_REGION="$AWS_REGION"
  STACK_NAME="S3PlayerStack-${S3PLAYER_ENV_NAME}"
}

check_aws_credentials() {
  local identity
  # shellcheck disable=SC2016  # the single quotes are literal text, $AWS_PROFILE does expand
  identity="$(aws sts get-caller-identity --query '[Account,Arn]' --output text 2>/dev/null)" ||
    die "No valid AWS credentials${AWS_PROFILE:+ for profile '$AWS_PROFILE'}. Run 'aws configure' or 'aws sso login' (or 'aws login') first."
  AWS_ACCOUNT_ID="$(printf '%s' "$identity" | cut -f1)"
  export CDK_DEFAULT_ACCOUNT="$AWS_ACCOUNT_ID"
  ok "AWS account $AWS_ACCOUNT_ID, region $AWS_REGION ($(printf '%s' "$identity" | cut -f2))"
}

stack_output() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}

ensure_cdk_bootstrap() {
  if aws cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1; then
    ok "CDK already bootstrapped in $AWS_REGION"
  else
    info "Bootstrapping CDK in account $AWS_ACCOUNT_ID, region $AWS_REGION (one-time)"
    (cd "$INFRA_DIR" && npx cdk bootstrap "aws://$AWS_ACCOUNT_ID/$AWS_REGION")
  fi
}

install_deps() {
  local dir
  for dir in "$INFRA_DIR" "$APP_DIR"; do
    # Only when package-lock.json changed since the last install: `npm ci`
    # wipes node_modules, which would also break a running `npm start`.
    if [ ! -f "$dir/node_modules/.package-lock.json" ] || [ "$dir/package-lock.json" -nt "$dir/node_modules/.package-lock.json" ]; then
      info "Installing dependencies in ${dir##*/}/"
      (cd "$dir" && npm ci --no-audit --no-fund)
    fi
  done
}

deploy_infra() {
  if [ "${S3PLAYER_TRANSCODE:-true}" != "false" ]; then
    require_cmd docker "Install Docker (https://docs.docker.com/get-docker/), or set S3PLAYER_TRANSCODE=false in infra/.env to deploy without video conversion."
    docker info >/dev/null 2>&1 || die "Docker isn't running: start it (e.g. Docker Desktop), or set S3PLAYER_TRANSCODE=false in infra/.env."
  fi
  info "Deploying the AWS resources (stack $STACK_NAME)"
  # CDK asks for confirmation before creating or widening IAM permissions;
  # pass --yes to the calling script to skip that.
  local approval="broadening"
  [ "${ASSUME_YES:-0}" = "1" ] && approval="never"
  (cd "$INFRA_DIR" && npx cdk deploy "$STACK_NAME" --require-approval "$approval")
}

# Writes app/src/environments/aws-config.ts from the deployed stack's outputs.
configure_app() {
  info "Writing app configuration from the stack outputs"
  local region pool client identity bucket fn users_fn
  region="$(stack_output Region)"
  pool="$(stack_output UserPoolId)"
  client="$(stack_output UserPoolClientId)"
  identity="$(stack_output IdentityPoolId)"
  bucket="$(stack_output MediaBucketName)"
  fn="$(stack_output CatalogSyncFunctionName)"
  users_fn="$(stack_output UserAdminFunctionName)"
  [ "$pool" != "None" ] && [ -n "$pool" ] || die "Stack $STACK_NAME has no outputs. Has it been deployed?"
  cat >"$APP_CONFIG_FILE" <<EOF
// Generated by scripts/configure-app.sh from the $STACK_NAME stack outputs.
// Git-ignored (it identifies your deployment); see aws-config.example.ts.
export const awsConfig = {
  region: '$region',
  userPoolId: '$pool',
  userPoolClientId: '$client',
  identityPoolId: '$identity',
  mediaBucketName: '$bucket',
  catalogSyncFunctionName: '$fn',
  userAdminFunctionName: '$users_fn',
};
EOF
  ok "Wrote ${APP_CONFIG_FILE#"$ROOT_DIR/"}"
}

publish_app() {
  local site_bucket distribution previous_config=""
  site_bucket="$(stack_output SiteBucketName)"
  distribution="$(stack_output SiteDistributionId)"
  # Always build against this stack's outputs (the config file may point at
  # another deployment), then put back what was there, so `npm start` keeps
  # using whichever deployment it used before.
  if [ -f "$APP_CONFIG_FILE" ]; then
    previous_config="$(mktemp)"
    cp "$APP_CONFIG_FILE" "$previous_config"
  fi
  configure_app
  info "Building the app"
  if ! (cd "$APP_DIR" && npx ng build); then
    [ -n "$previous_config" ] && mv "$previous_config" "$APP_CONFIG_FILE"
    die "The app build failed."
  fi
  if [ -n "$previous_config" ]; then
    mv "$previous_config" "$APP_CONFIG_FILE"
  fi
  info "Uploading the app to s3://$site_bucket"
  # Bundle filenames are content-hashed, so they can be cached forever;
  # index.html must always be revalidated so new releases show up.
  aws s3 sync "$APP_DIR/dist/app/browser/" "s3://$site_bucket/" --delete --only-show-errors \
    --cache-control "public, max-age=31536000, immutable" --exclude index.html
  aws s3 cp "$APP_DIR/dist/app/browser/index.html" "s3://$site_bucket/index.html" --only-show-errors \
    --cache-control "no-cache"
  info "Invalidating the CloudFront cache"
  aws cloudfront create-invalidation --distribution-id "$distribution" --paths "/index.html" \
    --query 'Invalidation.Id' --output text >/dev/null
  ok "App published: $(stack_output SiteUrl)"
}

# Usage: create_user EMAIL GROUP CATEGORIES
# GROUP is Admins, Uploaders or Users. CATEGORIES is a comma-separated list
# of category keys (ignored for Admins, who see everything).
create_user() {
  local email="$1" group="$2" categories="${3:-}" pool
  pool="$(stack_output UserPoolId)"
  local attrs=("Name=email,Value=$email" "Name=email_verified,Value=true")
  if [ -n "$categories" ]; then
    attrs+=("Name=custom:categories,Value=\"$categories\"")
  fi
  local password_args=()
  if confirm "Let Cognito email $email a temporary password?" y; then
    : # Cognito generates one and sends the invitation email
  else
    local password
    read -r -s -p "Temporary password for $email (min 8 chars, upper, lower, digit, symbol): " password
    echo
    password_args=(--temporary-password "$password" --message-action SUPPRESS)
  fi
  info "Creating user $email in group $group"
  aws cognito-idp admin-create-user --user-pool-id "$pool" --username "$email" \
    --user-attributes "${attrs[@]}" ${password_args[@]+"${password_args[@]}"} >/dev/null
  aws cognito-idp admin-add-user-to-group --user-pool-id "$pool" --username "$email" --group-name "$group"
  ok "User $email created. They'll be asked to choose a new password at first sign-in."
}

resync_catalog() {
  local fn out
  fn="$(stack_output CatalogSyncFunctionName)"
  users_fn="$(stack_output UserAdminFunctionName)"
  out="$(mktemp)"
  info "Resyncing the catalog with the media bucket"
  aws lambda invoke --function-name "$fn" --cli-binary-format raw-in-base64-out \
    --payload '{"action":"resync"}' "$out" >/dev/null
  ok "Catalog sync result: $(cat "$out")"
  rm -f "$out"
}
