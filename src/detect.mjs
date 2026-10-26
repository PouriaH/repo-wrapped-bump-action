// Which package manager and Node version this repository uses — decided from files,
// never from the runner.

/** Lockfiles in priority order. A repo with two lockfiles is a mid-migration repo; the
 *  first one listed wins and the others are reported. */
export const LOCKFILES = [
  { file: "pnpm-lock.yaml", pm: "pnpm" },
  { file: "package-lock.json", pm: "npm" },
  { file: "yarn.lock", pm: "yarn" },
];

/** The package manager that wrote a lockfile (by file name), or null. */
export function pmOfLockfile(file) {
  const base = String(file).slice(String(file).lastIndexOf("/") + 1);
  if (base === "npm-shrinkwrap.json") return "npm";
  return LOCKFILES.find((l) => l.file === base)?.pm ?? null;
}

/**
 * @param {{ rootFiles: string[], packageJson?: any, yarnrcYml?: boolean }} input
 * @returns {{ pm: "pnpm"|"npm"|"yarn", lockfile: string|null, extraLockfiles: string[], yarnBerry: boolean }}
 */
export function detectPackageManager({ rootFiles, packageJson, yarnrcYml }) {
  const present = LOCKFILES.filter((l) => rootFiles.includes(l.file));
  const declared = /^(pnpm|npm|yarn)@/.exec(String(packageJson?.packageManager ?? ""));
  const pm = present[0]?.pm ?? declared?.[1] ?? "npm";
  const berry =
    pm === "yarn" &&
    (Boolean(yarnrcYml) || /^yarn@(?:[2-9]|\d{2,})\./.test(String(packageJson?.packageManager ?? "")));
  return {
    pm,
    lockfile: present.find((l) => l.pm === pm)?.file ?? present[0]?.file ?? null,
    extraLockfiles: present.slice(1).map((l) => l.file),
    yarnBerry: berry,
  };
}

/** `.nvmrc` / `.node-version` contents → something `actions/setup-node` accepts. */
export function normalizeNodeVersion(raw) {
  const v = String(raw ?? "")
    .split(/\r?\n/)[0]
    .trim();
  if (!v) return null;
  if (/^lts\//i.test(v) || /^(?:node|lts|latest|current)$/i.test(v)) return v.toLowerCase() === "node" ? "node" : v;
  return v.replace(/^v/i, "");
}

/**
 * Node version: `.nvmrc`, then `.node-version`, then `engines.node`, else 20.
 * @param {{ nvmrc?: string, nodeVersionFile?: string, packageJson?: any }} input
 */
export function detectNodeVersion({ nvmrc, nodeVersionFile, packageJson }) {
  return (
    normalizeNodeVersion(nvmrc) ??
    normalizeNodeVersion(nodeVersionFile) ??
    (typeof packageJson?.engines?.node === "string" && packageJson.engines.node.trim()
      ? packageJson.engines.node.trim()
      : null) ??
    "20"
  );
}
