# S3Player infrastructure (AWS CDK)

The AWS CDK (TypeScript) stack for S3Player, plus the catalog-sync Lambda.
`scripts/setup.sh` / `scripts/deploy.sh` at the repository root drive it;
`DEPLOY.md` shows the manual equivalent. What it creates and why is in the
root `README.md`.

- `bin/s3player.ts`: entry point. Reads the deployment settings from
  `.env` (git-ignored; template: `.env.example`), real environment
  variables, or `--context` overrides.
- `lib/s3player-stack.ts`: the stack (buckets, CloudFront, Cognito, IAM
  roles, SQS, Lambda, S3 event notifications).
- `lambda/catalog-sync/`: the Lambda that keeps `db/library.sqlite` in sync
  with the media bucket. Bundled by esbuild (a devDependency, so no Docker
  needed) via `NodejsFunction`. It imports shared code from `../app/src`.

## Commands

Run from this directory, with AWS credentials for the target account:

* `npx cdk diff`: compare the deployed stack with the code
* `npx cdk deploy`: deploy
* `npx cdk synth`: print the CloudFormation template
* `npx tsc -p lambda`: type-check the Lambda
* `npx cdk destroy`: delete everything. **The buckets are set to delete
  their contents with the stack, media included.** Back up first.

## Settings (`.env`)

| Variable                    | Meaning                                                    |
|-----------------------------|------------------------------------------------------------|
| `S3PLAYER_ENV_NAME`         | Deployment name used in resource names (default `dev`)     |
| `AWS_PROFILE`, `AWS_REGION` | Where to deploy (used by the scripts)                      |
| `S3PLAYER_LOCAL_DEV_ORIGIN` | Extra CORS origin for local development                    |
| `S3PLAYER_CUSTOM_DOMAIN`    | Optional domain for the site                               |
| `S3PLAYER_CERTIFICATE_ARN`  | ACM certificate (us-east-1) for that domain                |
| `S3PLAYER_TMDB_API_KEY`     | Optional TMDb v3 key for posters/plots (stored in the Lambda's configuration) |
| `S3PLAYER_TMDB_LANGUAGE`    | Language of the fetched titles/plots, e.g. `it-IT` (default `en-US`) |

Keep the custom domain settings in place on every deploy. CloudFormation
makes the distribution match the template, so an alias added through the
CloudFront console instead would be removed by the next deploy.
