import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitHistoryCli } from "../../../src/adapters/gitHistoryCli.js";

const exec = promisify(execFile);

const MD5 = "a0000000000000000000000000000099";

function dvc(md5: string, path: string): string {
  return `outs:\n- md5: ${md5}\n  size: 10\n  path: ${path}\n`;
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repo, ...args]);
  return stdout;
}

describe("GitHistoryCli error handling (does not silently drop on unexpected git failure)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "dvc-giterr-"));
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "Test"]);
    await mkdir(join(repo, "data/dvc/Affinity"), { recursive: true });
    await writeFile(join(repo, "data/dvc/Affinity/x.dvc"), dvc(MD5, "x.csv"));
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "c1"]);
  });

  afterEach(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("rethrows when `git show` fails with a non-'does not exist' error (corrupt/missing blob)", async () => {
    const blob = (await git(repo, ["rev-parse", "HEAD:data/dvc/Affinity/x.dvc"])).trim();
    const objPath = join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    await rm(objPath, { force: true });

    await expect(new GitHistoryCli().walk(repo, "data/dvc")).rejects.toThrow();
  });
});
