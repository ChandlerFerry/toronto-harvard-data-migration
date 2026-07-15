import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ReportKind = "migrate" | "verify" | "delete" | "map" | "upgrade";

export interface ReportRow {
  key: string;
  md5: string;
  action: string;
  destBucket?: string;
  status: string;
}

export interface ReportEnvelope {
  kind: ReportKind;
  createdAt: string;
  summary: Record<string, unknown>;
  rows?: ReportRow[];
}

export interface WrittenReport {
  jsonPath: string;
  csvPath?: string;
}

export function toJson(env: ReportEnvelope): string {
  return `${JSON.stringify(env, null, 2)}\n`;
}

function csvCell(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADERS = ["key", "md5", "action", "destBucket", "status"] as const;

export function rowsToCsv(rows: ReportRow[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push([r.key, r.md5, r.action, r.destBucket, r.status].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export async function writeRunReport(
  dir: string,
  baseName: string,
  env: ReportEnvelope,
): Promise<WrittenReport> {
  try {
    await mkdir(dir, { recursive: true });
    const jsonPath = join(dir, `${baseName}.run-report.json`);
    await writeFile(jsonPath, toJson(env));
    if (env.rows !== undefined) {
      const csvPath = join(dir, `${baseName}.run-report.csv`);
      await writeFile(csvPath, rowsToCsv(env.rows));
      return { jsonPath, csvPath };
    }
    return { jsonPath };
  } catch (err) {
    throw new Error(
      `Failed to write run report to "${dir}": ${(err as Error).message}. Check the directory exists and is writable, or set --report-dir / REPORT_DIR to a writable path.`,
    );
  }
}
