import {
  DEFAULT_DRY_RUN,
  type ProductionGuardOptions,
  ensureNotProduction,
} from "../config/guards.js";
import type { MissingEntry } from "../domain/diff.js";
import type { ObjectStore } from "../ports/objectStore.js";
import type { VerifyReport } from "./verify.js";

export class VerificationGapError extends Error {
  constructor(public readonly report: { missing: MissingEntry[] }) {
    super(
      `Refusing to delete: ${report.missing.length} object(s) missing from NEW — migration not verified. No objects were deleted.`,
    );
    this.name = "VerificationGapError";
  }
}

export interface DeleteOptions {
  dryRun?: boolean;
  allowProduction?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface DeleteReport {
  dryRun: boolean;
  deleted: string[];
  targetCount: number;
}

export async function deleteOld(
  store: ObjectStore,
  bucket: string,
  report: VerifyReport,
  opts: DeleteOptions = {},
): Promise<DeleteReport> {
  const dryRun = opts.dryRun ?? DEFAULT_DRY_RUN;

  if (report.missing.length > 0) throw new VerificationGapError(report);

  const guardOpts: ProductionGuardOptions = {};
  if (opts.allowProduction !== undefined) guardOpts.allowProduction = opts.allowProduction;
  if (opts.env !== undefined) guardOpts.env = opts.env;
  ensureNotProduction(bucket, guardOpts);

  const targets = report.matched;

  if (dryRun) return { dryRun: true, deleted: [], targetCount: targets.length };

  await store.deleteBatch(bucket, targets);
  return { dryRun: false, deleted: targets, targetCount: targets.length };
}
