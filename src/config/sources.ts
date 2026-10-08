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

export type Region = "us-east-1" | "us-east-2";

export const BUCKET_PREFIX = "dvc";

export const ACCOUNT_REGIONAL_MARKER = "an";

export function bucketName(stub: string, region: Region): string {
  return `${BUCKET_PREFIX}-${stub}-${ACCOUNTS.new}-${region}-${ACCOUNT_REGIONAL_MARKER}`;
}

export function isSource(value: string): value is Source {
  return (SOURCES as readonly string[]).includes(value);
}
