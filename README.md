# S3Player

A self-hosted media player for movies, TV shows, music and photos, running
entirely on your own AWS account: a static Angular web app (served through
CloudFront), your media in a private S3 bucket, sign-in with Amazon Cognito.
There's no server to run or patch. The browser talks directly to S3 with
temporary, per-user credentials, and one small Lambda function keeps the
library catalog in sync with what's in the bucket.

- **Drop files in, they show up.** Upload from the app, the S3 console or
  `aws s3 sync`; a minute or two later the movie, episode, album or photo is
  in the library, with its title cleaned up from the file name.
- **Posters, plots and cast** from [TMDb](https://www.themoviedb.org/)
  (optional, free API key); **album covers** from MusicBrainz / Cover Art
  Archive.
- **Subtitles:** `.srt` and `.vtt` next to the video (`Movie.srt`,
  `Movie.it.srt`, or in the movie's folder); `.srt` is converted to WebVTT
  for the browser automatically.
- **TV shows** grouped by show and season, **music** by artist and album.
- **Per-browser watch progress**, light/dark theme.
- **Users and roles** (Admins, Uploaders, Users) with per-user categories,
  and a per-user **Download** permission (movies, single episodes, whole albums as ZIP).

## How your media should be organised

Each category (created in the app under Admin → Directories) is a folder
under `media/` in the bucket, with a type:

| Type     | Layout                                                              |
|----------|---------------------------------------------------------------------|
| Movies   | `Movie.Title.2010.mkv` (+ `Movie.Title.2010.srt`, `.it.srt`, `-poster.jpg`), or a folder per movie: `Movie Title (2010)/movie.mkv` + subtitles/poster |
| TV shows | `Show/Season 1/Show.S01E01.mkv` (+ subtitles), or one folder per episode |
| Music    | `Artist/Album/01 - Track.mp3` (+ `cover.jpg`)                      |
| Photos   | any `.jpg` / `.png` / `.webp`                                       |

Video: mp4, mkv, webm, mov, m4v, avi. Audio: mp3, flac, m4a, aac, ogg, wav.
What actually plays depends on the browser (mp4/H.264 + AAC is the safe bet;
mkv works in Chromium-based browsers when the codecs inside are supported).

## Setup

You need an AWS account, plus on your machine:

- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html),
  signed in to that account (`aws configure`, `aws sso login` or `aws login`)
  with permission to create the resources below (an administrator user/role
  is simplest);
- [Node.js](https://nodejs.org/) 22 or newer;
- [Docker](https://docs.docker.com/get-docker/), running while you deploy:
  it builds the video-conversion function (optional, see below);
- bash (macOS, Linux, or WSL on Windows).

Then:

```bash
git clone <this repository> s3player
cd s3player
scripts/setup.sh
```

The script asks for a deployment name, AWS region, an optional TMDb API key
and an optional custom domain. It saves your answers to `infra/.env`, deploys
everything into your account, writes the app's configuration from the
result, publishes the app and creates your admin user (Cognito emails you a
temporary password). It ends by printing the URL of your S3Player.

Your settings and generated configuration (`infra/.env`,
`app/src/environments/aws-config.ts`) are git-ignored: they never end up in
the repository.

### Day to day

| What                                    | How                                  |
|-----------------------------------------|--------------------------------------|
| Invite a viewer or uploader             | Admin → Users → Invite               |
| Add an administrator                    | `scripts/add-user.sh`                |
| Update after `git pull`                 | `scripts/deploy.sh`                  |
| Changed a setting in `infra/.env`       | `scripts/deploy.sh --infra-only`     |
| Fresh clone / new machine, same deployment | copy your `infra/.env`, then `scripts/configure-app.sh` |
| Re-check the whole bucket               | Admin → Library → Resync, or `scripts/configure-app.sh --resync` |
| Run the app locally                     | `scripts/configure-app.sh`, then `cd app && npm start` |

Doing it by hand instead of with the scripts: see [`DEPLOY.md`](DEPLOY.md).

### Custom domain (optional)

Request (or import) a certificate for your domain in **ACM in us-east-1**
(CloudFront only uses certificates from that region), give `setup.sh` the
domain and the certificate ARN, and after deploying, add a DNS CNAME from
your domain to the CloudFront distribution's domain name (shown at the end
of setup).

## What it creates in your account

All resource names include your deployment name (`<name>` below).

- **S3:** `s3player-site-<name>-<account>` (the built app, private, served
  by CloudFront) and `s3player-media-<name>-<account>` (your media under
  `media/`, the catalog at `db/library.sqlite`; private, Block Public Access
  on).
- **CloudFront** distribution for the app (HTTPS).
- **Cognito** user pool (no self-signup) and identity pool, with IAM roles
  for the Admins, Uploaders and Users groups.
- **Lambda** `s3player-catalog-sync-<name>`, fed by an **SQS** queue (plus a
  dead-letter queue) that receives the bucket's S3 event notifications.
- **Lambda** `s3player-user-admin-<name>`: Admin → Users calls it to
  invite and manage viewers/uploaders. It holds the Cognito permissions and
  refuses to create or change administrator accounts, whatever the browser
  sends.
- **Lambda** `s3player-media-transcode-<name>` (unless
  `S3PLAYER_TRANSCODE=false`): a container image with ffmpeg, stored in the
  CDK bootstrap's **ECR** repository, fed by its own SQS queue.

### Video conversion

Browsers play MP4 with H.264/HEVC/AV1 video and AAC/MP3/Opus audio. Plenty
of files are MKV (Safari won't open them) or have AC3/DTS audio (Chrome and
Firefox play the picture with no sound). After a video is catalogued, the
transcode function checks it and, if needed, **replaces it with an MP4 of
the same name**:

- the video stream is copied, not re-encoded: same quality, and it takes a
  couple of minutes, not hours;
- a stereo AAC track becomes the default audio; the original tracks (5.1
  AC3/DTS, other languages) are kept after it;
- text subtitles inside the file are saved next to it as
  `<name>.<language>.vtt`, so the player offers them.

Not handled: video in older codecs (XviD/DivX, VC-1), which would need
re-encoding, and files over ~9 GB (Lambda's disk limit). Those stay as they
are; convert them before uploading (e.g. with HandBrake). Subtitles burned
into the picture can't be removed by anything.

`npx cdk destroy` in `infra/` removes all of it, **including both buckets
and the media in them**.

## Costs

You pay AWS directly; S3Player itself is free. Rough figures (check
[AWS pricing](https://aws.amazon.com/pricing/) for your region):

- **S3 storage** for your media: ~$0.023 per GB per month (500 GB ≈ $11.50/month).
- **Streaming** goes straight from S3 to the browser. Data transfer out is
  ~$0.09 per GB once past AWS's free allowance (100 GB/month across the
  account at the time of writing). A 4 GB movie ≈ $0.36.
- Lambda, SQS, CloudFront for the app itself, and Cognito: typically cents
  or nothing for a personal/family library. Converting a 2-hour movie uses
  a few minutes of a 3 GB Lambda: around one cent.

## Security model: read before inviting people

- **Only people you create can sign in.** There's no self-signup.
- **Categories are a convenience filter, not a security boundary.** Every
  signed-in user's credentials can read *every* file in the media bucket,
  and the catalog (readable by all users) lists every file. Someone with
  technical skills and an account can get to media outside their
  categories. Fine for a household; not for keeping content truly separate
  between users. Use separate deployments for that.
- **Uploaders** can write under `media/` but can't delete anything or touch
  the catalog. **Admins** can do everything, including deleting media.
- **The Download permission is also a convenience, not a security boundary.**
  It only hides or shows the Download buttons. Playing a file uses the same
  signed S3 URLs, so anyone who can play something can technically save it.
  Admins can always download.
- The configuration values in the built app (Cognito IDs, bucket name) are
  public by nature, like those of any web app; access is controlled by
  Cognito sign-in and the IAM roles, not by keeping those IDs secret.
- Your TMDb API key is stored in the Lambda's configuration in your
  account, not in the app the browser downloads.

## Architecture notes

- **No application server, no API Gateway.** The app reads and writes S3
  directly with temporary credentials from the Cognito identity pool, scoped
  by the user's group.
- **Two buckets.** CloudFront's origin access grants it read access to its
  whole origin bucket, so the media lives in a separate bucket CloudFront
  never touches. Only Cognito-issued credentials can read it.
- **The catalog is a SQLite file** (sql.js, SQLite compiled to WebAssembly)
  at `db/library.sqlite`, loaded whole by the browser. Writes are guarded
  by an S3 ETag check (optimistic concurrency); there are two writers, the
  catalog-sync Lambda and admin edits, and whichever loses a race reloads
  and re-applies its change.
- **Catalog sync** (`infra/lambda/catalog-sync`): S3 events for `media/` go
  to SQS, which batches them for ~60 s (uploading a folder fires many at
  once); the function then re-lists each touched category and makes the
  catalog match: new playable files become items (subtitle conversion,
  TMDb/MusicBrainz lookups), sidecars that arrive later get attached, and
  items whose file is gone are removed. It's idempotent, which is what keeps
  the events fired by its own writes (converted subtitles, posters) from
  looping.
- **Shared code.** The file grouping and title parsing
  (`app/src/app/core/media/`) and the catalog row helpers
  (`app/src/app/core/db/catalog-ops.ts`) are used by both the app (to
  preview uploads) and the Lambda, which bundles them from there. Changing
  them means redeploying the infrastructure too (`scripts/deploy.sh` does
  both).
- **Watch progress** is kept per browser (localStorage), since regular users
  have no write access to the bucket.

Layout: `infra/` is the AWS CDK (TypeScript) stack and the Lambda, `app/` is
the Angular app (standalone components, Tailwind + daisyUI), `scripts/` are
the setup and deploy scripts.

## Credits

Movie and TV metadata and images are provided by
[TMDb](https://www.themoviedb.org/). This product uses the TMDB API but is
not endorsed or certified by TMDB. Album covers come from
[MusicBrainz](https://musicbrainz.org/) and the
[Cover Art Archive](https://coverartarchive.org/).

## License

[MIT](LICENSE) © 2026 Ennio Porro
