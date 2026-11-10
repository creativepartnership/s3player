# S3Player app (Angular)

The browser app: standalone Angular components, Tailwind CSS + daisyUI,
the AWS SDK for S3/Cognito/Lambda, and sql.js for the catalog.

It needs `src/environments/aws-config.ts`, generated from your deployed
stack by `scripts/configure-app.sh` (or copied from `aws-config.example.ts`
and filled in by hand). Without it the build fails with
"Cannot find module './aws-config'".

```bash
npm ci
npm start        # dev server at http://localhost:4200, against your deployed stack
npx ng build     # production build into dist/app/browser
npm test         # unit tests (Vitest)
```

Publishing a build: `scripts/deploy.sh --app-only` from the repository
root, or see `DEPLOY.md`.

Code that the catalog-sync Lambda also uses (keep it free of Angular
imports): `src/app/core/media/media-scan.ts`, `media-enrichment.ts`,
`metadata-client.ts`, `subtitle-convert.ts`, and `src/app/core/db/schema.ts`,
`catalog-ops.ts`.
