import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHistoryCli } from "../../src/adapters/gitHistoryCli.js";

const exec = promisify(execFile);

const A = "a0000000000000000000000000000001";
const B = "b0000000000000000000000000000002";
const C = "c0000000000000000000000000000003";

function dvc(md5: string, path: string): string {
  return `outs:\n- md5: ${md5}\n  size: 10\n  path: ${path}\n`;
}

async function git(repo: string, args: string[]): Promise<void> {
  await exec("git", ["-C", repo, "-c", "core.quotePath=false", ...args]);
}

describe("GitHistoryCli (synthetic real git repo)", () => {
  let repo: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "dvc-githist-"));
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "Test"]);

    await mkdir(join(repo, "data/dvc/Affinity"), { recursive: true });
    await mkdir(join(repo, "data/dvc/Burning Glass"), { recursive: true });
    await writeFile(join(repo, "data/dvc/Affinity/a.dvc"), dvc(A, "a.csv"));
    await writeFile(join(repo, "data/dvc/Burning Glass/b.dvc"), dvc(B, "b.csv"));
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "first"]);

    await mkdir(join(repo, "data/dvc/CointOut"), { recursive: true });
    await writeFile(join(repo, "data/dvc/CointOut/c.dvc"), dvc(C, "c.csv"));
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "second"]);
  });

  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("recovers md5 + provider folder for every .dvc across history", async () => {
    const entries = await new GitHistoryCli().walk(repo, "data/dvc");
    const byMd5 = new Map(entries.map((e) => [e.md5, e.rootDir]));
    expect(byMd5.get(A)).toBe("Affinity");
    expect(byMd5.get(B)).toBe("Burning Glass");
    expect(byMd5.get(C)).toBe("CointOut");
  });
});
