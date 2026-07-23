/**
 * Spec-19 item 19 — dry/duplicate true positive.
 * Two token-identical config assembly blocks ≥15 lines each.
 * Verdict: TRUE — extract a shared config builder.
 *
 * Uses for-loops (significant blocks extracted by isSignificantBlock)
 * with identical bodies to guarantee token-hash match.
 */

interface AppConfig {
  region: string;
  s3Bucket: string;
  dynamoTable: string;
  snsTopic: string;
  logLevel: string;
  retryCount: number;
}

declare const process: { env: Record<string, string> };

export function assembleConfigs(): AppConfig[] {
  const configs: AppConfig[] = [];

  // Block A — config assembly (token-identical to Block B)
  for (let i = 0; i < 1; i++) {
    const pad1 = 1;
    const pad2 = 2;
    const pad3 = 3;
    const pad4 = 4;
    const pad5 = 5;
    const env = process.env.ENV || 'development';
    const region = process.env.AWS_REGION || 'us-east-1';
    const s3Bucket = `${env}-app-data-${region}`;
    const dynamoTable = `${env}-application-state`;
    const snsTopic = `arn:aws:sns:${region}:123456789:${env}-notifications`;
    const logLevel = env === 'production' ? 'info' : 'debug';
    const retryCount = env === 'production' ? 5 : 1;
    configs.push({ region, s3Bucket, dynamoTable, snsTopic, logLevel, retryCount });
  }

  // Block B — token-identical to Block A
  for (let i = 0; i < 1; i++) {
    const pad1 = 1;
    const pad2 = 2;
    const pad3 = 3;
    const pad4 = 4;
    const pad5 = 5;
    const env = process.env.ENV || 'development';
    const region = process.env.AWS_REGION || 'us-east-1';
    const s3Bucket = `${env}-app-data-${region}`;
    const dynamoTable = `${env}-application-state`;
    const snsTopic = `arn:aws:sns:${region}:123456789:${env}-notifications`;
    const logLevel = env === 'production' ? 'info' : 'debug';
    const retryCount = env === 'production' ? 5 : 1;
    configs.push({ region, s3Bucket, dynamoTable, snsTopic, logLevel, retryCount });
  }

  return configs;
}
