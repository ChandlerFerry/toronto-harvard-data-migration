#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { storeFromEnv } from "../src/cli/env.js";
import { tryKeyToMd5 } from "../src/domain/dvcKey.js";

const DEFAULT_PROVIDERS = ["Affinity", "CoinOut", "Earnin", "Intuit", "Kronos"];

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1] as string;
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required --${name}`);
}

async function main(): Promise<void> {
  const oldBucket = arg("old", "old-demo");
  const outDir = arg("out", ".demo/git-fixture");
  const region = arg("region", "us-east-2");
  const providers = arg("providers", DEFAULT_PROVIDERS.join(","))
    .split(",")
    .map((p) => p.trim());
  const subdir = arg("subdir", "data/dvc");

  const store = storeFromEnv(region);
  const listed = await store.list(oldBucket);

  const leaves = [
    ...new Set(
      listed
        .map((o) => tryKeyToMd5(o.key))
        .filter((m): m is string => m !== null && !m.endsWith(".dir")),
    ),
  ].sort();
  if (leaves.length === 0) throw new Error(`no leaf DVC objects found in s3://${oldBucket}`);

  const byProvider = new Map<string, string[]>();
  for (const p of providers) byProvider.set(p, []);
  leaves.forEach((md5, i) => {
    const p = providers[i % providers.length] as string;
    (byProvider.get(p) as string[]).push(md5);
  });

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const git = (...a: string[]): void => {
    execFileSync("git", ["-C", outDir, ...a], { stdio: "ignore" });
  };
  git("init", "-q");
  git("config", "user.email", "demo@example.com");
  git("config", "user.name", "DVC Demo");

  let totalOuts = 0;
  let v2Count = 0;
  let i = 0;
  for (const [provider, md5s] of byProvider) {
    if (md5s.length === 0) continue;
    const dir = join(outDir, subdir, provider);
    await mkdir(dir, { recursive: true });
    for (const md5 of md5s) {
      const isV3 = i % 3 === 0;
      if (!isV3) v2Count += 1;
      const out = `outs:\n- md5: ${md5}\n  path: ${md5}.bin${isV3 ? "\n  hash: md5" : ""}\n`;
      await writeFile(join(dir, `${md5}.bin.dvc`), out);
      totalOuts += 1;
      i += 1;
    }
  }
  git("add", "-A");
  git("commit", "-q", "-m", "demo: provider mapping fixture");

  const summary = providers.map((p) => `${p}=${byProvider.get(p)?.length ?? 0}`).join(" ");
  process.stdout.write(
    [
      `git fixture: ${outDir}`,
      `  ${totalOuts} leaf md5s across ${providers.length} providers (${summary})`,
      `  .dvc format: ${v2Count} v2 (upgradable) + ${totalOuts - v2Count} v3 (already current)`,
      "  .dir objects left unreferenced -> route to public",
      "",
    ].join("\n"),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
