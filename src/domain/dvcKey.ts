export type DvcLayout = "v2" | "v3";

export const V3_PREFIX = "files/md5/";
const DIR_SUFFIX = ".dir";
const MD5_RE = /^[0-9a-f]{32}$/;

export class InvalidHashError extends Error {
  constructor(hash: string) {
    super(`Invalid DVC hash: ${JSON.stringify(hash)} (expected 32 lowercase hex, optionally .dir)`);
    this.name = "InvalidHashError";
  }
}

export class InvalidKeyError extends Error {
  constructor(key: string) {
    super(`Not a valid DVC object key: ${JSON.stringify(key)}`);
    this.name = "InvalidKeyError";
  }
}

export function isValidMd5(value: string): boolean {
  return MD5_RE.test(value);
}

export function isDirHash(hash: string): boolean {
  return hash.endsWith(DIR_SUFFIX) && isValidMd5(hash.slice(0, -DIR_SUFFIX.length));
}

export function isValidHash(hash: string): boolean {
  return isValidMd5(hash) || isDirHash(hash);
}

export function md5ToKey(hash: string, layout: DvcLayout): string {
  if (!isValidHash(hash)) throw new InvalidHashError(hash);
  const dir = isDirHash(hash);
  const base = dir ? hash.slice(0, -DIR_SUFFIX.length) : hash;
  const rel = `${base.slice(0, 2)}/${base.slice(2)}${dir ? DIR_SUFFIX : ""}`;
  return layout === "v3" ? V3_PREFIX + rel : rel;
}

export interface ParsedKey {
  hash: string;
  layout: DvcLayout;
  isDir: boolean;
}

export function parseKey(key: string): ParsedKey {
  let rel = key;
  let layout: DvcLayout = "v2";
  if (key.startsWith(V3_PREFIX)) {
    rel = key.slice(V3_PREFIX.length);
    layout = "v3";
  }

  if (rel.charAt(2) !== "/") throw new InvalidKeyError(key);

  let remainder = rel.slice(3);
  const isDir = remainder.endsWith(DIR_SUFFIX);
  if (isDir) remainder = remainder.slice(0, -DIR_SUFFIX.length);

  const hash = rel.slice(0, 2) + remainder;
  if (!isValidMd5(hash)) throw new InvalidKeyError(key);

  return { hash: isDir ? hash + DIR_SUFFIX : hash, layout, isDir };
}

export function keyToMd5(key: string): string {
  return parseKey(key).hash;
}

export function detectLayout(key: string): DvcLayout {
  return parseKey(key).layout;
}

export function isDirKey(key: string): boolean {
  return parseKey(key).isDir;
}

export function isDvcObjectKey(key: string): boolean {
  try {
    parseKey(key);
    return true;
  } catch {
    return false;
  }
}

export function tryKeyToMd5(key: string): string | null {
  try {
    return parseKey(key).hash;
  } catch {
    return null;
  }
}
