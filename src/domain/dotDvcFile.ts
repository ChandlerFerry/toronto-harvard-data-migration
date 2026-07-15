import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { z } from "zod";

export class InvalidDotDvcError extends Error {
  constructor(message: string) {
    super(`Invalid .dvc file: ${message}`);
    this.name = "InvalidDotDvcError";
  }
}

export class UnsupportedDvcFeatureError extends Error {
  constructor(feature: string) {
    super(
      `Unsupported .dvc feature: ${feature}. This tool migrates only single-out, dependency-free .dvc files; rewrite or split this file (one out per .dvc) before migrating.`,
    );
    this.name = "UnsupportedDvcFeatureError";
  }
}

export class Md5ChangedError extends Error {
  constructor(before: string, after: string) {
    super(`md5 changed during rewrite: ${before} -> ${after}`);
    this.name = "Md5ChangedError";
  }
}

const OutSchema = z
  .object({
    md5: z.string(),
    path: z.string(),
    size: z.number().optional(),
    hash: z.string().optional(),
    nfiles: z.number().optional(),
    remote: z.string().optional(),
  })
  .passthrough();

const RawSchema = z
  .object({
    outs: z.array(OutSchema),
  })
  .passthrough();

export interface DotDvcFile {
  raw: Record<string, unknown>;
  md5: string;
  path: string;
  size?: number;
  version: 2 | 3;
  isDir: boolean;
  nfiles?: number;
  remote?: string;
}

const DIR_SUFFIX = ".dir";

export function parseDotDvc(content: string): DotDvcFile {
  let doc: unknown;
  try {
    doc = yamlParse(content);
  } catch (err) {
    throw new InvalidDotDvcError(`unparseable YAML (${(err as Error).message})`);
  }

  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new InvalidDotDvcError("top-level value is not a mapping");
  }

  const record = doc as Record<string, unknown>;
  for (const feature of ["wdir", "deps", "md5"] as const) {
    if (record[feature] != null) throw new UnsupportedDvcFeatureError(feature);
  }

  const parsed = RawSchema.safeParse(doc);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new InvalidDotDvcError(`missing or malformed outs (${detail})`);
  }

  const outs = parsed.data.outs;
  if (outs.length === 0) throw new InvalidDotDvcError("outs is empty");
  if (outs.length > 1) throw new UnsupportedDvcFeatureError("multiple outs");

  const out = outs[0]!;
  const version: 2 | 3 = out.hash !== undefined ? 3 : 2;
  const isDir = out.md5.endsWith(DIR_SUFFIX) || out.nfiles !== undefined;

  const file: DotDvcFile = {
    raw: record,
    md5: out.md5,
    path: out.path,
    version,
    isDir,
  };
  if (out.size !== undefined) file.size = out.size;
  if (out.nfiles !== undefined) file.nfiles = out.nfiles;
  if (out.remote !== undefined) file.remote = out.remote;
  return file;
}

export function serializeDotDvc(file: DotDvcFile): string {
  return yamlStringify(file.raw, { indentSeq: false });
}

export function upgradeToV3(file: DotDvcFile): DotDvcFile {
  if (file.version === 3) return file;
  const raw = structuredClone(file.raw) as { outs: Array<Record<string, unknown>> };
  raw.outs[0]!.hash = "md5";
  return { ...file, raw: raw as unknown as Record<string, unknown>, version: 3 };
}

export function setRemote(file: DotDvcFile, remote: string): DotDvcFile {
  const raw = structuredClone(file.raw) as { outs: Array<Record<string, unknown>> };
  raw.outs[0]!.remote = remote;
  return { ...file, raw: raw as unknown as Record<string, unknown>, remote };
}

export function assertMd5Preserved(before: string, after: string): void {
  if (before !== after) throw new Md5ChangedError(before, after);
}
