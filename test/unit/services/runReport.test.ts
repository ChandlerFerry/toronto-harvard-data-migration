import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ReportEnvelope, rowsToCsv, writeRunReport } from "../../../src/services/runReport.js";

const tmps: string[] = [];
afterEach(async () => {
  for (const d of tmps.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("rowsToCsv", () => {
  it("emits a header and quotes cells containing commas/quotes/newlines", () => {
    const csv = rowsToCsv([
      { key: "ab/cd", md5: "abcd", action: "copy", destBucket: "new", status: "copied" },
      { key: 'we,ird"', md5: "x", action: "copy", status: "skipped" },
    ]);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe("key,md5,action,destBucket,status");
    expect(lines[1]).toBe("ab/cd,abcd,copy,new,copied");
    expect(lines[2]).toBe('"we,ird""",x,copy,,skipped');
  });
});

describe("writeRunReport", () => {
  it("writes JSON and CSV when rows are present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rr-"));
    tmps.push(dir);
    const env: ReportEnvelope = {
      kind: "migrate",
      createdAt: "T",
      summary: { total: 1 },
      rows: [{ key: "k", md5: "m", action: "copy", destBucket: "b", status: "copied" }],
    };
    const out = await writeRunReport(dir, "run", env);
    expect(out.csvPath).toBeDefined();
    const parsed = JSON.parse(await readFile(out.jsonPath, "utf8"));
    expect(parsed.kind).toBe("migrate");
    expect(parsed.summary.total).toBe(1);
    expect((await readFile(out.csvPath!, "utf8")).startsWith("key,md5")).toBe(true);
  });

  it("writes only JSON when there are no rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rr-"));
    tmps.push(dir);
    const out = await writeRunReport(dir, "run", {
      kind: "verify",
      createdAt: "T",
      summary: { ok: true },
    });
    expect(out.csvPath).toBeUndefined();
  });
});
