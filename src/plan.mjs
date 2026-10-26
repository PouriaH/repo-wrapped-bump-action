// Finding the manifests and lockfiles in a checkout, and deciding where to install.

import fs from "node:fs";
import path from "node:path";

/** Directories that are never this repo's own manifests/lockfiles. */
export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "vendor",
  "third_party",
  ".next",
  ".turbo",
  ".venv",
  "dist",
  "build",
]);

export const LOCKFILE_NAMES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]);

/** Files the commit step may stage — manifests and lockfiles, nothing else. */
export const STAGEABLE_NAMES = new Set(["package.json", ...LOCKFILE_NAMES]);

const MAX_ENTRIES = 5000;

/**
 * Every `package.json` and lockfile under `root` (POSIX-style relative paths, sorted),
 * skipping vendored and generated directories. Bounded.
 */
export function walkRepo(root, fsImpl = fs) {
  const manifests = [];
  const lockfiles = [];
  let seen = 0;
  const visit = (rel) => {
    let entries;
    try {
      entries = fsImpl.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) return;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(relPath);
      } else if (e.isFile()) {
        if (e.name === "package.json") manifests.push(relPath);
        else if (LOCKFILE_NAMES.has(e.name)) lockfiles.push(relPath);
      }
    }
  };
  visit("");
  return { manifests: manifests.sort(), lockfiles: lockfiles.sort() };
}

const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

/**
 * Directories to run the install in: for each changed manifest, the nearest ancestor
 * directory holding a lockfile; the repo root when none does. De-duplicated, sorted.
 */
export function installDirs(changedManifests, lockfiles) {
  const lockDirs = [...new Set(lockfiles.map(dirOf))];
  const out = new Set();
  for (const m of changedManifests) {
    const dir = dirOf(m);
    let best = null;
    for (const ld of lockDirs) {
      const covers = ld === "" || dir === ld || dir.startsWith(`${ld}/`);
      if (covers && (best === null || ld.length > best.length)) best = ld;
    }
    out.add(best ?? "");
  }
  return [...out].sort();
}

/** The lockfile in `dir` after an install (relative path), preferring the detected manager's. */
export function lockfileIn(dir, lockfiles, preferred) {
  const here = lockfiles.filter((l) => dirOf(l) === dir);
  return here.find((l) => l.endsWith(preferred ?? "\0")) ?? here[0] ?? null;
}
