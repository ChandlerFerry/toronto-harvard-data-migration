import { describe, expect, it } from "vitest";
import { InvalidConfigError, parseConfig } from "../../../src/config/configFile.js";

const A = "a0000000000000000000000000000001";
const D = "d0000000000000000000000000000002.dir";

const valid = {
  providers: ["earnin", "lightcast", "public"],
  folders: { Earnin: "earnin", "Burning Glass": "lightcast", JOLTS: "public" },
  ignoredMd5s: [{ md5: D, note: "empty directory listing" }],
  conflictWinners: [{ md5: A, folder: "JOLTS", note: "a.csv, also under Earnin" }],
};

const parse = (overrides: Record<string, unknown> = {}): ReturnType<typeof parseConfig> =>
  parseConfig(JSON.stringify({ ...valid, ...overrides }));

describe("parseConfig", () => {
  it("exposes the providers, folder table, ignore list and winner list", () => {
    const config = parse();

    expect(config.providers).toEqual(["earnin", "lightcast", "public"]);
    expect(config.isProvider("lightcast")).toBe(true);
    expect(config.isProvider("nope")).toBe(false);
    expect(config.folderToSuffix("Burning Glass")).toBe("lightcast");
    expect(config.isKnownFolder("Earnin")).toBe(true);
    expect(config.ignoredMd5s.has(D)).toBe(true);
    expect(config.conflictWinners.get(A)).toBe("JOLTS");
  });

  it("matches folder names without regard to case or surrounding spaces", () => {
    const config = parse();

    expect(config.folderToSuffix("  burning glass ")).toBe("lightcast");
    expect(config.isKnownFolder("EARNIN")).toBe(true);
  });

  it("sends an unknown folder to public without calling it known", () => {
    const config = parse();

    expect(config.folderToSuffix("Mystery")).toBe("public");
    expect(config.isKnownFolder("Mystery")).toBe(false);
    expect(config.generateBucketName("Mystery", "us-east-2")).toBe(
      "dvc-public-305901448049-us-east-2-an",
    );
    expect(config.generateBucketName("Earnin", "us-east-1")).toBe(
      "dvc-earnin-305901448049-us-east-1-an",
    );
  });

  it("accepts empty ignore and winner lists", () => {
    const config = parse({ ignoredMd5s: [], conflictWinners: [] });

    expect(config.ignoredMd5s.size).toBe(0);
    expect(config.conflictWinners.size).toBe(0);
  });
});

describe("parseConfig rejects", () => {
  it("text that is not JSON", () => {
    expect(() => parseConfig("{ providers: ")).toThrow(InvalidConfigError);
  });

  it("a missing key", () => {
    const { conflictWinners: _dropped, ...rest } = valid;
    expect(() => parseConfig(JSON.stringify(rest))).toThrow(/conflictWinners/);
  });

  it("an unknown key, so a misspelt list cannot load as empty", () => {
    expect(() => parse({ conflictWinner: [] })).toThrow(/conflictWinner/);
  });

  it("an entry without a note", () => {
    expect(() => parse({ ignoredMd5s: [{ md5: D }] })).toThrow(/note/);
  });

  it("a badly formed md5", () => {
    expect(() => parse({ ignoredMd5s: [{ md5: "D41D8CD9", note: "short" }] })).toThrow(/md5/);
  });

  it("a provider name that is not lowercase letters and digits", () => {
    expect(() => parse({ providers: ["earnin", "lightcast", "public", "St Louis"] })).toThrow(
      /St Louis/,
    );
  });

  it("a provider list without public", () => {
    expect(() =>
      parse({ providers: ["earnin", "lightcast"], folders: { Earnin: "earnin" } }),
    ).toThrow(/public/);
  });

  it("a folder routed to a provider that is not listed", () => {
    expect(() => parse({ folders: { ...valid.folders, Zearn: "zearn" } })).toThrow(/Zearn.*zearn/);
  });

  it("two folders that differ only by case or surrounding spaces", () => {
    expect(() => parse({ folders: { ...valid.folders, " earnin": "public" } })).toThrow(/earnin/i);
  });

  it("a folder named public that routes anywhere but public, since unrouted objects fall back to it", () => {
    expect(() => parse({ folders: { ...valid.folders, Public: "earnin" } })).toThrow(/Public/);
    expect(() => parse({ folders: { ...valid.folders, public: "public" } })).not.toThrow();
  });

  it("a provider listed twice", () => {
    expect(() => parse({ providers: ["earnin", "earnin", "lightcast", "public"] })).toThrow(
      /earnin/,
    );
  });

  it("an md5 listed twice in one list", () => {
    const twice = [
      { md5: D, note: "one" },
      { md5: D, note: "two" },
    ];
    expect(() => parse({ ignoredMd5s: twice })).toThrow(new RegExp(D));
  });

  it("an md5 on both the ignore list and the winner list", () => {
    const winners = [{ md5: D, folder: "JOLTS", note: "also ignored" }];
    expect(() => parse({ conflictWinners: winners })).toThrow(new RegExp(D));
  });

  it("a winner that names a folder missing from the folder table", () => {
    const winners = [{ md5: A, folder: "CPS", note: "not in the table" }];
    expect(() => parse({ conflictWinners: winners })).toThrow(/CPS/);
  });

  it("every problem in one message", () => {
    const run = (): unknown =>
      parse({
        folders: { ...valid.folders, Zearn: "zearn" },
        conflictWinners: [{ md5: A, folder: "CPS", note: "not in the table" }],
      });
    expect(run).toThrow(/Zearn/);
    expect(run).toThrow(/CPS/);
  });
});
