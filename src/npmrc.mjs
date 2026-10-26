// GitHub Packages auth for the install step.
//
// A private `@acme/*` package usually lives on npm.pkg.github.com, wired up by an
// `@acme:registry=https://npm.pkg.github.com` line in the repo's own `.npmrc` (or a
// `publishConfig.registry`). The install needs a token for that host; the repo must
// never receive it. So the token goes in the RUNNER's user-level npmrc (`~/.npmrc`) —
// outside the work tree, gone with the VM — and the commit step only ever stages
// manifests and lockfiles.

export const GITHUB_PACKAGES_HOST = "npm.pkg.github.com";

/** `@acme` for `@acme/ui`; null for an unscoped name. */
export function scopeOf(pkgName) {
  const m = /^(@[^/]+)\//.exec(pkgName);
  return m ? m[1] : null;
}

/** `scope -> registry URL` from `@scope:registry=…` lines. */
export function registryMap(npmrcText) {
  const out = new Map();
  for (const raw of String(npmrcText ?? "").split(/\r?\n/)) {
    const m = /^\s*(@[^:\s]+):registry\s*=\s*(\S+)\s*$/.exec(raw);
    if (m) out.set(m[1], m[2].replace(/\/+$/, ""));
  }
  return out;
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/**
 * Does this package's scope resolve to GitHub Packages? Looks at the repo's `.npmrc`
 * first, then any manifest's `publishConfig.registry` that names the same scope's
 * registry (a monorepo that publishes to GitHub Packages consumes from it too).
 */
export function usesGithubPackages(pkgName, { npmrcTexts = [], publishRegistries = [] } = {}) {
  const scope = scopeOf(pkgName);
  if (!scope) return false;
  for (const text of npmrcTexts) {
    const url = registryMap(text).get(scope);
    if (url && hostOf(url) === GITHUB_PACKAGES_HOST) return true;
  }
  return publishRegistries.some((r) => hostOf(r) === GITHUB_PACKAGES_HOST);
}

/**
 * The lines to ADD to the runner's user npmrc: the auth token, plus the scope mapping
 * when the repo's own npmrc does not already carry it (a `publishConfig`-only repo).
 */
export function authNpmrcLines(pkgName, token, { npmrcTexts = [] } = {}) {
  const lines = [`//${GITHUB_PACKAGES_HOST}/:_authToken=${token}`];
  const scope = scopeOf(pkgName);
  const mapped = npmrcTexts.some((t) => registryMap(t).has(scope));
  if (scope && !mapped) lines.push(`${scope}:registry=https://${GITHUB_PACKAGES_HOST}`);
  return lines;
}
