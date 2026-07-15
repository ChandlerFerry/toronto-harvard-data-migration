import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DvcCli, DvcPushOptions, DvcStatusResult } from "../ports/dvcCli.js";

const execFileAsync = promisify(execFile);

export type ExecRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export class UnsupportedDvcVersionError extends Error {
  constructor(version: string) {
    super(`Unsupported DVC version ${JSON.stringify(version)}; need v3 or higher.`);
    this.name = "UnsupportedDvcVersionError";
  }
}

function isCleanPayload(payload: unknown): boolean {
  if (payload === null || payload === undefined) return true;
  if (Array.isArray(payload)) return payload.length === 0;
  if (typeof payload === "object") return Object.keys(payload).length === 0;
  return false;
}

function parseMajor(versionOutput: string): number | null {
  const m = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? Number(m[1]) : null;
}

export function dvcNotFoundError(err: unknown): Error | null {
  if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
    return new Error(
      "DVC CLI not found: could not run 'dvc'. Install DVC v3+ and ensure it is on your PATH (dvc --version). https://dvc.org/doc/install",
    );
  }
  return null;
}

export class DvcCliChild implements DvcCli {
  private readonly run: ExecRunner;

  constructor(opts: { cwd?: string; run?: ExecRunner } = {}) {
    this.run =
      opts.run ??
      (async (file, args) => {
        try {
          return await execFileAsync(file, args, {
            maxBuffer: 64 * 1024 * 1024,
            ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          });
        } catch (err) {
          const notFound = dvcNotFoundError(err);
          if (notFound) throw notFound;
          throw err;
        }
      });
  }

  async version(): Promise<string> {
    const { stdout } = await this.run("dvc", ["--version"]);
    return stdout.trim();
  }

  async ensureVersion3(): Promise<void> {
    const raw = await this.version();
    const major = parseMajor(raw);
    if (major === null || major < 3) throw new UnsupportedDvcVersionError(raw);
  }

  async status(target: string, opts: { cloud?: boolean } = {}): Promise<DvcStatusResult> {
    const args = ["status", "--json"];
    if (opts.cloud === true) args.push("--cloud");
    args.push(target);
    const { stdout } = await this.run("dvc", args);
    const payload: unknown = JSON.parse((stdout || "{}").trim() || "{}");
    return { clean: isCleanPayload(payload), payload };
  }

  async add(target: string): Promise<void> {
    await this.run("dvc", ["add", target]);
  }

  async push(opts: DvcPushOptions = {}): Promise<void> {
    const args = ["push"];
    if (opts.jobs !== undefined) args.push("--jobs", String(opts.jobs));
    if (opts.remote !== undefined) args.push("--remote", opts.remote);
    await this.run("dvc", args);
  }
}
