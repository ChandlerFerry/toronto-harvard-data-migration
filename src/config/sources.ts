export const SOURCES = [
  "affinity",
  "coinout",
  "earnin",
  "homebase",
  "intuit",
  "kronos",
  "lightcast",
  "paychex",
  "public",
  "womply",
  "zearn",
] as const;

export type Source = (typeof SOURCES)[number];

export const ACCOUNTS = {
  old: "290048929476",

  new: "305901448049",
} as const;

export const REGIONS = {
  permanent: "us-east-1",
  ohio: "us-east-2",
} as const;

export type Region = (typeof REGIONS)[keyof typeof REGIONS];

export const BUCKET_PREFIX = "dvc";

export const ACCOUNT_REGIONAL_MARKER = "an";

export function bucketName(stub: string, region: Region): string {
  return `${BUCKET_PREFIX}-${stub}-${ACCOUNTS.new}-${region}-${ACCOUNT_REGIONAL_MARKER}`;
}

export function isSource(value: string): value is Source {
  return (SOURCES as readonly string[]).includes(value);
}

export function bucketForSource(source: Source, region: Region): string {
  return bucketName(source, region);
}

export const LEGACY_SOURCE_BUCKET_DEFAULT = "oi-economictracker-dvc";

export const SANDBOX_BUCKET = "oi-example-dvc-s3-remote";
