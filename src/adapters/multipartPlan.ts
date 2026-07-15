export const MAX_PARTS = 10_000;
export const MIN_PART_BYTES = 5 * 1024 * 1024;

export interface CopyPart {
  partNumber: number;
  start: number;

  end: number;
}

export function planCopyParts(size: number, configuredPartSize: number): CopyPart[] {
  const partSize = Math.max(configuredPartSize, Math.ceil(size / MAX_PARTS), MIN_PART_BYTES);
  const parts: CopyPart[] = [];
  let start = 0;
  let partNumber = 1;
  while (start < size) {
    const end = Math.min(start + partSize, size) - 1;
    parts.push({ partNumber, start, end });
    start = end + 1;
    partNumber += 1;
  }
  return parts;
}
