export interface RetryOptions {
  maxRetries?: number;
  isRetryable?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
}

const RETRYABLE_NAMES = new Set([
  "Throttling",
  "ThrottlingException",
  "ThrottledException",
  "RequestThrottledException",
  "SlowDown",
  "RequestTimeout",
  "RequestTimeoutException",
  "RequestTimeTooSkewed",
  "PriorRequestNotComplete",
  "InternalError",
  "InternalServerError",
  "ServiceUnavailable",
  "ServiceException",
  "BandwidthLimitExceeded",
]);

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
]);

export function isRetryableS3Error(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
    $retryable?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (e.$retryable !== undefined && e.$retryable !== null) return true;
  const status = e.$metadata?.httpStatusCode;
  if (typeof status === "number" && (status === 429 || status >= 500)) return true;
  if (typeof e.name === "string" && RETRYABLE_NAMES.has(e.name)) return true;
  if (typeof e.code === "string" && RETRYABLE_CODES.has(e.code)) return true;
  if (
    typeof e.message === "string" &&
    /socket hang up|timed? ?out|throttl|slow ?down/i.test(e.message)
  ) {
    return true;
  }
  return false;
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const isRetryable = opts.isRetryable ?? isRetryableS3Error;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const base = opts.baseDelayMs ?? 100;
  const cap = opts.maxDelayMs ?? 20_000;
  const random = opts.random ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === maxRetries || !isRetryable(err)) throw err;
      const exp = Math.min(cap, base * 2 ** attempt);

      await sleep(exp / 2 + random() * (exp / 2));
    }
  }
  throw lastErr;
}
