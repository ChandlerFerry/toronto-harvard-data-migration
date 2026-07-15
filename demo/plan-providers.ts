#!/usr/bin/env -S node --import tsx
import { readFileSync, readdirSync } from "node:fs";
import { type Region, SOURCES, bucketName } from "../src/config/sources.js";

// Incremental work-list keyed off provider NAMES (config/sources.ts), not the bucket
// name string: emit each provider present in the OLD monolith (per the latest map
// report's per-bucket counts), private providers first and `public` LAST.
const [reportDir, region] = process.argv.slice(2) as [string, Region];

const latest = readdirSync(reportDir)
  .filter((f) => f.startsWith("map-") && f.endsWith(".run-report.json"))
  .sort()
  .pop();

const present = new Set<string>();
if (latest !== undefined) {
  const summary = JSON.parse(readFileSync(`${reportDir}/${latest}`, "utf8")).summary;
  const buckets: Record<string, number> = summary?.buckets ?? {};
  for (const [bucket, count] of Object.entries(buckets)) if (count > 0) present.add(bucket);
}

const ordered = [...SOURCES.filter((s) => s !== "public"), "public"];
for (const name of ordered) {
  if (present.has(bucketName(name, region))) console.log(name);
}
