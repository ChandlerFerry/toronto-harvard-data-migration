import { S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";

export interface S3ClientOptions {
  region: string;

  endpoint?: string;

  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };

  maxAttempts?: number;

  retryMode?: "standard" | "adaptive";
}

export function createS3Client(opts: S3ClientOptions): S3Client {
  const config: S3ClientConfig = {
    region: opts.region,
    forcePathStyle: opts.forcePathStyle ?? Boolean(opts.endpoint),
    maxAttempts: opts.maxAttempts ?? 10,
    retryMode: opts.retryMode ?? "adaptive",
  };
  if (opts.endpoint !== undefined) config.endpoint = opts.endpoint;
  if (opts.credentials !== undefined) config.credentials = opts.credentials;
  return new S3Client(config);
}
