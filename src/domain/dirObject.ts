import { z } from "zod";
import { isValidMd5 } from "./dvcKey.js";

export interface DirEntry {
  md5: string;
  relpath: string;
}

export class InvalidDirObjectError extends Error {
  constructor(message: string) {
    super(`Invalid .dir object: ${message}`);
    this.name = "InvalidDirObjectError";
  }
}

const DirSchema = z.array(z.object({ md5: z.string(), relpath: z.string() }).passthrough());

export function parseDirObject(content: string | Uint8Array): DirEntry[] {
  const text = typeof content === "string" ? content : new TextDecoder().decode(content);

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new InvalidDirObjectError(`bad JSON (${(err as Error).message})`);
  }

  const parsed = DirSchema.safeParse(doc);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new InvalidDirObjectError(detail);
  }

  if (parsed.data.length === 0) throw new InvalidDirObjectError("empty .dir entries");

  return parsed.data.map((e) => {
    if (!isValidMd5(e.md5)) throw new InvalidDirObjectError(`member md5 not 32-hex: ${e.md5}`);
    return { md5: e.md5, relpath: e.relpath };
  });
}

export function dirMemberMd5s(content: string | Uint8Array): string[] {
  return parseDirObject(content).map((e) => e.md5);
}
