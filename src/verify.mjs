// What to run to prove the bump builds. A full BUILD is the default on purpose: it
// catches what `tsc` and unit tests do not (two copies of a singleton, a changed
// export used only at build time). The chain is build -> typecheck -> test; if the
// repo has none of them there is nothing to run and we say so.

export const DEFAULT_VERIFY_CHAIN = ["build", "typecheck", "test"];

/**
 * @param {{ override?: string, scripts?: Record<string,string>, pm: "pnpm"|"npm"|"yarn" }} input
 * @returns {{ command: string|null, label: string, warning?: string }}
 */
export function chooseVerifyCommand({ override, scripts = {}, pm }) {
  const custom = String(override ?? "").trim();
  if (custom) return { command: custom, label: custom };
  for (const name of DEFAULT_VERIFY_CHAIN) {
    if (typeof scripts[name] === "string" && scripts[name].trim()) {
      return { command: `${pm} run ${name}`, label: `${pm} run ${name}` };
    }
  }
  return {
    command: null,
    label: "(none)",
    warning:
      'No "build", "typecheck" or "test" script in package.json and no verify-command given — the bump was NOT verified.',
  };
}

/** The install command that REFRESHES the lockfile (never a frozen/ci install). */
export function installCommand(pm, { yarnBerry = false } = {}) {
  if (pm === "pnpm") return ["pnpm", ["install", "--no-frozen-lockfile"]];
  if (pm === "yarn") return yarnBerry ? ["yarn", ["install", "--no-immutable"]] : ["yarn", ["install"]];
  return ["npm", ["install"]];
}
