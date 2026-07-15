import { dirname, join } from "node:path";
import {
  assertMd5Preserved,
  parseDotDvc,
  serializeDotDvc,
  setRemote,
  upgradeToV3,
} from "../domain/dotDvcFile.js";
import type { DvcCli } from "../ports/dvcCli.js";

export class DvcStatusNotCleanError extends Error {
  constructor(scope: "local" | "cloud", target: string, payload: unknown) {
    const hint =
      scope === "cloud"
        ? " — the data is not fully present in the remote; run `dvc push` (or `dvc pull` to restore the workspace) before repointing."
        : " — the workspace/cache is out of sync; run `dvc checkout`/`dvc pull` before repointing.";
    super(`DVC status not clean (${scope}) for ${target}: ${JSON.stringify(payload)}${hint}`);
    this.name = "DvcStatusNotCleanError";
  }
}

export class NotVersion3Error extends Error {
  constructor(path: string) {
    super(`Rewritten .dvc at ${path} is not version 3.`);
    this.name = "NotVersion3Error";
  }
}

export interface RepointDeps {
  dvc: Pick<DvcCli, "ensureVersion3" | "status" | "add">;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
}

export interface RepointOptions {
  skipStatusCheck?: boolean;
}

export interface RepointResult {
  md5: string;
  version: 3;
  remote: string;
}

export async function repointDvcFile(
  deps: RepointDeps,
  dvcPath: string,
  remote: string,
  opts: RepointOptions = {},
): Promise<RepointResult> {
  await deps.dvc.ensureVersion3();

  const before = parseDotDvc(await deps.readFile(dvcPath));
  const dataPath = join(dirname(dvcPath), before.path);

  if (opts.skipStatusCheck !== true) {
    const local = await deps.dvc.status(dataPath);
    if (!local.clean) throw new DvcStatusNotCleanError("local", dataPath, local.payload);
    const cloud = await deps.dvc.status(dataPath, { cloud: true });
    if (!cloud.clean) throw new DvcStatusNotCleanError("cloud", dataPath, cloud.payload);
  }

  await deps.unlink(dvcPath);
  await deps.dvc.add(dataPath);

  const after = parseDotDvc(await deps.readFile(dvcPath));
  assertMd5Preserved(before.md5, after.md5);
  if (after.version !== 3) throw new NotVersion3Error(dvcPath);

  const repointed = setRemote(after, remote);
  await deps.writeFile(dvcPath, serializeDotDvc(repointed));

  return { md5: after.md5, version: 3, remote };
}

export interface UpgradeAllDeps {
  listDvcFiles: (repoDir: string, subdir: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
}

export interface UpgradeAllOptions {
  dryRun?: boolean;

  continueOnError?: boolean;

  keepPath?: (path: string) => boolean;
}

export interface UpgradeEntry {
  path: string;
  status: "upgraded" | "already-v3" | "error";

  md5?: string;
  fromVersion?: 2 | 3;

  error?: string;
}

export interface UpgradeAllResult {
  entries: UpgradeEntry[];
  upgraded: number;
  alreadyV3: number;
  errors: number;
}

export async function upgradeAll(
  deps: UpgradeAllDeps,
  repoDir: string,
  subdir: string,
  opts: UpgradeAllOptions = {},
): Promise<UpgradeAllResult> {
  let files = await deps.listDvcFiles(repoDir, subdir);
  if (opts.keepPath !== undefined) files = files.filter(opts.keepPath);
  const entries: UpgradeEntry[] = [];

  for (const path of files) {
    try {
      const before = parseDotDvc(await deps.readFile(path));
      if (before.version === 3) {
        entries.push({ path, status: "already-v3", md5: before.md5, fromVersion: 3 });
      } else {
        if (opts.dryRun !== true) {
          await deps.writeFile(path, serializeDotDvc(upgradeToV3(before)));
        }
        entries.push({ path, status: "upgraded", md5: before.md5, fromVersion: 2 });
      }
    } catch (err) {
      entries.push({ path, status: "error", error: (err as Error).message });
      if (opts.continueOnError !== true) throw err;
    }
  }

  return {
    entries,
    upgraded: entries.filter((e) => e.status === "upgraded").length,
    alreadyV3: entries.filter((e) => e.status === "already-v3").length,
    errors: entries.filter((e) => e.status === "error").length,
  };
}
