#!/usr/bin/env bash
# First-time setup of S3Player in YOUR AWS account: asks a few questions,
# writes infra/.env, deploys the AWS resources (S3 buckets, CloudFront,
# Cognito, the catalog-sync Lambda), generates the app's configuration from
# the result, publishes the app and creates your admin user.
#
# Safe to re-run: it offers to keep your existing infra/.env, CDK deploys
# are incremental, and you can skip creating the admin user.
#
# Usage: scripts/setup.sh [--env <name>]

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

cat <<'EOF'

  S3Player setup
  ──────────────
  This deploys S3Player into the AWS account your AWS CLI credentials point
  at, and you pay AWS for what it uses there: mainly S3 storage for your
  media (~$0.023 per GB per month) and data transfer when streaming beyond
  AWS's monthly free allowance (~$0.09 per GB). See "Costs" in README.md.

EOF

check_prerequisites

if [ -f "$ENV_FILE" ] && confirm "infra/.env already exists. Keep its settings?" y; then
  :
else
  info "A few questions (press Enter to accept the [default])"
  env_name="$(ask "Deployment name (used in AWS resource names: lowercase letters, digits, hyphens)" "dev")"
  case "$env_name" in
    *[!a-z0-9-]* | "") die "Invalid deployment name '$env_name'." ;;
  esac
  profile="$(ask "AWS CLI profile (empty = default credentials)" "${AWS_PROFILE:-}")"
  region="$(ask "AWS region" "${AWS_REGION:-${AWS_DEFAULT_REGION:-eu-west-1}}")"
  tmdb_key="$(ask "TMDb v3 API key for posters/plots (optional, free at themoviedb.org/settings/api)" "")"
  tmdb_language="$(ask "Language for movie/TV titles and plots (e.g. en-US, it-IT)" "en-US")"
  transcode=false
  if confirm "Convert uploaded videos browsers can't play (MKV, AC3/DTS audio) to MP4? Deploying it needs Docker" y; then
    transcode=true
  fi
  domain=""
  cert_arn=""
  if confirm "Use your own domain for the site (needs an ACM certificate in us-east-1)?" n; then
    domain="$(ask "Domain (e.g. media.example.com)" "")"
    cert_arn="$(ask "ACM certificate ARN for it (must be in us-east-1)" "")"
    [ -n "$domain" ] && [ -n "$cert_arn" ] || die "Domain and certificate ARN must both be set."
  fi
  cat >"$ENV_FILE" <<EOF
# Written by scripts/setup.sh. See .env.example for what each setting means.
S3PLAYER_ENV_NAME=$env_name
AWS_PROFILE=$profile
AWS_REGION=$region
S3PLAYER_LOCAL_DEV_ORIGIN=http://localhost:4200
S3PLAYER_CUSTOM_DOMAIN=$domain
S3PLAYER_CERTIFICATE_ARN=$cert_arn
S3PLAYER_TMDB_API_KEY=$tmdb_key
S3PLAYER_TMDB_LANGUAGE=$tmdb_language
S3PLAYER_TRANSCODE=$transcode
EOF
  ok "Saved settings to infra/.env (git-ignored)"
fi

load_env
check_aws_credentials

echo
confirm "Deploy stack $STACK_NAME to account $AWS_ACCOUNT_ID in $AWS_REGION now?" y || die "Cancelled."

install_deps
ensure_cdk_bootstrap
deploy_infra
configure_app
publish_app

echo
if confirm "Create your admin user now?" y; then
  admin_email="$(ask "Admin email address" "")"
  [ -n "$admin_email" ] || die "An email address is required."
  create_user "$admin_email" Admins ""
fi

site_url="$(stack_output SiteUrl)"
cat <<EOF

  Done.
  ─────
  Open $site_url and sign in.

  Next steps:
  1. In the app, go to Admin → Directories and add a category (e.g. "Movies",
     type movie). That creates a folder like media/movies/ in the media bucket.
  2. Upload files from the app, or copy them straight into that folder:
       aws s3 sync ~/Movies s3://$(stack_output MediaBucketName)/media/movies/
     They appear in the library a minute or two later.
  3. More users: scripts/add-user.sh
     Updates after pulling new code: scripts/deploy.sh
EOF
if [ -n "${S3PLAYER_CUSTOM_DOMAIN:-}" ]; then
  cat <<EOF

  Custom domain: point a DNS CNAME for $S3PLAYER_CUSTOM_DOMAIN at the
  CloudFront distribution domain (aws cloudfront get-distribution
  --id $(stack_output SiteDistributionId) --query Distribution.DomainName).
EOF
fi
