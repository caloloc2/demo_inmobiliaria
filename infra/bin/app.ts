import * as cdk from 'aws-cdk-lib';
import { WebStack } from '../lib/web-stack';

const app = new cdk.App();

// CloudFront exige el certificado ACM en us-east-1; todo el stack vive ahí.
new WebStack(app, 'InmueblesWeb', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT ?? '361769584968', region: 'us-east-1' },
  rootDomain: 'calolomino.dev',
  hostedZoneId: 'Z0050203QAQ7L25552NF',
  subdomain: 'inmuebles',
});
