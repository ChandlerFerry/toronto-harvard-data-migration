import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import pLimit from "p-limit";
import { isDvcObjectKey } from "../../src/domain/dvcKey.js";
import type { ObjectStore } from "../../src/ports/objectStore.js";

export const SANDBOX_DIR =
  process.env.SANDBOX_DIR ?? "/home/deafwave/toronto/oi-example-dvc-s3-remote";

export interface SandboxEntry {
  key: string;
  absPath: string;
  size: number;
}

export interface CollectOptions {
  limit?: number;

  maxBytes?: number;
}

export async function collectSandboxEntries(opts: CollectOptions = {}): Promise<SandboxEntry[]> {
  const dirents = await readdir(SANDBOX_DIR, { recursive: true, withFileTypes: true });
  const entries: SandboxEntry[] = [];
  for (const d of dirents) {
    if (!d.isFile()) continue;
    const absPath = join(d.parentPath, d.name);
    const key = relative(SANDBOX_DIR, absPath).split(sep).join("/");
    if (!isDvcObjectKey(key)) continue;
    const s = await stat(absPath);
    if (opts.maxBytes !== undefined && s.size > opts.maxBytes) continue;
    entries.push({ key, absPath, size: s.size });
  }
  entries.sort((a, b) => a.size - b.size || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return opts.limit !== undefined ? entries.slice(0, opts.limit) : entries;
}

export async function seedSandbox(
  store: ObjectStore,
  bucket: string,
  entries: SandboxEntry[],
  concurrency = 32,
): Promise<void> {
  await store.ensureBucket(bucket);
  const limit = pLimit(concurrency);
  await Promise.all(
    entries.map((e) =>
      limit(async () => {
        const body = await readFile(e.absPath);
        await store.put(bucket, e.key, new Uint8Array(body));
      }),
    ),
  );
}
