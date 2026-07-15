import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHistoryCli } from "../../../src/adapters/gitHistoryCli.js";

const exec = promisify(execFile);

const MD5 = "a0000000000000000000000000000099";
const SUBDIR = " data";

function dvc(md5: string, path: string): string {
  return `outs:\n- md5: ${md5}\n  size: 10\n  path: ${path}\n`;
}

async function git(repo: string, args: string[]): Promise<void> {
  await exec("git", ["-C", repo, ...args]);
}

describe("GitHistoryCli with a leading-space path component", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "dvc-spacepath-"));
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "Test"]);
    await mkdir(join(repo, SUBDIR, "Affinity"), { recursive: true });
    await writeFile(join(repo, SUBDIR, "Affinity", "x.dvc"), dvc(MD5, "x.csv"));
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "leading-space subtree"]);
  });

  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("recovers the md5 from a .dvc whose path begins with a space", async () => {
    const entries = await new GitHistoryCli().walk(repo, SUBDIR);
    const md5s = new Set(entries.map((e) => e.md5));
    expect(md5s.has(MD5)).toBe(true);
  });
});
