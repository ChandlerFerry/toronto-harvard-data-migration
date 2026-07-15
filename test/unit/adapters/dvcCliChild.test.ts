import { describe, expect, it } from "vitest";
import {
  DvcCliChild,
  type ExecRunner,
  UnsupportedDvcVersionError,
} from "../../../src/adapters/dvcCliChild.js";

function recorder(stdoutFor: (args: string[]) => string): {
  calls: string[][];
  run: ExecRunner;
} {
  const calls: string[][] = [];
  const run: ExecRunner = (_file, args) => {
    calls.push(args);
    return Promise.resolve({ stdout: stdoutFor(args), stderr: "" });
  };
  return { calls, run };
}

describe("DvcCliChild argv + parsing", () => {
  it("version returns trimmed stdout", async () => {
    const { run } = recorder(() => "  3.50.1\n");
    expect(await new DvcCliChild({ run }).version()).toBe("3.50.1");
  });

  it("ensureVersion3 passes for v3+", async () => {
    const { run } = recorder(() => "3.50.1");
    await expect(new DvcCliChild({ run }).ensureVersion3()).resolves.toBeUndefined();
  });

  it("ensureVersion3 throws for v2", async () => {
    const { run } = recorder(() => "2.58.2");
    await expect(new DvcCliChild({ run }).ensureVersion3()).rejects.toBeInstanceOf(
      UnsupportedDvcVersionError,
    );
  });

  it("status builds exact argv and detects a clean payload", async () => {
    const { calls, run } = recorder(() => "{}");
    const res = await new DvcCliChild({ run }).status("data.csv", { cloud: true });
    expect(calls[0]).toEqual(["status", "--json", "--cloud", "data.csv"]);
    expect(res.clean).toBe(true);
  });

  it("status without cloud omits the flag and detects a dirty payload", async () => {
    const { calls, run } = recorder(() => '{"data.csv": "modified"}');
    const res = await new DvcCliChild({ run }).status("data.csv");
    expect(calls[0]).toEqual(["status", "--json", "data.csv"]);
    expect(res.clean).toBe(false);
  });

  it("add builds exact argv", async () => {
    const { calls, run } = recorder(() => "");
    await new DvcCliChild({ run }).add("data/x.csv");
    expect(calls[0]).toEqual(["add", "data/x.csv"]);
  });

  it("push builds argv with jobs + remote", async () => {
    const { calls, run } = recorder(() => "");
    await new DvcCliChild({ run }).push({ jobs: 8, remote: "ohio-coinout" });
    expect(calls[0]).toEqual(["push", "--jobs", "8", "--remote", "ohio-coinout"]);
  });

  it("push with no options is just push", async () => {
    const { calls, run } = recorder(() => "");
    await new DvcCliChild({ run }).push();
    expect(calls[0]).toEqual(["push"]);
  });
});
