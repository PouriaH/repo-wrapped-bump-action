import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { detectNodeVersion, detectPackageManager, normalizeNodeVersion } from "../../src/detect.mjs";
import { compareVersions, findDuplicates, parseLockfile, parsePackageLock, parsePnpmLock, parseYarnLock } from "../../src/lockfile.mjs";
import { authNpmrcLines, registryMap, scopeOf, usesGithubPackages } from "../../src/npmrc.mjs";
import { installDirs, lockfileIn, walkRepo } from "../../src/plan.mjs";
import { branchName, commitMessage, marker, parseMarker, prBody, slug } from "../../src/pr.mjs";
import { chooseVerifyCommand, installCommand } from "../../src/verify.mjs";

describe("detectPackageManager", () => {
  it("the lockfile decides", () => {
    assert.equal(detectPackageManager({ rootFiles: ["package.json", "pnpm-lock.yaml"] }).pm, "pnpm");
    assert.equal(detectPackageManager({ rootFiles: ["package.json", "package-lock.json"] }).pm, "npm");
    assert.equal(detectPackageManager({ rootFiles: ["package.json", "yarn.lock"] }).pm, "yarn");
  });
  it("falls back to the packageManager field, then npm", () => {
    assert.equal(detectPackageManager({ rootFiles: [], packageJson: { packageManager: "pnpm@9.1.0" } }).pm, "pnpm");
    assert.equal(detectPackageManager({ rootFiles: [] }).pm, "npm");
  });
  it("reports a second lockfile and prefers pnpm", () => {
    const d = detectPackageManager({ rootFiles: ["yarn.lock", "pnpm-lock.yaml"] });
    assert.equal(d.pm, "pnpm");
    assert.deepEqual(d.extraLockfiles, ["yarn.lock"]);
  });
  it("tells Yarn Berry from classic", () => {
    assert.equal(detectPackageManager({ rootFiles: ["yarn.lock"], yarnrcYml: true }).yarnBerry, true);
    assert.equal(detectPackageManager({ rootFiles: ["yarn.lock"], packageJson: { packageManager: "yarn@4.1.0" } }).yarnBerry, true);
    assert.equal(detectPackageManager({ rootFiles: ["yarn.lock"], packageJson: { packageManager: "yarn@1.22.22" } }).yarnBerry, false);
    assert.equal(detectPackageManager({ rootFiles: ["pnpm-lock.yaml"], yarnrcYml: true }).yarnBerry, false);
  });
});

describe("detectNodeVersion", () => {
  it(".nvmrc, then .node-version, then engines.node, else 20", () => {
    assert.equal(detectNodeVersion({ nvmrc: "v22.1.0\n", nodeVersionFile: "18", packageJson: { engines: { node: ">=16" } } }), "22.1.0");
    assert.equal(detectNodeVersion({ nodeVersionFile: "18\n", packageJson: { engines: { node: ">=16" } } }), "18");
    assert.equal(detectNodeVersion({ packageJson: { engines: { node: ">=18 <21" } } }), ">=18 <21");
    assert.equal(detectNodeVersion({}), "20");
    assert.equal(detectNodeVersion({ nvmrc: "  \n" }), "20");
  });
  it("passes aliases through", () => {
    assert.equal(normalizeNodeVersion("lts/iron"), "lts/iron");
    assert.equal(normalizeNodeVersion("lts/*"), "lts/*");
    assert.equal(normalizeNodeVersion("node"), "node");
    assert.equal(normalizeNodeVersion("v20"), "20");
  });
});

describe("lockfile parsers", () => {
  it("package-lock.json v3 — including nested node_modules and links", () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "app" },
        "node_modules/react": { version: "18.3.1" },
        "node_modules/@acme/ui": { version: "1.4.0" },
        "node_modules/foo/node_modules/react": { version: "17.0.2" },
        "node_modules/ws": { link: true, resolved: "../ws" },
      },
    });
    const r = parsePackageLock(text, new Set(["react", "@acme/ui"]));
    assert.deepEqual([...r.get("react")].sort(), ["17.0.2", "18.3.1"]);
    assert.deepEqual([...r.get("@acme/ui")], ["1.4.0"]);
    assert.equal(r.has("ws"), false);
  });
  it("package-lock.json v1 — a nested dependency tree", () => {
    const text = JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0", dependencies: { a: { version: "2.0.0" } } } } });
    assert.deepEqual([...parsePackageLock(text).get("a")].sort(), ["1.0.0", "2.0.0"]);
  });
  it("pnpm-lock.yaml — v9 keys, scoped names, peer suffixes, and the v5 slash form", () => {
    const text = [
      "lockfileVersion: '9.0'",
      "packages:",
      "  '@acme/ui@1.4.0':",
      "    resolution: {}",
      "  react@18.3.1:",
      "    resolution: {}",
      "  react@19.0.0:",
      "  react-dom@19.0.0(react@19.0.0):",
      "  /old@1.0.0_peer@2:",
      "  /@old/pkg/3.2.1:",
      "snapshots:",
      "  react@19.0.0: {}",
    ].join("\n");
    const r = parsePnpmLock(text);
    assert.deepEqual([...r.get("react")].sort(), ["18.3.1", "19.0.0"]);
    assert.deepEqual([...r.get("@acme/ui")], ["1.4.0"]);
    assert.deepEqual([...r.get("react-dom")], ["19.0.0"]);
    assert.deepEqual([...r.get("old")], ["1.0.0"]);
    assert.deepEqual([...r.get("@old/pkg")], ["3.2.1"]);
  });
  it("yarn.lock — classic and Berry", () => {
    const classic = ['"@acme/ui@^1.0.0", "@acme/ui@^1.2.0":', '  version "1.4.0"', "  resolved x", "", "left-pad@^1.0.0:", '  version "1.3.0"'].join("\n");
    const berry = ['"@acme/ui@npm:^1.0.0":', "  version: 1.4.0", "  resolution: x"].join("\n");
    assert.deepEqual([...parseYarnLock(classic).get("@acme/ui")], ["1.4.0"]);
    assert.deepEqual([...parseYarnLock(classic).get("left-pad")], ["1.3.0"]);
    assert.deepEqual([...parseYarnLock(berry).get("@acme/ui")], ["1.4.0"]);
  });
  it("garbage gives an empty map, never a throw", () => {
    for (const f of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
      assert.equal(parseLockfile(f, "\u0000not a lockfile{{").size, 0);
    }
    assert.equal(parseLockfile("Cargo.lock", "x").size, 0);
  });
  it("findDuplicates lists names with >1 version, oldest first", () => {
    const m = new Map([
      ["react", new Set(["19.0.0", "18.3.1", "18.10.0"])],
      ["next", new Set(["15.0.0"])],
    ]);
    assert.deepEqual(findDuplicates(m), [{ name: "react", versions: ["18.3.1", "18.10.0", "19.0.0"] }]);
    assert.equal(compareVersions("1.2.0", "1.10.0") < 0, true);
    assert.equal(compareVersions("1.0.0", "1.0.0-rc.1") > 0, true);
  });
});

describe("registry auth", () => {
  const npmrc = "@acme:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n";
  it("reads scope mappings", () => {
    assert.deepEqual([...registryMap(npmrc)], [["@acme", "https://npm.pkg.github.com"]]);
    assert.equal(scopeOf("@acme/ui"), "@acme");
    assert.equal(scopeOf("left-pad"), null);
  });
  it("detects GitHub Packages from .npmrc or publishConfig, for the right scope only", () => {
    assert.equal(usesGithubPackages("@acme/ui", { npmrcTexts: [npmrc] }), true);
    assert.equal(usesGithubPackages("@other/ui", { npmrcTexts: [npmrc] }), false);
    assert.equal(usesGithubPackages("left-pad", { npmrcTexts: [npmrc] }), false);
    assert.equal(usesGithubPackages("@acme/ui", { publishRegistries: ["https://npm.pkg.github.com"] }), true);
    assert.equal(usesGithubPackages("@acme/ui", { npmrcTexts: ["@acme:registry=https://registry.npmjs.org"] }), false);
  });
  it("adds the scope mapping only when the repo does not already carry it", () => {
    assert.deepEqual(authNpmrcLines("@acme/ui", "tok", { npmrcTexts: [npmrc] }), ["//npm.pkg.github.com/:_authToken=tok"]);
    assert.deepEqual(authNpmrcLines("@acme/ui", "tok", { npmrcTexts: [] }), [
      "//npm.pkg.github.com/:_authToken=tok",
      "@acme:registry=https://npm.pkg.github.com",
    ]);
  });
});

describe("verify", () => {
  it("override wins; else build, typecheck, test; else a warning", () => {
    assert.equal(chooseVerifyCommand({ override: "make check", scripts: { build: "x" }, pm: "pnpm" }).command, "make check");
    assert.equal(chooseVerifyCommand({ scripts: { build: "x", test: "y" }, pm: "pnpm" }).command, "pnpm run build");
    assert.equal(chooseVerifyCommand({ scripts: { typecheck: "x", test: "y" }, pm: "npm" }).command, "npm run typecheck");
    assert.equal(chooseVerifyCommand({ scripts: { test: "y" }, pm: "yarn" }).command, "yarn run test");
    const none = chooseVerifyCommand({ scripts: { lint: "x" }, pm: "npm" });
    assert.equal(none.command, null);
    assert.match(none.warning, /NOT verified/);
    assert.equal(chooseVerifyCommand({ scripts: { build: "  " }, pm: "npm" }).command, null);
  });
  it("installs refresh the lockfile — never frozen", () => {
    assert.deepEqual(installCommand("pnpm"), ["pnpm", ["install", "--no-frozen-lockfile"]]);
    assert.deepEqual(installCommand("npm"), ["npm", ["install"]]);
    assert.deepEqual(installCommand("yarn"), ["yarn", ["install"]]);
    assert.deepEqual(installCommand("yarn", { yarnBerry: true }), ["yarn", ["install", "--no-immutable"]]);
  });
});

describe("pull-request text", () => {
  it("slugs and branch names are safe", () => {
    assert.equal(slug("@acme/ui"), "acme-ui");
    assert.equal(branchName("@acme/ui", "1.4.0"), "repo-wrapped/bump-acme-ui-1.4.0");
    assert.equal(branchName("left-pad", "2.0.0-rc.1+build"), "repo-wrapped/bump-left-pad-2.0.0-rc.1-build");
    assert.equal(commitMessage("@acme/ui", "1.4.0"), "chore(deps): bump @acme/ui to 1.4.0");
  });
  it("the marker round-trips, and is stripped of anything that could break the comment", () => {
    const m = marker({ pkg: "@acme/ui", version: "1.4.0", requestId: "abc-123" });
    assert.equal(m, "<!-- repo-wrapped:bump pkg=@acme/ui ver=1.4.0 request=abc-123 -->");
    assert.deepEqual(parseMarker(`text\n\n${m}\n`), { pkg: "@acme/ui", version: "1.4.0", requestId: "abc-123" });
    assert.equal(parseMarker(marker({ pkg: "a", version: "1.0.0", requestId: "x --> <script>" })).requestId, "x-script");
    assert.equal(parseMarker("no marker"), null);
    assert.equal(parseMarker(marker({ pkg: "a", version: "1.0.0" })).requestId, "");
  });
  const base = {
    pkg: "@acme/ui",
    version: "1.4.0",
    requestId: "r1",
    base: "main",
    changes: [{ file: "package.json", block: "dependencies", from: "^1.2.0", to: "^1.4.0" }],
    verify: { label: "pnpm run build", ran: true },
    ciNote: false,
  };
  it("ends with the marker, lists the changes, and says what verified it", () => {
    const body = prBody(base);
    assert.ok(body.trimEnd().endsWith("<!-- repo-wrapped:bump pkg=@acme/ui ver=1.4.0 request=r1 -->"));
    assert.match(body, /\| `package.json` \| dependencies \| `\^1\.2\.0` \| `\^1\.4\.0` \|/);
    assert.match(body, /Verified in the job with `pnpm run build` — passed/);
    assert.doesNotMatch(body, /CI checks may not have run/);
  });
  it("says CI may not have run when the PR was opened with GITHUB_TOKEN", () => {
    assert.match(prBody({ ...base, ciNote: true }), /Your CI checks may not have run on this PR/);
  });
  it("warns when nothing verified the bump", () => {
    const body = prBody({ ...base, verify: { label: "(none)", ran: false, warning: "No script — NOT verified." } });
    assert.match(body, /NOT verified/);
  });
  it("a failure body leads with the failure and its log tail", () => {
    const body = prBody({ ...base, failure: { step: "verify", message: "`pnpm run build` failed", tail: "Error: boom" } });
    assert.match(body, /did not pass.*verify/);
    assert.match(body, /Error: boom/);
    assert.doesNotMatch(body, /— passed/);
  });
});

describe("plan", () => {
  it("walks a checkout, skipping vendored and generated directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bump-plan-"));
    try {
      const put = (p) => {
        fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
        fs.writeFileSync(path.join(root, p), "{}");
      };
      for (const p of ["package.json", "pnpm-lock.yaml", "apps/web/package.json", "apps/web/package-lock.json", "node_modules/x/package.json", "vendor/y/package.json", "dist/package.json", ".git/x/package.json", "packages/ui/package.json"]) put(p);
      const w = walkRepo(root);
      assert.deepEqual(w.manifests, ["apps/web/package.json", "package.json", "packages/ui/package.json"]);
      assert.deepEqual(w.lockfiles, ["apps/web/package-lock.json", "pnpm-lock.yaml"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("installs at the nearest lockfile, the root when none covers, and once per directory", () => {
    const locks = ["pnpm-lock.yaml", "apps/web/package-lock.json"];
    assert.deepEqual(installDirs(["package.json", "packages/ui/package.json"], locks), [""]);
    assert.deepEqual(installDirs(["apps/web/package.json", "apps/web/sub/package.json"], locks), ["apps/web"]);
    assert.deepEqual(installDirs(["apps/web/package.json", "package.json"], locks), ["", "apps/web"]);
    assert.deepEqual(installDirs(["x/package.json"], []), [""]);
  });
  it("lockfileIn prefers the detected manager's file", () => {
    assert.equal(lockfileIn("", ["yarn.lock", "pnpm-lock.yaml"], "pnpm-lock.yaml"), "pnpm-lock.yaml");
    assert.equal(lockfileIn("apps/x", ["pnpm-lock.yaml"], "pnpm-lock.yaml"), null);
  });
});
