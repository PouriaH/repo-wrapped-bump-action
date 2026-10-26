// The bump, end to end. Every side effect goes through `deps` (file system, process
// runner, logger), so the whole flow is unit-tested with fakes and run for real
// against fixture repos in CI.
//
//   rewrite specifiers -> (registry auth) -> install (refresh lockfile) ->
//   duplicate check -> verify (build) -> branch + commit -> push -> open/update PR
//
// A failure stops the run, writes the failing step and the log tail to the job
// summary, and — only if `open-pr-on-failure` is on — opens a DRAFT PR labelled
// `repo-wrapped:bump-failed` so the attempt is visible.

import path from "node:path";
import { detectPackageManager, pmOfLockfile } from "./detect.mjs";
import { findDuplicates, parseLockfile } from "./lockfile.mjs";
import { authNpmrcLines, usesGithubPackages } from "./npmrc.mjs";
import { installDirs, lockfileIn, STAGEABLE_NAMES, walkRepo } from "./plan.mjs";
import {
  LABEL_BUMP,
  LABEL_FAILED,
  branchName,
  commitMessage,
  prBody,
} from "./pr.mjs";
import { rewriteManifest } from "./rewrite.mjs";
import { chooseVerifyCommand, installCommand } from "./verify.mjs";
import { tail } from "./exec.mjs";

export class StepError extends Error {
  constructor(step, message, logTail = "") {
    super(message);
    this.step = step;
    this.logTail = logTail;
  }
}

// --- input validation ---------------------------------------------------------------

const NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Validate the workflow inputs. They arrive from whoever dispatched the workflow, and
 * end up in a branch name, a commit message and a PR — so they are checked, not trusted.
 * @returns {{ ok: true, input: any } | { ok: false, errors: string[] }}
 */
export function validateInputs(raw) {
  const errors = [];
  const pkg = String(raw.package ?? "").trim();
  const version = String(raw.version ?? "").trim().replace(/^v/, "");
  const base = String(raw.base ?? "").trim();
  if (!NAME.test(pkg) || pkg.length > 214) errors.push(`"package" is not a valid npm package name: ${JSON.stringify(pkg)}`);
  if (!SEMVER.test(version)) errors.push(`"version" is not a valid semver version: ${JSON.stringify(raw.version ?? "")}`);
  if (base && (!BRANCH.test(base) || base.includes(".."))) errors.push(`"base" is not a valid branch name: ${JSON.stringify(base)}`);
  const singletons = String(raw.singletons ?? "")
    .split(/[\s,]+/)
    .filter(Boolean);
  for (const s of singletons) if (!NAME.test(s)) errors.push(`"singletons" contains an invalid package name: ${JSON.stringify(s)}`);
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      pkg,
      version,
      base,
      requestId: String(raw.requestId ?? "").trim(),
      verifyCommand: String(raw.verifyCommand ?? "").trim(),
      singletons,
      openPrOnFailure: /^true$/i.test(String(raw.openPrOnFailure ?? "")),
      hasPrToken: Boolean(raw.hasPrToken),
      registryToken: String(raw.registryToken ?? ""),
      dryRun: /^true$/i.test(String(raw.dryRun ?? "")),
      workingDirectory: String(raw.workingDirectory ?? ".") || ".",
    },
  };
}

// --- helpers ---------------------------------------------------------------------------

const readJson = (fs, file) => JSON.parse(fs.readFileSync(file, "utf8"));
const exists = (fs, file) => {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
};

/** Paths from `git status --porcelain -z`. */
export function porcelainPaths(out) {
  return String(out)
    .split("\0")
    .filter((e) => e.length > 3)
    .map((e) => e.slice(3));
}

const baseName = (p) => p.slice(p.lastIndexOf("/") + 1);

// --- the run ------------------------------------------------------------------------------

/**
 * @param {ReturnType<typeof validateInputs> extends { input: infer I } ? I : never} input
 * @param {{
 *   fs: typeof import("node:fs"),
 *   exec: (cmd: string, args?: string[], opts?: any) => Promise<{code:number, stdout:string, stderr:string, output:string}>,
 *   log: { info(m:string):void, warn(m:string):void, error(m:string):void, group(n:string):void, endGroup():void, mask(s:string):void },
 *   homedir: string, tmpdir: string, summaryFile?: string, outputFile?: string,
 * }} deps
 */
export async function run(input, deps) {
  const { fs, log } = deps;
  const root = path.resolve(input.workingDirectory);
  const result = {
    status: "failed",
    branch: null,
    prUrl: null,
    changes: [],
    notes: [],
    skipped: [],
    verify: { label: "(none)", ran: false },
    failure: null,
    detail: "",
  };
  const ghEnv = { GH_TOKEN: deps.ghToken };
  const git = (args, opts = {}) => deps.exec("git", args, { cwd: root, ...opts });
  const gitIdentity = ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com"];

  let step = "inspect";
  let baseBranch = input.base;
  let changedManifests = [];
  let reachedInstall = false;
  let det = null;

  try {
    // ---- inspect ----------------------------------------------------------------------
    log.group("Inspect the repository");
    const rootFiles = fs.readdirSync(root);
    if (!rootFiles.includes("package.json")) throw new StepError(step, "No package.json at the repository root.");
    const rootPkg = readJson(fs, path.join(root, "package.json"));
    det = detectPackageManager({ rootFiles, packageJson: rootPkg, yarnrcYml: rootFiles.includes(".yarnrc.yml") });
    if (det.extraLockfiles.length) log.warn(`More than one lockfile at the root (${[det.lockfile, ...det.extraLockfiles].join(", ")}); using ${det.pm}.`);
    log.info(`Package manager: ${det.pm}${det.yarnBerry ? " (Berry)" : ""}; lockfile: ${det.lockfile ?? "(none)"}`);
    const found = walkRepo(root, fs);
    if (!baseBranch) {
      const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], { stream: false });
      baseBranch = head.stdout.trim();
      if (head.code !== 0 || !baseBranch || baseBranch === "HEAD") {
        if (!input.dryRun) throw new StepError(step, "Could not determine the base branch (detached HEAD); pass `base`.");
        baseBranch = "(detached)";
      }
    }
    log.endGroup();

    // ---- rewrite ----------------------------------------------------------------------
    step = "rewrite";
    log.group(`Rewrite ${input.pkg} to ${input.version}`);
    let declaredAnywhere = false;
    for (const m of found.manifests) {
      const file = path.join(root, m);
      const text = fs.readFileSync(file, "utf8");
      const res = rewriteManifest(text, input.pkg, input.version);
      if (res.found) declaredAnywhere = true;
      for (const s of res.skipped) result.skipped.push(`\`${m}\` ${s.block}: ${s.range ? `\`${s.range}\` — ` : ""}${s.reason}`);
      for (const n of res.notes) result.notes.push(`\`${m}\`: ${n}`);
      if (res.changes.length > 0) {
        fs.writeFileSync(file, res.text);
        changedManifests.push(m);
        for (const c of res.changes) {
          result.changes.push({ file: m, ...c });
          log.info(`${m}  ${c.block}  ${c.from} -> ${c.to}`);
        }
      }
    }
    log.endGroup();
    if (changedManifests.length === 0) {
      result.status = "nothing-to-do";
      result.detail = declaredAnywhere
        ? `${input.pkg} is already at ${input.version} (or declared only as an in-repo link) in every manifest — nothing to change.`
        : `${input.pkg} is not declared in any package.json in this repository.`;
      log.info(result.detail);
      return result;
    }

    // ---- registry auth ----------------------------------------------------------------
    step = "registry";
    if (input.registryToken) {
      const npmrcTexts = [];
      const publishRegistries = [];
      for (const dir of new Set(["", ...changedManifests.map((m) => (m.includes("/") ? m.slice(0, m.lastIndexOf("/")) : ""))])) {
        const f = path.join(root, dir, ".npmrc");
        if (exists(fs, f)) npmrcTexts.push(fs.readFileSync(f, "utf8"));
      }
      for (const m of found.manifests) {
        try {
          const reg = readJson(fs, path.join(root, m))?.publishConfig?.registry;
          if (typeof reg === "string") publishRegistries.push(reg);
        } catch {
          // ignore unreadable manifests
        }
      }
      if (usesGithubPackages(input.pkg, { npmrcTexts, publishRegistries })) {
        log.mask(input.registryToken);
        const userNpmrc = path.join(deps.homedir, ".npmrc");
        const lines = authNpmrcLines(input.pkg, input.registryToken, { npmrcTexts });
        fs.appendFileSync(userNpmrc, `${lines.join("\n")}\n`);
        log.info("Wrote GitHub Packages auth to the runner's user .npmrc (never to the repository).");
      }
    }

    // ---- install ------------------------------------------------------------------------
    step = "install";
    reachedInstall = true;
    const dirs = installDirs(changedManifests, found.lockfiles);
    for (const dir of dirs) {
      // Each project installs with the manager that wrote ITS lockfile — a nested npm
      // project in a pnpm monorepo must not sprout a pnpm-lock.yaml.
      const own = lockfileIn(dir, found.lockfiles, det.lockfile);
      const dirPm = (own && pmOfLockfile(own)) || det.pm;
      const [icmd, iargs] = installCommand(dirPm, { yarnBerry: dirPm === "yarn" && det.yarnBerry });
      log.group(`${icmd} ${iargs.join(" ")}  (${dir || "."})`);
      const res = await deps.exec(icmd, iargs, {
        cwd: path.join(root, dir),
        env: { CI: "true", YARN_ENABLE_IMMUTABLE_INSTALLS: "false", npm_config_yes: "true" },
      });
      log.endGroup();
      if (res.code !== 0) {
        throw new StepError(step, `\`${icmd} ${iargs.join(" ")}\` failed in \`${dir || "."}\` (exit ${res.code}).`, tail(res.output));
      }
    }

    // ---- duplicate copies ---------------------------------------------------------------
    step = "duplicates";
    const after = walkRepo(root, fs);
    const wanted = new Set([input.pkg, ...input.singletons]);
    const dupes = [];
    for (const dir of dirs) {
      const lf = lockfileIn(dir, after.lockfiles, det.lockfile);
      if (!lf) continue;
      const resolved = parseLockfile(lf, fs.readFileSync(path.join(root, lf), "utf8"), wanted);
      for (const d of findDuplicates(resolved)) dupes.push({ lockfile: lf, ...d });
    }
    if (dupes.length > 0) {
      const msg = dupes.map((d) => `\`${d.name}\` resolves at ${d.versions.join(" and ")} in \`${d.lockfile}\``).join("; ");
      throw new StepError(step, `The refreshed lockfile carries more than one copy of a package that must have one: ${msg}. Add an override (pnpm.overrides / overrides / resolutions) or align the ranges.`);
    }

    // ---- verify -------------------------------------------------------------------------
    step = "verify";
    const v = chooseVerifyCommand({ override: input.verifyCommand, scripts: rootPkg.scripts, pm: det.pm });
    if (v.command) {
      log.group(`Verify: ${v.label}`);
      const res = await deps.exec(v.command, [], { cwd: root, shell: true, env: { CI: "true" } });
      log.endGroup();
      result.verify = { label: v.label, ran: true };
      if (res.code !== 0) throw new StepError(step, `\`${v.label}\` failed (exit ${res.code}).`, tail(res.output));
    } else {
      log.warn(v.warning);
      result.verify = { label: v.label, ran: false, warning: v.warning };
    }

    // ---- branch + commit ------------------------------------------------------------------
    step = "commit";
    result.branch = await commitBranch();

    if (input.dryRun) {
      result.status = "dry-run";
      result.detail = `Dry run: committed ${result.branch} locally; nothing was pushed and no PR was opened.`;
      log.info(result.detail);
      return result;
    }

    // ---- push + PR -------------------------------------------------------------------------
    step = "push";
    log.group("Push");
    const push = await git(["push", "--force", "origin", result.branch]);
    log.endGroup();
    if (push.code !== 0) throw new StepError(step, `git push failed (exit ${push.code}).`, tail(push.output));

    step = "pull-request";
    result.prUrl = await openOrUpdatePr({ draft: false });
    result.status = "bumped";
    result.detail = `Opened or updated ${result.prUrl}`;
    log.info(result.detail);
    return result;
  } catch (err) {
    const failure = err instanceof StepError ? err : new StepError(step, err?.message ?? String(err));
    result.failure = { step: failure.step, message: failure.message, tail: failure.logTail };
    result.status = "failed";
    log.error(`${failure.step}: ${failure.message}`);
    if (input.openPrOnFailure && !input.dryRun && reachedInstall && changedManifests.length > 0 && failure.step !== "push" && failure.step !== "pull-request") {
      try {
        log.group("Open a draft PR for the failed bump");
        result.branch = await commitBranch();
        const push = await git(["push", "--force", "origin", result.branch]);
        if (push.code !== 0) throw new Error(`git push failed (exit ${push.code})`);
        result.prUrl = await openOrUpdatePr({ draft: true });
        log.info(`Draft PR: ${result.prUrl}`);
      } catch (e) {
        log.warn(`Could not open the failure PR: ${e?.message ?? e}`);
      } finally {
        log.endGroup();
      }
    }
    return result;
  } finally {
    writeReport(result, input, deps);
  }

  // --- local functions (hoisted) -------------------------------------------------------

  async function commitBranch() {
    const branch = branchName(input.pkg, input.version);
    const co = await git(["checkout", "-B", branch]);
    if (co.code !== 0) throw new StepError("commit", `git checkout -B ${branch} failed.`, tail(co.output));
    const st = await git(["status", "--porcelain", "-z"], { stream: false });
    const files = porcelainPaths(st.stdout).filter((p) => STAGEABLE_NAMES.has(baseName(p)));
    if (files.length === 0) throw new StepError("commit", "Nothing to commit after the bump.");
    const add = await git(["add", "--", ...files]);
    if (add.code !== 0) throw new StepError("commit", "git add failed.", tail(add.output));
    const commit = await git([...gitIdentity, "commit", "-m", commitMessage(input.pkg, input.version)]);
    if (commit.code !== 0) throw new StepError("commit", "git commit failed.", tail(commit.output));
    return branch;
  }

  async function openOrUpdatePr({ draft }) {
    const branch = result.branch;
    const title = commitMessage(input.pkg, input.version);
    const body = prBody({
      pkg: input.pkg,
      version: input.version,
      requestId: input.requestId,
      base: baseBranch,
      changes: result.changes,
      notes: result.notes,
      skipped: result.skipped,
      verify: result.verify,
      ciNote: !input.hasPrToken,
      failure: draft ? result.failure : null,
    });
    const bodyFile = path.join(deps.tmpdir, `rw-bump-body-${process.pid}.md`);
    fs.writeFileSync(bodyFile, body);
    const gh = (args) => deps.exec("gh", args, { cwd: root, env: ghEnv, stream: false });
    const label = draft ? LABEL_FAILED : LABEL_BUMP;

    // Labels: best effort; a missing label must not fail the bump.
    for (const [name, color, desc] of [
      [LABEL_BUMP, "7c3aed", "Dependency bump opened by Repo Wrapped"],
      [LABEL_FAILED, "d73a4a", "Repo Wrapped bump that did not pass"],
    ]) {
      await gh(["label", "create", name, "--color", color, "--description", desc, "--force"]);
    }

    const list = await gh(["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"]);
    let existing = null;
    try {
      existing = JSON.parse(list.stdout || "[]")[0] ?? null;
    } catch {
      existing = null;
    }
    if (existing) {
      const edit = await gh(["pr", "edit", String(existing.number), "--title", title, "--body-file", bodyFile, "--add-label", label, ...(draft ? [] : ["--remove-label", LABEL_FAILED])]);
      if (edit.code !== 0) throw new StepError("pull-request", `gh pr edit #${existing.number} failed.`, tail(edit.output));
      if (!draft) await gh(["pr", "ready", String(existing.number)]); // a previous failed attempt left it a draft
      return existing.url;
    }
    const create = await gh(["pr", "create", "--base", baseBranch, "--head", branch, "--title", title, "--body-file", bodyFile, "--label", label, ...(draft ? ["--draft"] : [])]);
    if (create.code !== 0) throw new StepError("pull-request", `gh pr create failed (exit ${create.code}).`, tail(create.output));
    return create.stdout.trim().split(/\s+/).find((t) => /^https?:\/\//.test(t)) ?? create.stdout.trim();
  }
}

// --- reporting ------------------------------------------------------------------------------

/** The job summary (markdown) for a result. */
export function summaryMarkdown(result, input) {
  const lines = [`## Repo Wrapped bump: \`${input.pkg}\` → \`${input.version}\``, ""];
  const icon = { bumped: "✅", "dry-run": "🧪", "nothing-to-do": "➖", failed: "❌" }[result.status] ?? "";
  lines.push(`${icon} **${result.status}**${result.detail ? ` — ${result.detail}` : ""}`, "");
  if (result.failure) {
    lines.push(`Failed at **${result.failure.step}**: ${result.failure.message}`, "");
    if (result.failure.tail) lines.push("```", result.failure.tail, "```", "");
  }
  if (result.changes.length) {
    lines.push("| Manifest | Block | From | To |", "| --- | --- | --- | --- |");
    for (const c of result.changes) lines.push(`| \`${c.file}\` | ${c.block} | \`${c.from}\` | \`${c.to}\` |`);
    lines.push("");
  }
  lines.push(result.verify.ran ? `Verify: \`${result.verify.label}\`` : `Verify: not run${result.verify.warning ? ` — ${result.verify.warning}` : ""}`, "");
  for (const n of result.notes) lines.push(`- ${n}`);
  for (const s of result.skipped) lines.push(`- Left alone: ${s}`);
  if (result.prUrl) lines.push("", `PR: ${result.prUrl}`);
  return `${lines.join("\n")}\n`;
}

function writeReport(result, input, deps) {
  try {
    if (deps.summaryFile) deps.fs.appendFileSync(deps.summaryFile, summaryMarkdown(result, input));
    if (deps.outputFile) {
      deps.fs.appendFileSync(
        deps.outputFile,
        [`status=${result.status}`, `branch=${result.branch ?? ""}`, `pr-url=${result.prUrl ?? ""}`, `changed-files=${[...new Set(result.changes.map((c) => c.file))].join(",")}`].join("\n") + "\n",
      );
    }
  } catch {
    // reporting must never mask the real outcome
  }
}
