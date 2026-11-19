import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHistoryCli } from "../../../src/adapters/gitHistoryCli.js";

const exec = promisify(execFile);

const A = "a0000000000000000000000000000001";
const B = "b0000000000000000000000000000002";
const C = "c0000000000000000000000000000003";
const Z = "f0000000000000000000000000000004";

function dvc(md5: string, path: string): string {
  return `outs:\n- md5: ${md5}\n  size: 10\n  path: ${path}\n`;
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repo, ...args]);
  return stdout.trim();
}

describe("GitHistoryCli restricted to one commit", () => {
  let repo: string;
  let first: string;
  let second: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "dvc-gitcommit-"));
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "Test"]);

    await mkdir(join(repo, "data/dvc/Affinity"), { recursive: true });
    await writeFile(join(repo, "data/dvc/Affinity/a.dvc"), dvc(A, "a.csv"));
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "first"]);
    first = await git(repo, ["rev-parse", "HEAD"]);
    await git(repo, ["tag", "v1"]);

    await git(repo, ["switch", "-q", "-c", "side"]);
    await mkdir(join(repo, "data/dvc/Zearn"), { recursive: true });
    await writeFile(join(repo, "data/dvc/Zearn/z.dvc"), dvc(Z, "z.csv"));
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "side"]);

    await git(repo, ["switch", "-q", "main"]);
    await mkdir(join(repo, "data/dvc/CoinOut"), { recursive: true });
    await writeFile(join(repo, "data/dvc/Affinity/a.dvc"), dvc(B, "a.csv"));
    await writeFile(join(repo, "data/dvc/CoinOut/c.dvc"), dvc(C, "c.csv"));
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "second"]);
    second = await git(repo, ["rev-parse", "HEAD"]);
  });

  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("walks every commit on every ref when no commit is given", async () => {
    const entries = await new GitHistoryCli().walk(repo, "data/dvc");

    expect(new Set(entries.map((e) => e.md5))).toEqual(new Set([A, B, C, Z]));
  });

  it("walks only the given commit's tree: the whole snapshot, nothing from other commits", async () => {
    const entries = await new GitHistoryCli().walk(repo, "data/dvc", second);

    expect(new Set(entries.map((e) => e.md5))).toEqual(new Set([B, C]));
    expect(new Set(entries.map((e) => e.commit))).toEqual(new Set([second]));
  });

  it("includes files the commit did not change", async () => {
    const entries = await new GitHistoryCli().walk(repo, "data/dvc", first);

    expect(entries.map((e) => [e.md5, e.rootDir])).toEqual([[A, "Affinity"]]);
  });

  it("resolves a branch, a tag and a short sha to the full sha", async () => {
    const history = new GitHistoryCli();

    expect(await history.resolveCommit(repo, "main")).toBe(second);
    expect(await history.resolveCommit(repo, "v1")).toBe(first);
    expect(await history.resolveCommit(repo, second.slice(0, 10))).toBe(second);
  });

  it("refuses a name that is not a commit in the repo", async () => {
    const history = new GitHistoryCli();

    await expect(history.resolveCommit(repo, "no-such-branch")).rejects.toThrow(/no-such-branch/);
    await expect(history.resolveCommit(repo, "HEAD:data")).rejects.toThrow(/HEAD:data/);
    await expect(history.resolveCommit(repo, "--all")).rejects.toThrow(/--all/);
  });
});
