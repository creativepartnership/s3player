import { awsConfig } from './aws-config';

// Local development (`npm start`) against the same deployed stack: the media
// bucket's CORS config allows http://localhost:4200 by default (LOCAL_DEV_ORIGIN
// in infra/.env).
export const environment = {
  production: false,
  aws: awsConfig,
};
