import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNTS, SOURCES, bucketForSource } from "../../src/config/sources.js";

const INFRA_DIR = process.env.TRACKER_INFRA_DIR ?? join(process.cwd(), "..", "tracker-infra");
const LIVE = join(INFRA_DIR, "live", "harvard-oi-econ-tracker");
const ACCOUNT_HCL = join(LIVE, "account.hcl");
const TG = (region: string): string => join(LIVE, "dvc-buckets", region, "terragrunt.hcl");
const HAS_INFRA = existsSync(ACCOUNT_HCL) && existsSync(TG("us-east-1"));

if (!HAS_INFRA) {
  console.warn(`[reconcileInfra] ${ACCOUNT_HCL} not found — IaC reconciliation skipped.`);
}

function readMatch(file: string, re: RegExp): string {
  const m = readFileSync(file, "utf8").match(re);
  if (m === null) throw new Error(`pattern ${re} not found in ${file}`);
  return m[1]!;
}

function tfSources(region: string): string[] {
  const block = readFileSync(TG(region), "utf8").match(/data_sources\s*=\s*\[([^\]]*)\]/);
  if (block === null) throw new Error(`data_sources list not found in ${TG(region)}`);
  return [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

const accountId = (): string => readMatch(ACCOUNT_HCL, /account_id\s*=\s*"([^"]+)"/);
const prefix = (region: string): string =>
  readMatch(TG(region), /bucket_name_prefix\s*=\s*"([^"]+)"/);

describe.skipIf(!HAS_INFRA)("IaC reconciliation with tracker-infra (Terragrunt)", () => {
  it("config SOURCES exactly match the per-region data_sources lists", () => {
    expect(new Set(tfSources("us-east-1"))).toEqual(new Set(SOURCES));
    expect(new Set(tfSources("us-east-2"))).toEqual(new Set(SOURCES));
  });

  it("the code's account id matches account.hcl", () => {
    expect(ACCOUNTS.new).toBe(accountId());
  });

  it("bucket names match the account-regional formula <prefix>-<src>-<accountId>-<region>-an", () => {
    const acct = accountId();
    for (const region of ["us-east-1", "us-east-2"] as const) {
      const pfx = prefix(region);
      for (const source of SOURCES) {
        expect(bucketForSource(source, region)).toBe(`${pfx}-${source}-${acct}-${region}-an`);
      }
    }
  });
});
