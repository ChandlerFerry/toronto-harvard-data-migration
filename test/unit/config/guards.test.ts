import { describe, expect, it } from "vitest";
import {
  DEFAULT_DRY_RUN,
  PRODUCTION_OVERRIDE_ENV,
  PRODUCTION_OVERRIDE_VALUE,
  ProductionGuardError,
  ensureNotProduction,
  isProductionBucket,
} from "../../../src/config/guards.js";

describe("config/guards", () => {
  it("dry-run is the default", () => {
    expect(DEFAULT_DRY_RUN).toBe(true);
  });

  it.each(["oi-economictracker-dvc", "dvc-coinout", "dvc-public-305901448049-us-east-2-an"])(
    "flags %s as production",
    (bucket) => {
      expect(isProductionBucket(bucket)).toBe(true);
    },
  );

  it.each([
    "oi-economictracker-dvc-prod",
    "oi-economictracker-dvc-replica",
    "oi-economictracker-dvc-us-east-2",
  ])(
    "flags suffixed legacy bucket variant %s as production (the real legacy name is UNCONFIRMED)",
    (bucket) => {
      expect(isProductionBucket(bucket)).toBe(true);
    },
  );

  it.each(["dvc"])(
    "flags the bare destination-prefix %s as production (defense-in-depth, matches the legacy boundary)",
    (bucket) => {
      expect(isProductionBucket(bucket)).toBe(true);
    },
  );

  it.each(["old-dvc-remote", "test-old", "localstack-seed", "oi-example-dvc-s3-remote"])(
    "does not flag %s as production",
    (bucket) => {
      expect(isProductionBucket(bucket)).toBe(false);
    },
  );

  it("throws ProductionGuardError on a production bucket without override", () => {
    expect(() => ensureNotProduction("dvc-coinout", { env: {} })).toThrow(ProductionGuardError);
  });

  it("passes for a non-production bucket", () => {
    expect(() => ensureNotProduction("old-dvc-remote", { env: {} })).not.toThrow();
  });

  it("respects the explicit in-code allowProduction flag", () => {
    expect(() =>
      ensureNotProduction("oi-economictracker-dvc", { allowProduction: true, env: {} }),
    ).not.toThrow();
  });

  it("respects the deliberate env override", () => {
    expect(() =>
      ensureNotProduction("oi-economictracker-dvc", {
        env: { [PRODUCTION_OVERRIDE_ENV]: PRODUCTION_OVERRIDE_VALUE },
      }),
    ).not.toThrow();
  });

  it("ignores a wrong override value", () => {
    expect(() =>
      ensureNotProduction("oi-economictracker-dvc", {
        env: { [PRODUCTION_OVERRIDE_ENV]: "yes" },
      }),
    ).toThrow(ProductionGuardError);
  });
});
