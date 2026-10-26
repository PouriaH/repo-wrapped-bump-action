// Branch, commit and pull-request text. The body ends with a machine-readable marker
// that Repo Wrapped matches on to track the request (ADR 039):
//
//   <!-- repo-wrapped:bump pkg=<name> ver=<version> request=<id> -->

export const LABEL_BUMP = "repo-wrapped:bump";
export const LABEL_FAILED = "repo-wrapped:bump-failed";
export const BRANCH_PREFIX = "repo-wrapped/bump-";

/** `@acme/ui` -> `acme-ui`: safe in a branch name. */
export function slug(pkgName) {
  return String(pkgName)
    .replace(/^@/, "")
    .replace(/\//g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

export const branchName = (pkg, version) =>
  `${BRANCH_PREFIX}${slug(pkg)}-${String(version).replace(/[^A-Za-z0-9._-]+/g, "-")}`;

export const commitMessage = (pkg, version) => `chore(deps): bump ${pkg} to ${version}`;

/** One-line, comment-safe request id. */
const cleanId = (id) =>
  String(id ?? "")
    .replace(/[^A-Za-z0-9._:-]/g, "")
    .replace(/-{2,}/g, "-"); // never `--`: it would be a malformed HTML comment

export function marker({ pkg, version, requestId }) {
  return `<!-- repo-wrapped:bump pkg=${pkg} ver=${version} request=${cleanId(requestId)} -->`;
}

/** Read a marker back out of a PR body (the app does the same). */
export function parseMarker(body) {
  const m = /<!--\s*repo-wrapped:bump\s+pkg=(\S+)\s+ver=(\S+)\s+request=(\S*)\s*-->/.exec(String(body ?? ""));
  return m ? { pkg: m[1], version: m[2], requestId: m[3] } : null;
}

/**
 * @param {{
 *   pkg: string, version: string, requestId?: string, base: string,
 *   changes: Array<{file: string, from: string, to: string, block: string}>,
 *   notes?: string[], skipped?: string[],
 *   verify: { label: string, ran: boolean, warning?: string },
 *   ciNote: boolean, failure?: { step: string, message: string, tail?: string } | null,
 * }} input
 */
export function prBody(input) {
  const lines = [];
  if (input.failure) {
    lines.push(
      `**This bump did not pass.** It failed at *${input.failure.step}*: ${input.failure.message}`,
      "",
    );
    if (input.failure.tail) lines.push("<details><summary>Log tail</summary>", "", "```", input.failure.tail, "```", "", "</details>", "");
  }
  lines.push(`Bumps \`${input.pkg}\` to \`${input.version}\` (base: \`${input.base}\`).`, "");
  lines.push("| Manifest | Block | From | To |", "| --- | --- | --- | --- |");
  for (const c of input.changes) lines.push(`| \`${c.file}\` | ${c.block} | \`${c.from}\` | \`${c.to}\` |`);
  lines.push("");
  if (input.verify.ran) {
    lines.push(`Verified in the job with \`${input.verify.label}\`${input.failure ? "" : " — passed"}.`, "");
  } else if (input.verify.warning) {
    lines.push(`> ⚠ ${input.verify.warning}`, "");
  }
  for (const n of input.notes ?? []) lines.push(`- ${n}`);
  if ((input.notes ?? []).length) lines.push("");
  for (const s of input.skipped ?? []) lines.push(`- Left alone: ${s}`);
  if ((input.skipped ?? []).length) lines.push("");
  if (input.ciNote) {
    lines.push(
      "> **Your CI checks may not have run on this PR.** It was opened with the workflow's `GITHUB_TOKEN`, and GitHub does not start other workflows from a `GITHUB_TOKEN` push. The bump was verified inside the job (above); to run your normal PR checks, give the Action a `pr-token` (a fine-grained PAT or GitHub App token with contents + pull-requests write), or close and reopen this PR.",
      "",
    );
  }
  lines.push(marker(input), "");
  return lines.join("\n");
}
