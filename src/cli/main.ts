#!/usr/bin/env node
import { Command } from "commander";
import {
  makeDeleteCommand,
  makeMapCommand,
  makeMigrateCommand,
  makeUpgradeCommand,
  makeVerifyCommand,
} from "./commands.js";
import { defaultDeps } from "./env.js";

const deps = defaultDeps();

// ponytail: named dvcm, not dvc — avoids clashing with the real DVC binary
new Command("dvcm")
  .description("DVC S3 remote migration toolkit")
  .addCommand(makeMigrateCommand(deps).name("migrate"))
  .addCommand(makeVerifyCommand(deps).name("verify"))
  .addCommand(makeDeleteCommand(deps).name("delete"))
  .addCommand(makeMapCommand(deps).name("map"))
  .addCommand(makeUpgradeCommand(deps).name("upgrade"))
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
