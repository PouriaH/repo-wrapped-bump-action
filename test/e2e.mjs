#!/usr/bin/env node
// End-to-end against a fixture repo, with the REAL package managers and the REAL
// registry — everything except the push and the PR (dry-run).
//
//   node test/e2e.mjs npm
//   node test/e2e.mjs pnpm
//   node test/e2e.mjs yarn
//   node test/e2e.mjs npm-duplicate        # expects the duplicate-copy guard to refuse
//
// `is-odd` stands in for an internal package: 2.x -> 3.0.0 is a real major bump whose
// build (`node build.js`) loads the installed module, so a broken install fails it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execReal } from "../src/exec.mjs";
import { run, validateInputs } from "../src/run.mjs";

const name = process.argv[2];
if (!name) {
  console.error("usage: node test/e2e.mjs <fixture>");
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const expectFailure = name.endsWith("-duplicate");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `bump-e2e-${name}-`));
const repo = path.join(tmp, "repo");
fs.cpSync(path.join(here, "fixtures", name), repo, { recursive: true });

// Yarn may not be installed locally; CI enables it with corepack.
const env = { ...process.env };
if (name === "yarn") {
  const probe = await execReal("yarn", ["--version"], { stream: false });
  if (probe.code !== 0) {
    const shim = path.join(tmp, "shim");
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, "yarn.cmd"), "@echo off\r\nnpx --yes yarn@1.22.22 %*\r\n");
    fs.writeFileSync(path.join(shim, "yarn"), '#!/bin/sh\nexec npx --yes yarn@1.22.22 "$@"\n', { mode: 0o755 });
    process.env.PATH = `${shim}${path.delimiter}${process.env.PATH}`;
    console.log("(yarn not installed: using yarn@1.22.22 through npx)");
  }
}
void env;

const git = (args) => execReal("git", args, { cwd: repo, stream: false });
await git(["init", "-q", "-b", "main"]);
await git(["add", "-A"]);
await git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-q", "-m", "fixture"]);

const checked = validateInputs({
  package: "is-odd",
  version: "3.0.0",
  requestId: "e2e-1",
  singletons: expectFailure ? "is-number" : "",
  dryRun: "true",
  hasPrToken: true,
  workingDirectory: repo,
});
if (!checked.ok) throw new Error(checked.errors.join("; "));

const logs = [];
const result = await run(checked.input, {
  fs,
  exec: execReal,
  log: {
    info: (m) => console.log(m),
    warn: (m) => console.log(`WARN ${m}`),
    error: (m) => console.log(`ERROR ${m}`),
    group: (n) => console.log(`\n::group:: ${n}`),
    endGroup: () => {},
    mask: () => {},
  },
  homedir: path.join(tmp, "home"),
  tmpdir: tmp,
  summaryFile: path.join(tmp, "summary.md"),
  outputFile: path.join(tmp, "output.txt"),
  ghToken: "unused",
});
void logs;

const checks = [];
const check = (label, ok, extra = "") => checks.push({ label, ok, extra });

if (expectFailure) {
  check("the run refuses", result.status === "failed", result.status);
  check("at the duplicate-copy guard", result.failure?.step === "duplicates", result.failure?.step);
  check("naming the duplicated package", /is-number/.test(result.failure?.message ?? ""), result.failure?.message);
  check("without building or committing", !result.branch && !result.verify.ran);
} else {
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  check("the run ends in dry-run", result.status === "dry-run", `${result.status}: ${result.failure?.message ?? ""}`);
  check("the range keeps its caret", pkg.dependencies["is-odd"] === "^3.0.0", pkg.dependencies["is-odd"]);
  const lockName = { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock" }[name];
  const lock = fs.readFileSync(path.join(repo, lockName), "utf8");
  check("the lockfile was refreshed", /is-odd/.test(lock) && /3\.0\.0/.test(lock) && !/is-odd.*2\.0\.0/.test(lock.split("is-number")[0] ?? ""), lockName);
  check("the build ran", result.verify.ran && /run build/.test(result.verify.label), result.verify.label);
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  check("committed to the bump branch", branch === "repo-wrapped/bump-is-odd-3.0.0", branch);
  const subject = (await git(["log", "-1", "--format=%s"])).stdout.trim();
  check("with the conventional message", subject === "chore(deps): bump is-odd to 3.0.0", subject);
  const files = (await git(["show", "--name-only", "--format=", "HEAD"])).stdout.trim().split(/\r?\n/).sort();
  check("touching only the manifest and the lockfile", JSON.stringify(files) === JSON.stringify(["package.json", lockName].sort()), files.join(","));
  const status = (await git(["status", "--porcelain"])).stdout.trim();
  check("leaving no stray files tracked-dirty", !/^ ?M/m.test(status), status);
}

console.log("\n--- e2e:", name, "---");
for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.label}${c.ok ? "" : `  (${c.extra})`}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(checks.every((c) => c.ok) ? 0 : 1);
