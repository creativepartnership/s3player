#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { S3PlayerStack } from '../lib/s3player-stack';

// Deployment-specific settings come from infra/.env (git-ignored; see
// infra/.env.example, or let scripts/setup.sh write it) or from real
// environment variables, which take precedence. `--context key=value` on the
// cdk command line still works too, for one-off overrides.
// scripts/*.sh --env <name> point S3PLAYER_ENV_FILE at infra/.env.<name>.
const envFile = process.env.S3PLAYER_ENV_FILE || path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  // Doesn't override variables already set in the environment.
  process.loadEnvFile(envFile);
}

const app = new cdk.App();

function setting(contextKey: string, envKey: string): string | undefined {
  const value = app.node.tryGetContext(contextKey) ?? process.env[envKey];
  return value === undefined || value === '' ? undefined : String(value);
}

const envName = setting('envName', 'S3PLAYER_ENV_NAME') ?? 'dev';
const localDevOrigin = setting('localDevOrigin', 'S3PLAYER_LOCAL_DEV_ORIGIN') ?? 'http://localhost:4200';
// Optional custom domain for the CloudFront distribution. Both must be set
// together; the certificate must be in us-east-1 whatever the stack's region
// (a CloudFront requirement). Keep them set on every deploy: CloudFormation
// resets a console-added alias that isn't part of the template.
const customDomain = setting('customDomain', 'S3PLAYER_CUSTOM_DOMAIN');
const certificateArn = setting('certificateArn', 'S3PLAYER_CERTIFICATE_ARN');
// TMDb v3 API key for the catalog-sync Lambda's poster/plot lookups (optional).
const tmdbApiKey = setting('tmdbApiKey', 'S3PLAYER_TMDB_API_KEY');
// Language of the titles/plots fetched from TMDb (e.g. it-IT, en-US).
const tmdbLanguage = setting('tmdbLanguage', 'S3PLAYER_TMDB_LANGUAGE');
// Video conversion for browser playback (needs Docker to deploy). On unless
// set to false.
const transcode = setting('transcode', 'S3PLAYER_TRANSCODE') !== 'false';

new S3PlayerStack(app, `S3PlayerStack-${envName}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  envName,
  localDevOrigin,
  customDomain,
  certificateArn,
  tmdbApiKey,
  tmdbLanguage,
  transcode,
});
