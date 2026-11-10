import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as path from 'path';

export interface S3PlayerStackProps extends cdk.StackProps {
  /** Short environment name used in resource names, e.g. 'dev' or 'prod'. */
  envName: string;
  /** Extra CORS origin allowed for local development (e.g. http://localhost:4200). */
  localDevOrigin: string;
  /** Custom domain (e.g. s3player.example.com) to attach to the CloudFront distribution
   * as an alternate domain name. Must be set together with certificateArn. */
  customDomain?: string;
  /** ACM certificate ARN for customDomain — must exist in us-east-1 regardless of this
   * stack's own region (a CloudFront requirement). */
  certificateArn?: string;
  /** TMDb v3 API key used by the catalog-sync Lambda for posters/plot/cast.
   * Empty skips those lookups (MetadataClient fails soft). */
  tmdbApiKey?: string;
  /** TMDb language for titles/plots, e.g. "it-IT" (default "en-US"). */
  tmdbLanguage?: string;
  /** Deploy the media-transcode function, which makes uploaded videos
   * playable in every browser (MKV → MP4, AC3/DTS → AAC). Building it needs
   * Docker running on the deploying machine. Default true. */
  transcode?: boolean;
}

/**
 * S3Player infrastructure: a private bucket for the built Angular app served through
 * CloudFront (Origin Access Control — no public bucket policy, since some AWS accounts/orgs
 * block those via SCP regardless of bucket-level settings), a separate private bucket for
 * media + the sql.js catalog file, a Cognito User Pool (self-signup disabled — accounts are
 * created directly via the console/CLI) and a Cognito Identity Pool that federates signed-in
 * users to one of three IAM roles (Admin/Uploader/User) based on their User Pool group, via
 * Cognito's group-to-IAM-role token mapping. No API Gateway.
 *
 * One Lambda keeps the catalog in sync with the bucket: S3 event notifications
 * for media/ go to an SQS queue that batches them for a minute (uploading a
 * movie folder fires several events at once), then the catalog-sync function
 * re-lists each touched directory and adds/updates/removes catalog items to
 * match. The app no longer inserts items itself — it uploads, and the Lambda
 * catalogs. Admins can also invoke the function directly ("Resync").
 *
 * The site and media buckets are kept separate rather than merged into one with prefixes:
 * CloudFront's Origin Access Control, as wired up by CDK, grants the distribution
 * s3:GetObject on the *entire* origin bucket with no prefix scoping. A shared bucket would
 * mean CloudFront (and so anyone on the internet, unauthenticated) could fetch every media
 * file and the catalog DB directly. Keeping media in a bucket CloudFront never touches means
 * that data is reachable only via Cognito-issued, role-scoped credentials.
 */
export class S3PlayerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: S3PlayerStackProps) {
    super(scope, id, props);

    const { envName, localDevOrigin, customDomain, certificateArn, tmdbApiKey, tmdbLanguage } = props;
    const transcode = props.transcode ?? true;
    if (Boolean(customDomain) !== Boolean(certificateArn)) {
      throw new Error('customDomain and certificateArn must be set together (or both omitted).');
    }

    // ---------------------------------------------------------------------
    // S3 buckets
    // ---------------------------------------------------------------------

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `s3player-site-${envName}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      defaultRootObject: 'index.html',
      domainNames: customDomain ? [customDomain] : undefined,
      certificate: certificateArn
        ? acm.Certificate.fromCertificateArn(this, 'SiteCertificate', certificateArn)
        : undefined,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
    });
    const siteOrigins = [`https://${distribution.distributionDomainName}`];
    if (customDomain) {
      siteOrigins.push(`https://${customDomain}`);
    }

    const mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      bucketName: `s3player-media-${envName}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      cors: [
        {
          // POST/DELETE are needed for S3 multipart uploads (CreateMultipartUpload/
          // CompleteMultipartUpload use POST, AbortMultipartUpload uses DELETE) —
          // S3Service.uploadFile uses multipart for anything above 16 MB, which is
          // basically every real media file. ETag must be exposed: completing the
          // upload needs every part's ETag. The player reads the main audio
          // track's language from the alternate-language audio files'
          // metadata (set by the media-transcode function).
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.DELETE, s3.HttpMethods.HEAD],
          allowedOrigins: [...siteOrigins, localDevOrigin],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag', 'x-amz-meta-s3player-main-language'],
        },
      ],
    });

    // ---------------------------------------------------------------------
    // Catalog sync: S3 events -> SQS (batching) -> Lambda
    // ---------------------------------------------------------------------

    const catalogSyncTimeout = cdk.Duration.minutes(5);

    const catalogSyncDlq = new sqs.Queue(this, 'CatalogSyncDlq', {
      queueName: `s3player-catalog-sync-dlq-${envName}`,
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    const catalogSyncQueue = new sqs.Queue(this, 'CatalogSyncQueue', {
      queueName: `s3player-catalog-sync-${envName}`,
      // AWS's guidance for SQS-triggered Lambdas: visibility >= 6x the function timeout.
      visibilityTimeout: cdk.Duration.seconds(catalogSyncTimeout.toSeconds() * 6),
      enforceSSL: true,
      deadLetterQueue: { queue: catalogSyncDlq, maxReceiveCount: 3 },
    });

    const catalogSyncFunction = new lambdaNodejs.NodejsFunction(this, 'CatalogSyncFunction', {
      functionName: `s3player-catalog-sync-${envName}`,
      entry: path.join(__dirname, '../lambda/catalog-sync/index.ts'),
      handler: 'handler',
      // The handler imports shared classification/catalog code from
      // ../app/src. Local esbuild (an infra devDependency) follows those
      // imports fine; Docker bundling would not, since it only mounts infra/.
      depsLockFilePath: path.join(__dirname, '../package-lock.json'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: catalogSyncTimeout,
      environment: {
        MEDIA_BUCKET_NAME: mediaBucket.bucketName,
        TMDB_API_KEY: tmdbApiKey ?? '',
        TMDB_LANGUAGE: tmdbLanguage ?? 'en-US',
        // Where the function queues its own follow-up run when a big sync
        // doesn't fit in one invocation's time budget.
        CATALOG_SYNC_QUEUE_URL: catalogSyncQueue.queueUrl,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node24',
      },
    });
    mediaBucket.grantReadWrite(catalogSyncFunction);
    catalogSyncQueue.grantSendMessages(catalogSyncFunction);

    catalogSyncFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(catalogSyncQueue, {
        batchSize: 100,
        maxBatchingWindow: cdk.Duration.seconds(60),
        // Minimum allowed value. The function also retries on catalog ETag
        // conflicts, so two overlapping runs are safe, just wasteful.
        maxConcurrency: 2,
      }),
    );

    // ---------------------------------------------------------------------
    // Media transcode: catalog-sync -> SQS (one video per message) -> a
    // container Lambda with ffmpeg that remuxes videos browsers can't play
    // (see lambda/media-transcode/handler.py).
    // ---------------------------------------------------------------------

    if (transcode) {
      const transcodeTimeout = cdk.Duration.minutes(15);
      const transcodeDlq = new sqs.Queue(this, 'TranscodeDlq', {
        retentionPeriod: cdk.Duration.days(14),
        enforceSSL: true,
      });
      const transcodeQueue = new sqs.Queue(this, 'TranscodeQueue', {
        visibilityTimeout: cdk.Duration.seconds(transcodeTimeout.toSeconds() * 6),
        enforceSSL: true,
        deadLetterQueue: { queue: transcodeDlq, maxReceiveCount: 2 },
      });
      const transcodeFunction = new lambda.DockerImageFunction(this, 'TranscodeFunction', {
        functionName: `s3player-media-transcode-${envName}`,
        description: 'Remuxes uploaded videos to browser-playable MP4 and extracts embedded subtitles.',
        code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, '..', 'lambda', 'media-transcode'), {
          platform: cdk.aws_ecr_assets.Platform.LINUX_ARM64,
        }),
        architecture: lambda.Architecture.ARM_64,
        // More memory = more CPU for the AAC encode; /tmp holds the output.
        memorySize: 3008,
        ephemeralStorageSize: cdk.Size.gibibytes(10),
        timeout: transcodeTimeout,
        environment: { MEDIA_BUCKET_NAME: mediaBucket.bucketName },
      });
      mediaBucket.grantReadWrite(transcodeFunction, 'media/*');
      mediaBucket.grantDelete(transcodeFunction, 'media/*');
      transcodeFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObjectTagging', 's3:PutObjectTagging'],
          resources: [mediaBucket.arnForObjects('media/*')],
        }),
      );
      transcodeFunction.addEventSource(
        new lambdaEventSources.SqsEventSource(transcodeQueue, { batchSize: 1, maxConcurrency: 2 }),
      );
      transcodeQueue.grantSendMessages(catalogSyncFunction);
      catalogSyncFunction.addEnvironment('TRANSCODE_QUEUE_URL', transcodeQueue.queueUrl);
      new cdk.CfnOutput(this, 'TranscodeFunctionName', { value: transcodeFunction.functionName });
    }

    // Only media/ — the catalog itself lives at db/library.sqlite and must
    // not trigger a sync of its own writes.
    for (const eventType of [s3.EventType.OBJECT_CREATED, s3.EventType.OBJECT_REMOVED]) {
      mediaBucket.addEventNotification(eventType, new s3n.SqsDestination(catalogSyncQueue), { prefix: 'media/' });
    }

    // ---------------------------------------------------------------------
    // Cognito User Pool (self-signup disabled — admin provisions users directly)
    // ---------------------------------------------------------------------

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `s3player-users-${envName}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      customAttributes: {
        // Comma-separated list of category keys this user may browse, e.g. "movies,photos".
        // Ignored for members of the Admins group, who implicitly see everything.
        categories: new cognito.StringAttribute({ minLen: 0, maxLen: 2048, mutable: true }),
        // "1" if the user may download files (Download button on movies,
        // episodes and albums). Admins always can. Enforced by the app only:
        // anyone who can play a file can technically fetch it (see README).
        download: new cognito.StringAttribute({ minLen: 0, maxLen: 1, mutable: true }),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      userPoolClientName: `s3player-app-${envName}`,
      generateSecret: false,
      authFlows: { userPassword: true, userSrp: true },
      preventUserExistenceErrors: true,
    });

    // ---------------------------------------------------------------------
    // Identity Pool + IAM roles, one per Cognito group
    // ---------------------------------------------------------------------

    const identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      identityPoolName: `s3player_identity_${envName}`,
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: userPoolClient.userPoolClientId,
          providerName: userPool.userPoolProviderName,
        },
      ],
    });

    const federatedPrincipal = (role: 'authenticated') =>
      new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: { 'cognito-identity.amazonaws.com:aud': identityPool.ref },
          'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': role },
        },
        'sts:AssumeRoleWithWebIdentity',
      );

    // Users group role: read-only on the media bucket, no ListBucket. Category-level
    // restriction is enforced by the app, not by IAM (see README / plan for rationale).
    const userRole = new iam.Role(this, 'UserRole', {
      roleName: `S3PlayerUserRole-${envName}`,
      assumedBy: federatedPrincipal('authenticated'),
    });
    userRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [mediaBucket.arnForObjects('*')],
      }),
    );

    // Uploaders group role: like Users (read-only, no ListBucket), plus PutObject under
    // media/ so this group of accounts can upload files through the app. Not on db/:
    // uploaders never write the catalog (the catalog-sync Lambda does), so they can't
    // overwrite or corrupt it. No DeleteObject: they can add files but not remove any. Which
    // categories/directories a given uploader may actually write into is enforced by
    // the app (same trade-off already accepted for read-side custom:categories
    // filtering), not by IAM — deliberately not a per-directory IAM policy, since
    // directories are admin-managed at runtime and don't map to a static policy.
    const uploaderRole = new iam.Role(this, 'UploaderRole', {
      roleName: `S3PlayerUploaderRole-${envName}`,
      assumedBy: federatedPrincipal('authenticated'),
    });
    uploaderRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [mediaBucket.arnForObjects('*')],
      }),
    );
    uploaderRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        // AbortMultipartUpload is its own IAM action (not covered by PutObject):
        // lets a failed/cancelled large upload clean up its partial parts.
        actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
        resources: [mediaBucket.arnForObjects('media/*')],
      }),
    );

    // Admins group role: full read/write/list on the media bucket (catalog edits, deleting
    // media files), plus invoking the catalog-sync function for a manual resync.
    const adminRole = new iam.Role(this, 'AdminRole', {
      roleName: `S3PlayerAdminRole-${envName}`,
      assumedBy: federatedPrincipal('authenticated'),
    });
    adminRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        // GetObjectTagging: the Library page shows whether each video is
        // browser-playable (the transcode function's s3player-playback tag).
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:GetObjectTagging'],
        resources: [mediaBucket.arnForObjects('*')],
      }),
    );
    adminRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListBucket'],
        resources: [mediaBucket.bucketArn],
      }),
    );
    catalogSyncFunction.grantInvoke(adminRole);

    // ---------------------------------------------------------------------
    // User management for Admin › Users (lambda/user-admin): admins invite
    // viewers/uploaders and edit their access. The function, not the
    // browser, holds the Cognito permissions and enforces the rules (no
    // admin accounts created or changed from the app).
    // ---------------------------------------------------------------------
    const userAdminFunction = new lambdaNodejs.NodejsFunction(this, 'UserAdminFunction', {
      functionName: `s3player-user-admin-${envName}`,
      description: 'Admin › Users: invite and manage viewer/uploader accounts.',
      entry: path.join(__dirname, '../lambda/user-admin/index.ts'),
      handler: 'handler',
      depsLockFilePath: path.join(__dirname, '../package-lock.json'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: { USER_POOL_ID: userPool.userPoolId, NODE_OPTIONS: '--enable-source-maps' },
      bundling: { minify: true, sourceMap: true, target: 'node24' },
    });
    userAdminFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:ListUsers',
          'cognito-idp:ListUsersInGroup',
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminAddUserToGroup',
          'cognito-idp:AdminRemoveUserFromGroup',
          'cognito-idp:AdminListGroupsForUser',
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminDeleteUser',
        ],
        resources: [userPool.userPoolArn],
      }),
    );
    userAdminFunction.grantInvoke(adminRole);
    new cdk.CfnOutput(this, 'UserAdminFunctionName', { value: userAdminFunction.functionName });

    // Cognito User Pool groups carry a directly-attached IAM role; combined with the
    // Identity Pool's "Token" role-mapping type below, Cognito automatically federates
    // a signed-in user to their group's role with no custom Lambda/rules needed.
    const adminsGroup = new cognito.CfnUserPoolGroup(this, 'AdminsGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'Admins',
      roleArn: adminRole.roleArn,
      precedence: 0,
    });

    const uploadersGroup = new cognito.CfnUserPoolGroup(this, 'UploadersGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'Uploaders',
      roleArn: uploaderRole.roleArn,
      precedence: 5,
    });

    const usersGroup = new cognito.CfnUserPoolGroup(this, 'UsersGroup', {
      userPoolId: userPool.userPoolId,
      groupName: 'Users',
      roleArn: userRole.roleArn,
      precedence: 10,
    });

    const identityProviderName = `cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}:${userPoolClient.userPoolClientId}`;

    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: identityPool.ref,
      roles: {
        // Fallback role for an authenticated user who (unexpectedly) belongs to no group.
        authenticated: userRole.roleArn,
      },
      roleMappings: {
        userPool: {
          type: 'Token',
          ambiguousRoleResolution: 'AuthenticatedRole',
          identityProvider: identityProviderName,
        },
      },
    });

    // Ensure groups exist before the role attachment references role ARNs derived from them.
    new cdk.CfnOutput(this, 'AdminsGroupName', { value: adminsGroup.groupName! });
    new cdk.CfnOutput(this, 'UploadersGroupName', { value: uploadersGroup.groupName! });
    new cdk.CfnOutput(this, 'UsersGroupName', { value: usersGroup.groupName! });

    // ---------------------------------------------------------------------
    // Outputs — copy these into app/src/environments/environment*.ts
    // ---------------------------------------------------------------------

    new cdk.CfnOutput(this, 'Region', { value: this.region });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'IdentityPoolId', { value: identityPool.ref });
    new cdk.CfnOutput(this, 'MediaBucketName', { value: mediaBucket.bucketName });
    new cdk.CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
    new cdk.CfnOutput(this, 'SiteDistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'CatalogSyncFunctionName', { value: catalogSyncFunction.functionName });
    new cdk.CfnOutput(this, 'SiteUrl', { value: customDomain ? `https://${customDomain}` : siteOrigins[0] });
  }
}
