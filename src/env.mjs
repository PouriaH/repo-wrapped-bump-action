// Which credentials a child process may see.
//
// The install (dependency lifecycle scripts — including the package being bumped), the
// verify command (the repo's own build) and the local git commands (hooks) all run code
// this action did not write. None of it gets a token that can write to the repository:
// the push token goes ONLY to `git push` and `gh`, and only for that one process.

/** Exact variable names that carry a GitHub credential (compared case-insensitively). */
export const SECRET_ENV_NAMES = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);

/**
 * Prefixes removed wholesale: this action's own inputs (`BUMP_PR_TOKEN`,
 * `BUMP_REGISTRY_TOKEN`, …), the Actions runtime (`ACTIONS_RUNTIME_TOKEN`,
 * `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, cache/results URLs) and raw action inputs.
 */
export const SECRET_ENV_PREFIXES = ["BUMP_", "ACTIONS_", "INPUT_"];

/** Is this environment variable one a child process must not inherit? */
export function isSecretEnvName(name) {
  const upper = String(name).toUpperCase();
  return SECRET_ENV_NAMES.has(upper) || SECRET_ENV_PREFIXES.some((p) => upper.startsWith(p));
}

/** A copy of `env` without any credential-bearing variable. Never mutates `env`. */
export function scrubEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (v === undefined || isSecretEnvName(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Environment additions that authenticate ONE `git push` to `serverUrl` with `token`,
 * the way actions/checkout does it (an `http.<url>/.extraheader`), but per process
 * through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` — never written to
 * `.git/config` and never on a command line. Appends after any GIT_CONFIG_* already set.
 */
export function pushAuthEnv(baseEnv, token, serverUrl = "https://github.com") {
  if (!token) return {};
  const n = Number.parseInt(String(baseEnv?.GIT_CONFIG_COUNT ?? "0"), 10) || 0;
  const url = String(serverUrl || "https://github.com").replace(/\/+$/, "");
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: `http.${url}/.extraheader`,
    [`GIT_CONFIG_VALUE_${n}`]: `AUTHORIZATION: basic ${basic}`,
  };
}
