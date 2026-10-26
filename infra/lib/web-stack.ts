import * as path from 'node:path';
import { Duration, RemovalPolicy, Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';

export interface WebStackProps extends StackProps {
  rootDomain: string;
  hostedZoneId: string;
  subdomain: string;
}

export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const domain = `${props.subdomain}.${props.rootDomain}`;
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.rootDomain,
    });

    const certificate = new acm.Certificate(this, 'Cert', {
      domainName: domain,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Service Worker y manifest nunca deben quedar cacheados, o las actualizaciones no llegan.
    const noCache = cloudfront.CachePolicy.CACHING_DISABLED;
    const bucketOrigin = origins.S3BucketOrigin.withOriginAccessControl(bucket);
    // S3 + OAC no resuelve directorios: /app/ -> /app/index.html.
    const indexRewrite = new cloudfront.Function(this, 'IndexRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`function handler(event) {
  var r = event.request;
  if (r.uri.endsWith('/')) r.uri += 'index.html';
  else if (r.uri === '/app') return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: '/app/' } } };
  return r;
}`),
    });
    const common = {
      functionAssociations: [{ function: indexRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      origin: bucketOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      compress: true,
    };

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'Headers', {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          { header: 'Permissions-Policy', value: 'geolocation=(self), notifications=(self)', override: true },
        ],
      },
    });

    // --- Push: suscripciones + claves VAPID + avisos recientes (con TTL) ---
    const table = new dynamodb.Table(this, 'PushTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const api = new nodejs.NodejsFunction(this, 'ApiFn', {
      entry: path.join(__dirname, '../lambda/handler.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(15),
      environment: { TABLE_NAME: table.tableName },
      logGroup: new logs.LogGroup(this, 'ApiLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      bundling: { minify: true, target: 'node22', externalModules: [] },
    });
    table.grantReadWriteData(api);
    const apiUrl = api.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
    // Desde 2025 las URL públicas también exigen lambda:InvokeFunction.
    api.addPermission('PublicInvokeViaUrl', {
      principal: new iam.AnyPrincipal(),
      action: 'lambda:InvokeFunction',
      invokedViaFunctionUrl: true,
    });

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      domainNames: [domain],
      certificate,
      defaultRootObject: 'index.html',
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        ...common,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
      },
      additionalBehaviors: {
        '/sw.js': { ...common, cachePolicy: noCache, responseHeadersPolicy: securityHeaders },
        '/manifest.webmanifest': { ...common, cachePolicy: noCache, responseHeadersPolicy: securityHeaders },
        '/workbox-*.js': { ...common, cachePolicy: noCache, responseHeadersPolicy: securityHeaders },
        '/app/index.html': { ...common, cachePolicy: noCache, responseHeadersPolicy: securityHeaders },
        // Misma origin que la web: sin CORS ni URL fija en el cliente.
        '/api/*': {
          origin: new origins.FunctionUrlOrigin(apiUrl),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: noCache,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        '/index.html': { ...common, cachePolicy: noCache, responseHeadersPolicy: securityHeaders },
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(10) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(10) },
      ],
    });

    const dist = path.join(__dirname, '../../web/dist');
    // Assets con hash: cache largo e inmutable.
    new s3deploy.BucketDeployment(this, 'DeployAssets', {
      sources: [s3deploy.Source.asset(dist)],
      include: ['assets/*'],
      exclude: ['*'],
      destinationBucket: bucket,
      prune: false,
      cacheControl: [s3deploy.CacheControl.fromString('public,max-age=31536000,immutable')],
    });
    // Resto (html, sw, manifest, iconos): siempre revalidar. Invalida el CDN al terminar.
    new s3deploy.BucketDeployment(this, 'DeployRest', {
      sources: [s3deploy.Source.asset(dist)],
      exclude: ['assets/*'],
      destinationBucket: bucket,
      prune: false,
      distribution,
      distributionPaths: ['/*'],
      cacheControl: [s3deploy.CacheControl.fromString('public,max-age=0,must-revalidate')],
    });

    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
    new route53.ARecord(this, 'Alias', { zone, recordName: props.subdomain, target });
    new route53.AaaaRecord(this, 'AliasV6', { zone, recordName: props.subdomain, target });

    new CfnOutput(this, 'Url', { value: `https://${domain}` });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
  }
}
