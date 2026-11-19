import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  type ProviderMap,
  UNMATCHED_SUFFIX,
  createProviderMap,
  normalizeFolder,
} from "../domain/providerMap.js";

export interface MigrationConfig extends ProviderMap {
  providers: readonly string[];

  folders: Readonly<Record<string, string>>;

  ignoredMd5s: ReadonlySet<string>;

  conflictWinners: ReadonlyMap<string, string>;

  isProvider(stub: string): boolean;
}

export interface LoadedConfig {
  config: MigrationConfig;

  path: string;

  sha256: string;
}

export class InvalidConfigError extends Error {
  constructor(problems: readonly string[]) {
    super(`Invalid config: ${problems.join("; ")}`);
    this.name = "InvalidConfigError";
  }
}

const Md5 = z
  .string()
  .regex(/^[0-9a-f]{32}(\.dir)?$/, "md5 must be 32 lowercase hex, optionally .dir");

const ConfigSchema = z
  .object({
    providers: z.array(z.string()).min(1),
    folders: z.record(z.string().min(1), z.string()),
    ignoredMd5s: z.array(z.object({ md5: Md5, note: z.string().min(1) }).strict()),
    conflictWinners: z.array(
      z.object({ md5: Md5, folder: z.string().min(1), note: z.string().min(1) }).strict(),
    ),
  })
  .strict();

type RawConfig = z.infer<typeof ConfigSchema>;

function repeated(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const again = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) again.add(value);
    seen.add(value);
  }
  return [...again];
}

function findProblems(raw: RawConfig): string[] {
  const problems: string[] = [];
  const providers = new Set(raw.providers);
  const knownFolders = new Set(Object.keys(raw.folders).map(normalizeFolder));
  const ignored = raw.ignoredMd5s.map((entry) => entry.md5);
  const winners = raw.conflictWinners.map((entry) => entry.md5);

  for (const provider of raw.providers) {
    if (!/^[a-z0-9]+$/.test(provider)) {
      problems.push(`provider "${provider}" must be lowercase letters and digits`);
    }
  }
  for (const provider of repeated(raw.providers)) {
    problems.push(`provider "${provider}" is listed twice`);
  }
  if (!providers.has(UNMATCHED_SUFFIX)) {
    problems.push(`providers must include "${UNMATCHED_SUFFIX}"`);
  }
  for (const [folder, provider] of Object.entries(raw.folders)) {
    if (!providers.has(provider)) {
      problems.push(`folder "${folder}" routes to "${provider}", which is not in providers`);
    }
    if (normalizeFolder(folder) === UNMATCHED_SUFFIX && provider !== UNMATCHED_SUFFIX) {
      problems.push(
        `folder "${folder}" must route to "${UNMATCHED_SUFFIX}": unrouted objects fall back to it`,
      );
    }
  }
  for (const folder of repeated(Object.keys(raw.folders).map(normalizeFolder))) {
    problems.push(`folder "${folder}" appears twice once case and surrounding spaces are ignored`);
  }
  for (const md5 of repeated(ignored)) problems.push(`ignoredMd5s lists ${md5} twice`);
  for (const md5 of repeated(winners)) problems.push(`conflictWinners lists ${md5} twice`);
  for (const md5 of winners) {
    if (ignored.includes(md5)) {
      problems.push(`${md5} is in both ignoredMd5s and conflictWinners`);
    }
  }
  for (const winner of raw.conflictWinners) {
    if (!knownFolders.has(normalizeFolder(winner.folder))) {
      problems.push(
        `conflictWinners sends ${winner.md5} to "${winner.folder}", which is not in folders`,
      );
    }
  }
  return problems;
}

export function parseConfig(text: string): MigrationConfig {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new InvalidConfigError([`not valid JSON (${(err as Error).message})`]);
  }

  const parsed = ConfigSchema.safeParse(doc);
  if (!parsed.success) {
    throw new InvalidConfigError(
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "(top level)"}: ${issue.message}`,
      ),
    );
  }

  const raw = parsed.data;
  const problems = findProblems(raw);
  if (problems.length > 0) throw new InvalidConfigError(problems);

  const providers = new Set(raw.providers);
  return {
    ...createProviderMap(raw.folders),
    providers: raw.providers,
    folders: raw.folders,
    ignoredMd5s: new Set(raw.ignoredMd5s.map((entry) => entry.md5)),
    conflictWinners: new Map(raw.conflictWinners.map((entry) => [entry.md5, entry.folder])),
    isProvider: (stub) => providers.has(stub),
  };
}

export async function loadConfigFile(path: string): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`Cannot read --config ${path}: ${(err as Error).message}`);
  }
  let config: MigrationConfig;
  try {
    config = parseConfig(text);
  } catch (err) {
    throw new Error(`--config ${path}: ${(err as Error).message}`);
  }
  return { config, path, sha256: createHash("sha256").update(text).digest("hex") };
}
