export const DEFAULT_DRY_RUN = true;

export const PRODUCTION_OVERRIDE_VALUE = "I_UNDERSTAND";
export const PRODUCTION_OVERRIDE_ENV = "DVC_MIGRATION_ALLOW_PRODUCTION";

const PRODUCTION_BUCKET_PATTERNS: readonly RegExp[] = [
  /^oi-economictracker-dvc(?:$|-)/,

  /^dvc(?:$|-)/,
];

export class ProductionGuardError extends Error {
  constructor(bucket: string) {
    super(
      `Refusing destructive operation on "${bucket}": matches a production bucket pattern. ` +
        `To override deliberately, pass --allow-production on the CLI, or set ${PRODUCTION_OVERRIDE_ENV}=${PRODUCTION_OVERRIDE_VALUE}.`,
    );
    this.name = "ProductionGuardError";
  }
}

export function isProductionBucket(bucket: string): boolean {
  return PRODUCTION_BUCKET_PATTERNS.some((re) => re.test(bucket));
}

export interface ProductionGuardOptions {
  allowProduction?: boolean;

  env?: NodeJS.ProcessEnv;
}

export function ensureNotProduction(bucket: string, opts: ProductionGuardOptions = {}): void {
  const env = opts.env ?? process.env;
  const overridden = env[PRODUCTION_OVERRIDE_ENV] === PRODUCTION_OVERRIDE_VALUE;
  if (opts.allowProduction === true || overridden) return;
  if (isProductionBucket(bucket)) throw new ProductionGuardError(bucket);
}
