import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHistoryCli } from "../../../src/adapters/gitHistoryCli.js";

const exec = promisify(execFile);

const ACCENTED = "a0000000000000000000000000000099";

function dvc(md5: string, path: string): string {
  return `outs:\n- md5: ${md5}\n  size: 10\n  path: ${path}\n`;
}

async function git(repo: string, args: string[]): Promise<void> {
  await exec("git", ["-C", repo, ...args]);
}

describe("GitHistoryCli with a non-ASCII provider folder", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "dvc-quotepath-"));
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "Test"]);
    await mkdir(join(repo, "data/dvc/café"), { recursive: true });
    await writeFile(join(repo, "data/dvc/café/x.dvc"), dvc(ACCENTED, "x.csv"));
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "accented provider"]);
  });

  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("recovers the md5 from a .dvc inside a non-ASCII folder", async () => {
    const entries = await new GitHistoryCli().walk(repo, "data/dvc");
    const byMd5 = new Map(entries.map((e) => [e.md5, e.rootDir]));
    expect(byMd5.has(ACCENTED)).toBe(true);
    expect(byMd5.get(ACCENTED)).toBe("café");
  });
});
