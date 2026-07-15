import { type Region, bucketName } from "../config/sources.js";

export const PROVIDER_FOLDER_SUFFIX: Readonly<Record<string, string>> = {
  "ACS 2014-2018 5-Year County": "public",
  "ACS 2014-2018 5-Year ZCTA": "public",
  Affinity: "affinity",
  "American Time Use Survey": "public",
  "Burning Glass": "lightcast",
  "COVID-19": "public",
  CPI: "public",
  "City Crosswalk": "public",
  CoinOut: "coinout",
  "County Population": "public",
  "County covariates Atlas": "public",
  "County to CZ Crosswalk - 1990 Vintage": "public",
  Earnin: "earnin",
  FPL: "public",
  "Geo Info": "public",
  "Google Analytics": "public",
  "Google Mobility": "public",
  Holidays: "public",
  Homebase: "homebase",
  Intuit: "intuit",
  JOLTS: "public",
  Kronos: "kronos",
  Lightcast: "lightcast",
  "Local Area Unemployment Statistics": "public",
  MARTS: "public",
  "NAICS Crosswalk": "public",
  NIPA: "public",
  Paychex: "paychex",
  QCEW: "public",
  "Spending MCC to NAICS Crosswalk": "public",
  "Spending Superindustry Crosswalk": "public",
  "State Population": "public",
  "UI Claims": "public",
  Womply: "womply",
  "ZIP to County Crosswalk - Q4 2019 Vintage": "public",
  "ZIP to ZCTA Crosswalk": "public",
  Zearn: "zearn",
};

export const UNMATCHED_SUFFIX = "public";

const NORMALIZED_PROVIDER_SUFFIX: ReadonlyMap<string, string> = new Map(
  Object.entries(PROVIDER_FOLDER_SUFFIX).map(([folder, suffix]) => [
    folder.trim().toLowerCase(),
    suffix,
  ]),
);

export function folderToSuffix(folder: string): string {
  return NORMALIZED_PROVIDER_SUFFIX.get(folder.trim().toLowerCase()) ?? UNMATCHED_SUFFIX;
}

export function isKnownFolder(folder: string): boolean {
  return NORMALIZED_PROVIDER_SUFFIX.has(folder.trim().toLowerCase());
}

export function generateBucketName(folder: string, region: Region): string {
  return bucketName(folderToSuffix(folder), region);
}
