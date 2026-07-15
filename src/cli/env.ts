import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../adapters/logger.js";
import { createS3Client } from "../adapters/s3Client.js";
import { S3ObjectStore } from "../adapters/s3ObjectStore.js";
import type { ObjectStore } from "../ports/objectStore.js";
import type { UpgradeAllDeps } from "../services/upgrade.js";
import type { CliDeps } from "./commands.js";

export function parseMaxAttempts(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function storeFromEnv(region: string): ObjectStore {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const maxAttempts = parseMaxAttempts(process.env.S3_MAX_ATTEMPTS);
  const retryMode = process.env.S3_RETRY_MODE;
  const client = createS3Client({
    region,
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(retryMode === "standard" || retryMode === "adaptive" ? { retryMode } : {}),
    ...(endpoint !== undefined
      ? {
          endpoint,
          forcePathStyle: true,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
          },
        }
      : {}),
  });
  return new S3ObjectStore(client, { region });
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function listDvcFiles(repoDir: string, subdir: string): Promise<string[]> {
  const root = join(repoDir, subdir);
  const ents = await readdir(root, { recursive: true, withFileTypes: true });
  return ents
    .filter((e) => e.isFile() && e.name.endsWith(".dvc"))
    .map((e) => join(e.parentPath, e.name));
}

function upgradeFromEnv(): UpgradeAllDeps {
  return {
    listDvcFiles,
    readFile: (p) => readFile(p, "utf8"),
    writeFile: (p, c) => writeFile(p, c),
  };
}

export function defaultDeps(): CliDeps {
  return {
    makeStore: storeFromEnv,
    logger: createLogger(),
    reportDir: process.env.REPORT_DIR ?? "reports",
    now: stamp,
    upgrade: upgradeFromEnv(),
  };
}
