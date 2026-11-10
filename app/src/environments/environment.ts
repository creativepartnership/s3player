import { awsConfig } from './aws-config';

// Production build. The deployment-specific values live in aws-config.ts,
// generated per deployment by scripts/setup.sh (see aws-config.example.ts).
export const environment = {
  production: true,
  aws: awsConfig,
};
