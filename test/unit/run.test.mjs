import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseMarker } from "../../src/pr.mjs";
import { porcelainPaths, run, summaryMarkdown, validateInputs } from "../../src/run.mjs";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) fs.rmSync(cleanups.pop(), { recursive: true, force: true });
});

/** A throwaway checkout (+ a fake home and tmp dir). */
function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bump-run-"));
  cleanups.push(root);
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  for (const d of [repo, home, tmp]) fs.mkdirSync(d, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
  }
  return { repo, home, tmp, root };
}

const lockV3 = (pkgs) => JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...Object.fromEntries(Object.entries(pkgs).map(([n, v]) => [`node_modules/${n}`, { version: v }])) } }, null, 2);

const appPackage = (extra = {}) => ({
  name: "app",
  version: "1.0.0",
  scripts: { build: "node build.js" },
  dependencies: { "@acme/ui": "^1.0.0" },
  ...extra,
});

const baseInput = (over = {}) => ({
  pkg: "@acme/ui",
  version: "1.4.0",
  base: "",
  requestId: "req-1",
  verifyCommand: "",
  singletons: [],
  openPrOnFailure: false,
  hasPrToken: true,
  registryToken: "",
  dryRun: false,
  workingDirectory: ".",
  ...over,
});

/** A scripted process runner. `handlers` map a command prefix to a function returning a result. */
function makeDeps(repoDir, { home, tmp }, handlers = {}, extra = {}) {
  const calls = [];
  const logs = { info: [], warn: [], error: [], masked: [], groups: [] };
  const deps = {
    fs,
    homedir: home,
    tmpdir: tmp,
    summaryFile: path.join(tmp, "summary.md"),
    outputFile: path.join(tmp, "output.txt"),
    ghToken: "gh-token",
    log: {
      info: (m) => logs.info.push(m),
      warn: (m) => logs.warn.push(m),
      error: (m) => logs.error.push(m),
      group: (n) => logs.groups.push(n),
      endGroup: () => {},
      mask: (s) => logs.masked.push(s),
    },
    async exec(cmd, args = [], opts = {}) {
      const line = [cmd, ...args].join(" ");
      calls.push({ cmd, args, cwd: opts.cwd, env: opts.env, shell: opts.shell, line });
      for (const [prefix, fn] of Object.entries(handlers)) {
        if (line.startsWith(prefix)) {
          const r = (await fn({ cmd, args, opts, line })) ?? {};
          return { code: 0, stdout: "", stderr: "", output: "", ...r, output: r.output ?? `${r.stdout ?? ""}${r.stderr ?? ""}` };
        }
      }
      return { code: 0, stdout: "", stderr: "", output: "" };
    },
    ...extra,
  };
  return { deps, calls, logs };
}

/** Handlers that behave like a healthy GitHub checkout. */
const healthy = (repo, over = {}) => ({
  "git rev-parse --abbrev-ref HEAD": () => ({ stdout: "main\n" }),
  "git status --porcelain": () => ({ stdout: " M package.json\0 M package-lock.json\0 M .npmrc\0?? notes.txt\0" }),
  "npm install": () => {
    fs.writeFileSync(path.join(repo, "package-lock.json"), lockV3({ "@acme/ui": "1.4.0" }));
  },
  "npm run build": () => ({}),
  "gh pr list": () => ({ stdout: "[]" }),
  "gh pr create": () => ({ stdout: "https://github.com/acme/app/pull/7\n" }),
  ...over,
});

const files = (over = {}) => ({
  "package.json": appPackage(),
  "package-lock.json": lockV3({ "@acme/ui": "1.0.0" }),
  ...over,
});

describe("run — the happy path", () => {
  it("rewrites, installs, verifies, commits only manifests and lockfiles, pushes and opens a PR", async () => {
    const r = makeRepo(files({ ".npmrc": "registry=https://registry.npmjs.org\n" }));
    const { deps, calls } = makeDeps(r.repo, r, healthy(r.repo));
    const res = await run(baseInput({ workingDirectory: r.repo }), deps);

    assert.equal(res.status, "bumped");
    assert.equal(res.prUrl, "https://github.com/acme/app/pull/7");
    assert.equal(res.branch, "repo-wrapped/bump-acme-ui-1.4.0");
    assert.equal(JSON.parse(fs.readFileSync(path.join(r.repo, "package.json"), "utf8")).dependencies["@acme/ui"], "^1.4.0");

    const lines = calls.map((c) => c.line);
    const idx = (p) => lines.findIndex((l) => l.startsWith(p));
    // the order is the contract
    assert.ok(idx("npm install") > -1);
    assert.ok(idx("npm install") < idx("npm run build"));
    assert.ok(idx("npm run build") < idx("git checkout -B"));
    assert.ok(idx("git checkout -B") < idx("git add"));
    assert.ok(idx("git add") < idx("git -c"));
    assert.ok(idx("git -c") < idx("git push"));
    assert.ok(idx("git push") < idx("gh pr list"));

    const add = calls.find((c) => c.line.startsWith("git add"));
    assert.deepEqual(add.args, ["add", "--", "package.json", "package-lock.json"]); // never .npmrc or notes.txt
    const commit = calls.find((c) => c.line.includes("commit -m"));
    assert.equal(commit.args.at(-1), "chore(deps): bump @acme/ui to 1.4.0");
    assert.ok(commit.args.includes("user.name=github-actions[bot]"));
    assert.deepEqual(calls.find((c) => c.line.startsWith("git push")).args, ["push", "--force", "origin", "repo-wrapped/bump-acme-ui-1.4.0"]);

    // verification ran as a shell command, in CI mode, after the install
    const verify = calls.find((c) => c.line === "npm run build");
    assert.equal(verify.shell, true);
    assert.equal(verify.env.CI, "true");
  });

  it("the PR carries the label and ends with the tracking marker", async () => {
    const r = makeRepo(files());
    const { deps, calls } = makeDeps(r.repo, r, healthy(r.repo));
    await run(baseInput({ workingDirectory: r.repo }), deps);
    const create = calls.find((c) => c.line.startsWith("gh pr create"));
    assert.ok(create.args.includes("--label") && create.args.includes("repo-wrapped:bump"));
    assert.ok(!create.args.includes("--draft"));
    assert.equal(create.args[create.args.indexOf("--base") + 1], "main");
    assert.equal(create.args[create.args.indexOf("--head") + 1], "repo-wrapped/bump-acme-ui-1.4.0");
    assert.equal(create.env.GH_TOKEN, "gh-token");
    const body = fs.readFileSync(create.args[create.args.indexOf("--body-file") + 1], "utf8");
    assert.deepEqual(parseMarker(body), { pkg: "@acme/ui", version: "1.4.0", requestId: "req-1" });
    assert.match(body, /\| `package.json` \| dependencies \| `\^1\.0\.0` \| `\^1\.4\.0` \|/);
    assert.doesNotMatch(body, /CI checks may not have run/); // a pr-token was given
    // the labels exist before they are used
    const labels = calls.filter((c) => c.line.startsWith("gh label create")).map((c) => c.args[2]);
    assert.deepEqual(labels, ["repo-wrapped:bump", "repo-wrapped:bump-failed"]);
  });

  it("says in the PR that CI may not have run when there is no pr-token", async () => {
    const r = makeRepo(files());
    const { deps, calls } = makeDeps(r.repo, r, healthy(r.repo));
    await run(baseInput({ workingDirectory: r.repo, hasPrToken: false }), deps);
    const create = calls.find((c) => c.line.startsWith("gh pr create"));
    const body = fs.readFileSync(create.args[create.args.indexOf("--body-file") + 1], "utf8");
    assert.match(body, /Your CI checks may not have run on this PR/);
  });

  it("updates the PR for the same branch instead of opening a second one, and un-drafts it", async () => {
    const r = makeRepo(files());
    const { deps, calls } = makeDeps(r.repo, r, healthy(r.repo, { "gh pr list": () => ({ stdout: '[{"number":7,"url":"https://github.com/acme/app/pull/7"}]' }) }));
    const res = await run(baseInput({ workingDirectory: r.repo }), deps);
    assert.equal(res.status, "bumped");
    assert.equal(res.prUrl, "https://github.com/acme/app/pull/7");
    assert.equal(calls.some((c) => c.line.startsWith("gh pr create")), false);
    const edit = calls.find((c) => c.line.startsWith("gh pr edit 7"));
    assert.ok(edit.args.includes("--add-label") && edit.args.includes("--remove-label"));
    assert.ok(calls.some((c) => c.line === "gh pr ready 7"));
  });

  it("uses an explicit base branch for the PR", async () => {
    const r = makeRepo(files());
    const { deps, calls } = makeDeps(r.repo, r, healthy(r.repo));
    await run(baseInput({ workingDirectory: r.repo, base: "sandbox" }), deps);
    assert.equal(calls.some((c) => c.line.startsWith("git rev-parse")), false);
    const create = calls.find((c) => c.line.startsWith("gh pr create"));
    assert.equal(create.args[create.args.indexOf("--base") + 1], "sandbox");
  });

  it("writes the job summary and the step outputs", async () => {
    const r = makeRepo(files());
    const { deps } = makeDeps(r.repo, r, healthy(r.repo));
    await run(baseInput({ workingDirectory: r.repo }), deps);
    const summary = fs.readFileSync(deps.summaryFile, "utf8");
    assert.match(summary, /Repo Wrapped bump: `@acme\/ui` → `1\.4\.0`/);
    assert.match(summary, /\*\*bumped\*\*/);
    const out = fs.readFileSync(deps.outputFile, "utf8");
    assert.match(out, /^status=bumped$/m);
    assert.match(out, /^branch=repo-wrapped\/bump-acme-ui-1\.4\.0$/m);
    assert.match(out, /^pr-url=https:\/\/github\.com\/acme\/app\/pull\/7$/m);
    assert.match(out, /^changed-files=package\.json$/m);
  });
});

describe("run — dry run, no-ops and a monorepo", () => {
  it("dry-run commits locally and does not push or open a PR", async () => {
    const r = makeRepo(files());
    const { deps, calls } = makeDeps(r.repo, r, healthy(r.repo));
    const res = await run(baseInput({ workingDirectory: r.repo, dryRun: true }), deps);
    assert.equal(res.status, "dry-run");
    assert.ok(calls.some((c) => c.line.includes("commit -m")));
    assert.equal(calls.some((c) => c.line.startsWith("git push") || c.line.startsWith("gh ")), false);
  });

  it("nothing to do when the package is not declared, or already there", async () => {
    let r = makeRepo(files({ "package.json": appPackage({ dependencies: { other: "^1.0.0" } }) }));
    let { deps, calls } = makeDeps(r.repo, r, healthy(r.repo));
    let res = await run(baseInput({ workingDirectory: r.repo }), deps);
    assert.equal(res.status, "nothing-to-do");
    assert.match(res.detail, /not declared/);
    assert.equal(calls.some((c) => c.line.startsWith("npm install")), false);

    r = makeRepo(files({ "package.json": appPackage({ dependencies: { "@acme/ui": "^1.4.0" } }) }));
    ({ deps } = makeDeps(r.repo, r, healthy(r.repo)));
    res = await run(baseInput({ workingDirectory: r.repo }), deps);
    assert.equal(res.status, "nothing-to-do");
    assert.match(res.detail, /already at 1\.4\.0/);
  });

  it("an in-repo link (workspace:*) is left alone and explained", async () => {
    const r = makeRepo(files({ "package.json": appPackage({ dependencies: { "@acme/ui": "workspace:*" } }) }));
    const { deps } = makeDeps(r.repo, r, healthy(r.repo));
    const res = await run(baseInput({ workingDirectory: r.repo }), deps);
    assert.equal(res.status, "nothing-to-do");
    assert.equal(res.skipped.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(r.repo, "package.json"), "utf8")).dependencies["@acme/ui"], "workspace:*");
  });

  it("rewrites every manifest that declares it and installs once per lockfile directory", async () => {
    const r = makeRepo({
      "package.json": appPackage({ dependencies: {} }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\npackages:\n",
      "packages/web/package.json": { name: "web", dependencies: { "@acme/ui": "^1.0.0" } },
      "packages/docs/package.json": { name: "docs", devDependencies: { "@acme/ui": "~1.1.0" } },
      "tools/legacy/package.json": { name: "legacy", dependencies: { "@acme/ui": "^1.0.0" } },
      "tools/legacy/package-lock.json": lockV3({ "@acme/ui": "1.0.0" }),
    });
    const { deps, calls } = makeDeps(r.repo, r, {
      "git rev-parse --abbrev-ref HEAD": () => ({ stdout: "main\n" }),
      "git status --porcelain": () => ({ stdout: " M packages/web/package.json\0 M packages/docs/package.json\0 M tools/legacy/package.json\0 M pnpm-lock.yaml\0" }),
      "pnpm install": () => {
        fs.writeFileSync(path.join(r.repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages:\n  '@acme/ui@1.4.0':\n    resolution: {}\n");
      },
      "npm install": () => {
        fs.writeFileSync(path.join(r.repo, "tools/legacy/package-lock.json"), lockV3({ "@acme/ui": "1.4.0" }));
      },
      "gh pr list": () => ({ stdout: "[]" }),
      "gh pr create": () => ({ stdout: "https://github.com/acme/app/pull/9" }),
    });
    const res = await run(baseInput({ workingDirectory: r.repo, verifyCommand: "echo ok" }), deps);
    assert.equal(res.status, "bumped");
    assert.deepEqual([...new Set(res.changes.map((c) => c.file))].sort(), ["packages/docs/package.json", "packages/web/package.json", "tools/legacy/package.json"]);
    const installs = calls.filter((c) => c.line.includes("install"));
    assert.deepEqual(installs.map((c) => path.relative(r.repo, c.cwd).replace(/\\/g, "/")), ["", "tools/legacy"]);
    // each project installs with the manager that wrote its own lockfile
    assert.deepEqual(installs.map((c) => c.line), ["pnpm install --no-frozen-lockfile", "npm install"]);
    assert.equal(calls.find((c) => c.line === "echo ok").shell, true);
  });
});

describe("run — failures", () => {
  it("a failed install stops the run, shows the log tail, and opens no PR by default", async () => {
    const r = makeRepo(files());
    const { deps, calls } = makeDeps(r.repo, r, healthy(r.repo, { "npm install": () => ({ code: 1, output: "npm ERR! 404 Not Found - @acme/ui@1.4.0" }) }));
    const res = await run(baseInput({ workingDirectory: r.repo }), deps);
    assert.equal(res.status, "failed");
    assert.equal(res.failure.step, "install");
    assert.match(res.failure.tail, /404 Not Found/);
    assert.equal(calls.some((c) => c.line.startsWith("git push") || c.line.startsWith("gh pr")), false);
    const summary = fs.readFileSync(deps.summaryFile, "utf8");
    assert.match(summary, /Failed at \*\*install\*\*/);
    assert.match(summary, /404 Not Found/);
    assert.match(fs.readFileSync(deps.outputFile, "utf8"), /^status=failed$/m);
  });

  it("a failing build is a failure at the verify step", async () => {
    const r = makeRepo(files());
    const { deps } = makeDeps(r.repo, r, healthy(r.repo, { "npm run build": () => ({ code: 2, output: "Error: Module not found" }) }));
    const res = await run(baseInput({ workingDirectory: r.repo }), deps);
    assert.equal(res.failure.step, "verify");
    assert.match(res.failure.message, /npm run build.*failed \(exit 2\)/);
  });

  it("two copies of the bumped package in the refreshed lockfile fail the run, listing the versions", async () => {
    const r = makeRepo(files());
    const { deps, calls } = makeDeps(r.repo, r, healthy(r.repo, {
      "npm install": () => {
        fs.writeFileSync(path.join(r.repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/@acme/ui": { version: "1.4.0" }, "node_modules/x/node_modules/@acme/ui": { version: "1.0.0" } } }));
      },
    }));
    const res = await run(baseInput({ workingDirectory: r.repo }), deps);
    assert.equal(res.failure.step, "duplicates");
    assert.match(res.failure.message, /`@acme\/ui` resolves at 1\.0\.0 and 1\.4\.0 in `package-lock\.json`/);
    assert.equal(calls.some((c) => c.line === "npm run build"), false, "no point building a lockfile we already refuse");
  });

  it("singletons are checked too", async () => {
    const r = makeRepo(files());
    const { deps } = makeDeps(r.repo, r, healthy(r.repo, {
      "npm install": () => {
        fs.writeFileSync(path.join(r.repo, "package-lock.json"), lockV3({ "@acme/ui": "1.4.0" }).replace('"node_modules/@acme/ui"', '"node_modules/react": {"version":"18.0.0"}, "node_modules/a/node_modules/react": {"version":"19.0.0"}, "node_modules/@acme/ui"'));
      },
    }));
    const res = await run(baseInput({ workingDirectory: r.repo, singletons: ["react"] }), deps);
    assert.equal(res.failure.step, "duplicates");
    assert.match(res.failure.message, /`react` resolves at 18\.0\.0 and 19\.0\.0/);
    // …and without naming it, the same lockfile passes
    const r2 = makeRepo(files());
    const again = makeDeps(r2.repo, r2, healthy(r2.repo, { "npm install": () => fs.writeFileSync(path.join(r2.repo, "package-lock.json"), lockV3({ "@acme/ui": "1.4.0", react: "18.0.0" })) }));
    assert.equal((await run(baseInput({ workingDirectory: r2.repo }), again.deps)).status, "bumped");
  });

  it("open-pr-on-failure opens a DRAFT PR labelled bump-failed, with the failure in the body", async () => {
    const r = makeRepo(files());
    const { deps, calls } = makeDeps(r.repo, r, healthy(r.repo, { "npm run build": () => ({ code: 1, output: "Error: boom" }) }));
    const res = await run(baseInput({ workingDirectory: r.repo, openPrOnFailure: true }), deps);
    assert.equal(res.status, "failed");
    assert.equal(res.prUrl, "https://github.com/acme/app/pull/7");
    const create = calls.find((c) => c.line.startsWith("gh pr create"));
    assert.ok(create.args.includes("--draft"));
    assert.equal(create.args[create.args.indexOf("--label") + 1], "repo-wrapped:bump-failed");
    const body = fs.readFileSync(create.args[create.args.indexOf("--body-file") + 1], "utf8");
    assert.match(body, /did not pass.*verify/);
    assert.match(body, /Error: boom/);
    assert.equal(parseMarker(body).requestId, "req-1");
  });

  it("…but not when the failure was before anything was bumped", async () => {
    const r = makeRepo({ "README.md": "no package.json" });
    const { deps, calls } = makeDeps(r.repo, r, healthy(r.repo));
    const res = await run(baseInput({ workingDirectory: r.repo, openPrOnFailure: true }), deps);
    assert.equal(res.failure.step, "inspect");
    assert.equal(calls.some((c) => c.line.startsWith("gh ")), false);
  });

  it("a failed push is reported, and does not try to open a failure PR", async () => {
    const r = makeRepo(files());
    const { deps, calls } = makeDeps(r.repo, r, healthy(r.repo, { "git push": () => ({ code: 1, output: "remote: Permission denied" }) }));
    const res = await run(baseInput({ workingDirectory: r.repo, openPrOnFailure: true }), deps);
    assert.equal(res.failure.step, "push");
    assert.equal(calls.some((c) => c.line.startsWith("gh pr create")), false);
  });

  it("no verify script and no override: warns, still proceeds, and says so in the PR", async () => {
    const r = makeRepo(files({ "package.json": appPackage({ scripts: { lint: "x" } }) }));
    const { deps, calls, logs } = makeDeps(r.repo, r, healthy(r.repo));
    const res = await run(baseInput({ workingDirectory: r.repo }), deps);
    assert.equal(res.status, "bumped");
    assert.equal(res.verify.ran, false);
    assert.ok(logs.warn.some((w) => /NOT verified/.test(w)));
    const create = calls.find((c) => c.line.startsWith("gh pr create"));
    assert.match(fs.readFileSync(create.args[create.args.indexOf("--body-file") + 1], "utf8"), /NOT verified/);
  });

  it("detached HEAD without a base is an error — except in a dry run", async () => {
    const detached = { "git rev-parse --abbrev-ref HEAD": () => ({ stdout: "HEAD\n" }) };
    let r = makeRepo(files());
    let res = await run(baseInput({ workingDirectory: r.repo }), makeDeps(r.repo, r, healthy(r.repo, detached)).deps);
    assert.equal(res.failure.step, "inspect");
    assert.match(res.failure.message, /detached HEAD/);
    r = makeRepo(files());
    res = await run(baseInput({ workingDirectory: r.repo, dryRun: true }), makeDeps(r.repo, r, healthy(r.repo, detached)).deps);
    assert.equal(res.status, "dry-run");
  });
});

describe("run — registry auth", () => {
  const scoped = { ".npmrc": "@acme:registry=https://npm.pkg.github.com\n" };

  it("writes the token to the runner's user .npmrc, masks it, and never touches the repo's .npmrc", async () => {
    const r = makeRepo(files(scoped));
    const { deps, logs, calls } = makeDeps(r.repo, r, healthy(r.repo));
    await run(baseInput({ workingDirectory: r.repo, registryToken: "ghs_secret" }), deps);
    assert.equal(fs.readFileSync(path.join(r.home, ".npmrc"), "utf8"), "//npm.pkg.github.com/:_authToken=ghs_secret\n");
    assert.equal(fs.readFileSync(path.join(r.repo, ".npmrc"), "utf8"), scoped[".npmrc"]);
    assert.deepEqual(logs.masked, ["ghs_secret"]);
    // the token is not on any command line, and the repo's .npmrc is not staged
    assert.equal(calls.some((c) => c.line.includes("ghs_secret")), false);
    assert.deepEqual(calls.find((c) => c.line.startsWith("git add")).args, ["add", "--", "package.json", "package-lock.json"]);
  });

  it("does nothing for a package that does not live on GitHub Packages", async () => {
    const r = makeRepo(files({ ".npmrc": "@acme:registry=https://registry.npmjs.org\n" }));
    const { deps, logs } = makeDeps(r.repo, r, healthy(r.repo));
    await run(baseInput({ workingDirectory: r.repo, registryToken: "ghs_secret" }), deps);
    assert.equal(fs.existsSync(path.join(r.home, ".npmrc")), false);
    assert.deepEqual(logs.masked, []);
  });

  it("maps the scope itself when only publishConfig says it is on GitHub Packages", async () => {
    const r = makeRepo(files({ "libs/x/package.json": { name: "@acme/x", version: "1.0.0", publishConfig: { registry: "https://npm.pkg.github.com" } } }));
    const { deps } = makeDeps(r.repo, r, healthy(r.repo));
    await run(baseInput({ workingDirectory: r.repo, registryToken: "ghs_secret" }), deps);
    assert.deepEqual(fs.readFileSync(path.join(r.home, ".npmrc"), "utf8").trim().split("\n"), ["//npm.pkg.github.com/:_authToken=ghs_secret", "@acme:registry=https://npm.pkg.github.com"]);
  });
});

describe("validateInputs", () => {
  const ok = (over) => validateInputs({ package: "@acme/ui", version: "1.4.0", ...over });
  it("accepts a normal request and normalises it", () => {
    const v = ok({ version: "v1.4.0", singletons: "react, react-dom  next", openPrOnFailure: "TRUE", dryRun: "false", requestId: " abc " });
    assert.equal(v.ok, true);
    assert.equal(v.input.version, "1.4.0");
    assert.deepEqual(v.input.singletons, ["react", "react-dom", "next"]);
    assert.equal(v.input.openPrOnFailure, true);
    assert.equal(v.input.dryRun, false);
    assert.equal(v.input.requestId, "abc");
  });
  it("rejects anything that could reach a shell, a ref name or a PR as something else", () => {
    for (const over of [
      { package: "x; rm -rf /" },
      { package: "$(whoami)" },
      { package: "../escape" },
      { package: "" },
      { version: "1.4" },
      { version: "latest" },
      { version: "1.4.0; echo" },
      { base: "main..evil" },
      { base: "-flag" },
      { base: "a b" },
      { singletons: "react;ls" },
    ]) {
      assert.equal(ok(over).ok, false, JSON.stringify(over));
    }
  });
  it("allows scoped names, pre-releases and slashed branches", () => {
    assert.equal(ok({ version: "2.0.0-rc.1+build.5", base: "release/2026-06" }).ok, true);
  });
});

describe("helpers", () => {
  it("porcelainPaths reads `git status --porcelain -z`", () => {
    assert.deepEqual(porcelainPaths(" M a/package.json\0?? b c.txt\0A  d.lock\0"), ["a/package.json", "b c.txt", "d.lock"]);
    assert.deepEqual(porcelainPaths(""), []);
  });
  it("summaryMarkdown", () => {
    const md = summaryMarkdown({ status: "failed", detail: "", failure: { step: "verify", message: "boom", tail: "x" }, changes: [], notes: [], skipped: [], verify: { ran: false, label: "(none)" }, prUrl: null }, { pkg: "a", version: "1.0.0" });
    assert.match(md, /❌ \*\*failed\*\*/);
    assert.match(md, /Failed at \*\*verify\*\*/);
  });
});
