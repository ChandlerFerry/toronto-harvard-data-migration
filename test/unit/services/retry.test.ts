import { describe, expect, it } from "vitest";
import { isRetryableS3Error, withRetry } from "../../../src/services/retry.js";

const noWait = { sleep: () => Promise.resolve(), random: () => 0, baseDelayMs: 1 };

describe("isRetryableS3Error", () => {
  it.each([
    { name: "SlowDown" },
    { name: "ThrottlingException" },
    { name: "RequestTimeout" },
    { $metadata: { httpStatusCode: 503 } },
    { $metadata: { httpStatusCode: 500 } },
    { $metadata: { httpStatusCode: 429 } },
    { code: "ECONNRESET" },
    { code: "ETIMEDOUT" },
    { $retryable: { throttling: true } },
    { message: "socket hang up" },
  ])("classifies %o as retryable", (err) => {
    expect(isRetryableS3Error(err)).toBe(true);
  });

  it.each([
    { name: "AccessDenied" },
    { name: "NoSuchKey" },
    { $metadata: { httpStatusCode: 404 } },
    { $metadata: { httpStatusCode: 403 } },
    null,
    "a string",
  ])("classifies %o as non-retryable", (err) => {
    expect(isRetryableS3Error(err)).toBe(false);
  });
});

describe("withRetry", () => {
  it("retries a retryable failure then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(() => {
      calls += 1;
      if (calls < 3) return Promise.reject({ name: "SlowDown" });
      return Promise.resolve("ok");
    }, noWait);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("does not retry a non-retryable error", async () => {
    let calls = 0;
    await expect(
      withRetry(() => {
        calls += 1;
        return Promise.reject({ name: "AccessDenied" });
      }, noWait),
    ).rejects.toMatchObject({ name: "AccessDenied" });
    expect(calls).toBe(1);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject({ name: "SlowDown" });
        },
        { ...noWait, maxRetries: 2 },
      ),
    ).rejects.toMatchObject({ name: "SlowDown" });
    expect(calls).toBe(3);
  });

  it("passes the attempt number to the operation", async () => {
    const seen: number[] = [];
    await withRetry((attempt) => {
      seen.push(attempt);
      return seen.length < 2 ? Promise.reject({ name: "SlowDown" }) : Promise.resolve(0);
    }, noWait);
    expect(seen).toEqual([0, 1]);
  });
});
