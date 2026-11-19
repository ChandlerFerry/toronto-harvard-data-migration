import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type MigrationConfig, parseConfig } from "../../src/config/configFile.js";

export const RETINA_CONFIG_PATH = join(process.cwd(), "config", "retina-routing.json");

export interface ConfigOverrides {
  providers?: string[];
  folders?: Record<string, string>;
  ignoredMd5s?: { md5: string; note: string }[];
  conflictWinners?: { md5: string; folder: string; note: string }[];
}

export function retinaConfigText(overrides: ConfigOverrides = {}): string {
  const committed = JSON.parse(readFileSync(RETINA_CONFIG_PATH, "utf8"));
  return JSON.stringify({ ...committed, ...overrides });
}

export function retinaConfig(overrides: ConfigOverrides = {}): MigrationConfig {
  return parseConfig(retinaConfigText(overrides));
}
