import { join, relative, sep } from "node:path";
import { parseDotDvc, serializeDotDvc, setRemote } from "../domain/dotDvcFile.js";
import { folderToSuffix, isKnownFolder } from "../domain/providerMap.js";

export interface RepointDeps {
  listDvcFiles: (repoDir: string, subdir: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
}

export interface RepointOptions {
  dryRun?: boolean;
  provider?: string;
  allowUnknownDirs?: boolean;
}

export interface RepointEntry {
  path: string;
  status: "repointed" | "already" | "error";
  remote?: string;
  error?: string;
}

// Sets `remote: <provider stub>` on each .dvc out, named after the bucket migrate routed
// its folder to. The hash format is left alone: DVC 3 only reads v2 (no `hash:`) outs
// from the legacy key layout that migrate copies verbatim.
export async function repointAll(
  deps: RepointDeps,
  repoDir: string,
  subdir: string,
  opts: RepointOptions = {},
): Promise<RepointEntry[]> {
  const root = join(repoDir, subdir);
  const entries: RepointEntry[] = [];

  for (const path of await deps.listDvcFiles(repoDir, subdir)) {
    const folder = relative(root, path).split(sep)[0] ?? "";
    const remote = folderToSuffix(folder);
    if (opts.provider !== undefined && remote !== opts.provider) continue;
    try {
      if (!isKnownFolder(folder) && opts.allowUnknownDirs !== true) {
        throw new Error(
          `folder "${folder}" is absent from the provider map; pass --allow-unknown-dirs to point it at public`,
        );
      }
      const file = parseDotDvc(await deps.readFile(path));
      if (file.remote === remote) {
        entries.push({ path, status: "already", remote });
        continue;
      }
      if (opts.dryRun !== true)
        await deps.writeFile(path, serializeDotDvc(setRemote(file, remote)));
      entries.push({ path, status: "repointed", remote });
    } catch (err) {
      entries.push({ path, status: "error", error: (err as Error).message });
    }
  }
  return entries;
}
