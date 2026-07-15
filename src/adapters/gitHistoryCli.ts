import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pLimit from "p-limit";
import { parse as yamlParse } from "yaml";
import type { GitDvcEntry, GitHistory } from "../ports/gitHistory.js";

const exec = promisify(execFile);

async function git(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repoDir, "-c", "core.quotePath=false", ...args], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

function nonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function treePaths(text: string): string[] {
  return text.split("\n").filter((s) => s.length > 0);
}

function extractMd5s(yamlText: string): string[] {
  let doc: unknown;
  try {
    doc = yamlParse(yamlText);
  } catch {
    return [];
  }
  if (doc === null || typeof doc !== "object") return [];
  const outs = (doc as { outs?: unknown }).outs;
  if (!Array.isArray(outs)) return [];
  const md5s: string[] = [];
  for (const o of outs) {
    const md5 = (o as { md5?: unknown })?.md5;
    if (typeof md5 === "string") md5s.push(md5);
  }
  return md5s;
}

function isPathAbsentError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /does not exist in|exists on disk, but not in|did not match any file/i.test(msg);
}

function providerFromPath(file: string, subdir: string): string {
  const norm = subdir.endsWith("/") ? subdir : `${subdir}/`;
  const rel = file.startsWith(norm) ? file.slice(norm.length) : file;
  return rel.split("/")[0] ?? "";
}

export class GitHistoryCli implements GitHistory {
  constructor(private readonly concurrency = 16) {}

  async walk(repoDir: string, subdir: string): Promise<GitDvcEntry[]> {
    let revList: string;
    try {
      revList = await git(repoDir, ["rev-list", "--all"]);
    } catch (err) {
      throw new Error(
        `Cannot read git history at ${repoDir}: not a git repository or path does not exist. ` +
          `Pass --git-repo pointing at the code repo's working tree. (${(err as Error).message})`,
      );
    }
    const commits = nonEmptyLines(revList);
    const limit = pLimit(this.concurrency);
    const collected: GitDvcEntry[] = [];

    await Promise.all(
      commits.map((commit) =>
        limit(async () => {
          let treeOut: string;
          try {
            treeOut = await git(repoDir, ["ls-tree", "-r", "--name-only", commit, "--", subdir]);
          } catch (err) {
            if (isPathAbsentError(err)) return;
            throw err;
          }
          const dvcFiles = treePaths(treeOut).filter((f) => f.endsWith(".dvc"));
          for (const file of dvcFiles) {
            let content: string;
            try {
              content = await git(repoDir, ["show", `${commit}:${file}`]);
            } catch (err) {
              if (isPathAbsentError(err)) continue;
              throw err;
            }
            const rootDir = providerFromPath(file, subdir);
            for (const md5 of extractMd5s(content)) {
              collected.push({ md5, rootDir, path: file, commit });
            }
          }
        }),
      ),
    );

    const seen = new Set<string>();
    const entries: GitDvcEntry[] = [];
    for (const e of collected) {
      const key = `${e.md5}|${e.rootDir}|${e.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(e);
    }
    return entries;
  }
}
