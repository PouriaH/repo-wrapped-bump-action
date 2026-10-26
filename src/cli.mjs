#!/usr/bin/env node
// Entry point used by action.yml:
//
//   node src/cli.mjs detect   -> writes pm / node-version / lockfile to $GITHUB_OUTPUT
//   node src/cli.mjs run      -> the bump (see run.mjs)
//
// Inputs arrive as BUMP_* environment variables (action.yml maps `inputs.*` onto them).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectNodeVersion, detectPackageManager } from "./detect.mjs";
import { execReal } from "./exec.mjs";
import { run, validateInputs } from "./run.mjs";

const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/** A logger that speaks GitHub Actions workflow commands. */
export const actionsLog = {
  info: (m) => console.log(m),
  warn: (m) => console.log(`::warning::${esc(m)}`),
  error: (m) => console.log(`::error::${esc(m)}`),
  group: (n) => console.log(`::group::${esc(n)}`),
  endGroup: () => console.log("::endgroup::"),
  mask: (s) => s && console.log(`::add-mask::${esc(s)}`),
};

const env = process.env;

function readIf(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function detect() {
  const root = path.resolve(env.BUMP_WORKDIR || ".");
  const rootFiles = fs.readdirSync(root);
  let packageJson;
  try {
    packageJson = JSON.parse(readIf(path.join(root, "package.json")) ?? "null") ?? undefined;
  } catch {
    packageJson = undefined;
  }
  const pm = detectPackageManager({ rootFiles, packageJson, yarnrcYml: rootFiles.includes(".yarnrc.yml") });
  const nodeVersion = detectNodeVersion({
    nvmrc: readIf(path.join(root, ".nvmrc")),
    nodeVersionFile: readIf(path.join(root, ".node-version")),
    packageJson,
  });
  const out = { pm: pm.pm, "node-version": nodeVersion, lockfile: pm.lockfile ?? "", "yarn-berry": String(pm.yarnBerry) };
  actionsLog.info(`Detected ${JSON.stringify(out)}`);
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  }
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "detect") return detect();
  if (cmd !== "run") {
    console.error("usage: cli.mjs detect | run");
    process.exitCode = 2;
    return;
  }
  const checked = validateInputs({
    package: env.BUMP_PACKAGE,
    version: env.BUMP_VERSION,
    base: env.BUMP_BASE,
    requestId: env.BUMP_REQUEST_ID,
    verifyCommand: env.BUMP_VERIFY_COMMAND,
    singletons: env.BUMP_SINGLETONS,
    openPrOnFailure: env.BUMP_OPEN_PR_ON_FAILURE,
    hasPrToken: Boolean(env.BUMP_PR_TOKEN),
    registryToken: env.BUMP_REGISTRY_TOKEN,
    dryRun: env.BUMP_DRY_RUN,
    workingDirectory: env.BUMP_WORKDIR,
  });
  if (!checked.ok) {
    for (const e of checked.errors) actionsLog.error(e);
    process.exitCode = 2;
    return;
  }
  const result = await run(checked.input, {
    fs,
    exec: execReal,
    log: actionsLog,
    homedir: os.homedir(),
    tmpdir: env.RUNNER_TEMP || os.tmpdir(),
    summaryFile: env.GITHUB_STEP_SUMMARY,
    outputFile: env.GITHUB_OUTPUT,
    ghToken: env.GH_TOKEN,
  });
  process.exitCode = result.status === "failed" ? 1 : 0;
}

// Run only when executed, not when imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
