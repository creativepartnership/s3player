# Deploying S3Player by hand

`scripts/setup.sh` and `scripts/deploy.sh` do all of this for you. This is
what they do, step by step, if you'd rather run it yourself or need to
debug something. Prerequisites are the same (see `README.md`).

## 1. Settings

```bash
cp infra/.env.example infra/.env
```

Edit `infra/.env`: deployment name, AWS profile/region, and optionally a
TMDb API key and a custom domain. Every value is explained in the file. It's
git-ignored. Real environment variables with the same names override it, and
`npx cdk deploy --context <key>=<value>` (`envName`, `customDomain`,
`certificateArn`, `tmdbApiKey`, `localDevOrigin`) overrides both.

## 2. AWS resources

```bash
cd infra
npm ci
export AWS_PROFILE=<profile>   # if not using default credentials
export CDK_DEFAULT_REGION=<region>
npx cdk bootstrap              # once per account/region
npx cdk deploy
```

The deploy prints the stack outputs (`Region`, `UserPoolId`,
`UserPoolClientId`, `IdentityPoolId`, `MediaBucketName`, `SiteBucketName`,
`SiteDistributionId`, `CatalogSyncFunctionName`, `SiteUrl`). You can read
them again any time:

```bash
aws cloudformation describe-stacks --stack-name S3PlayerStack-<name> --query 'Stacks[0].Outputs'
```

## 3. App configuration

```bash
cp app/src/environments/aws-config.example.ts app/src/environments/aws-config.ts
```

Fill in the stack outputs (`scripts/configure-app.sh` does this
automatically). The file is git-ignored.

## 4. Build and publish the app

```bash
cd app
npm ci
npx ng build
aws s3 sync dist/app/browser/ s3://<SiteBucketName>/ --delete \
  --cache-control "public, max-age=31536000, immutable" --exclude index.html
aws s3 cp dist/app/browser/index.html s3://<SiteBucketName>/index.html --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id <SiteDistributionId> --paths "/index.html"
```

Bundle filenames are content-hashed, so they can be cached forever; only
`index.html` must always be fresh, which is why only it is invalidated.

## 5. Users

There's no self-signup. Create each account in the Cognito user pool and
add it to one group:

- `Admins`: everything, including the admin screens;
- `Uploaders`: browse and upload into their categories;
- `Users`: browse their categories.

```bash
aws cognito-idp admin-create-user --user-pool-id <UserPoolId> \
  --username someone@example.com \
  --user-attributes Name=email,Value=someone@example.com Name=email_verified,Value=true \
    'Name=custom:categories,Value="movies,photos"'

aws cognito-idp admin-add-user-to-group --user-pool-id <UserPoolId> \
  --username someone@example.com --group-name Users
```

Cognito emails a temporary password; the login page asks for a new one at
first sign-in. `custom:categories` is a comma-separated list of the category
keys you define under Admin → Directories (not needed for Admins).

## Updating

After pulling new code: redeploy the stack (step 2) whenever anything under
`infra/` changed, *or* under `app/src/app/core/media/` or
`app/src/app/core/db/` (the catalog-sync Lambda bundles that code), then
rebuild and publish the app (step 4).

## Several environments (e.g. test and production)

Each environment is a separate stack with its own users, buckets, catalog and
CloudFront distribution, configured in its own settings file
`infra/.env.<name>` (git-ignored, same keys as `.env.example`, with a
different `S3PLAYER_ENV_NAME`). Every script takes `--env <name>` to use it:

```bash
scripts/deploy.sh --env production
scripts/add-user.sh --env production you@example.com Admins
```

Without `--env` the scripts use `infra/.env`. Publishing the app always
builds it against the chosen environment's stack, then restores
`app/src/environments/aws-config.ts`, so `npm start` keeps pointing where it
did; run `scripts/configure-app.sh --env <name>` to point it elsewhere.

## Catalog sync

The `s3player-catalog-sync-<name>` Lambda runs by itself a minute or so after
files change under `media/`. To resync everything by hand (e.g. for files
that were in the bucket before the category was created):

```bash
aws lambda invoke --function-name s3player-catalog-sync-<name> \
  --cli-binary-format raw-in-base64-out --payload '{"action":"resync"}' /dev/stdout
```

Logs are in the CloudWatch log group `/aws/lambda/s3player-catalog-sync-<name>`;
batches that fail three times end up in the catalog-sync dead-letter SQS
queue.

A full resync also hands every video to `s3player-media-transcode-<name>`,
which skips the ones it has already checked (it tags each file
`s3player-playback=<result>`: `ok`, `converted`, `too-large`,
`unsupported-<codec>`…). To check one file again, delete that tag. To run
it on one file by hand:

```bash
aws lambda invoke --function-name s3player-media-transcode-<name> \
  --cli-binary-format raw-in-base64-out \
  --payload '{"keys":["media/movies/Some Movie.mkv"]}' /dev/stdout
```

Deploying it builds a container image, so Docker must be running; set
`S3PLAYER_TRANSCODE=false` in `infra/.env` to deploy without it.

## Local development

```bash
scripts/configure-app.sh   # or fill in aws-config.ts by hand (step 3)
cd app && npm start         # http://localhost:4200
```

This runs against your deployed stack; the media bucket's CORS config allows
`http://localhost:4200` (`S3PLAYER_LOCAL_DEV_ORIGIN` in `infra/.env`).

## Why CloudFront and not S3 static website hosting

Static website hosting needs a public bucket policy, which some AWS accounts
or organizations block outright (via an SCP), regardless of bucket settings.
CloudFront with Origin Access Control reads from a fully private bucket
instead, and adds HTTPS and a custom domain. The app uses hash-based routing
(`/#/library`), so every request is for `/` or a static file and there's no
deep-link 404 to handle.
