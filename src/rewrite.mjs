// Rewrite a dependency's declared range in package.json text, keeping the range
// prefix (`^1.2.0` -> `^1.4.0`, `~` stays `~`, an exact pin stays exact) and the
// file's formatting byte-for-byte everywhere else.
//
// `bumpRange` is the same function the Repo Wrapped app uses to preview a bump
// (src/lib/org/package-map.ts `bumpRange`, ADR 039). Keep the two in step.

/** Specifiers that point at code in the same repo, not at a published version. */
const LOCAL = /^(?:workspace|link|file|portal|npm):/;

export const isLocalSpecifier = (range) => LOCAL.test(String(range).trim());

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** One comparator: an operator, then a full or partial (`1`, `1.x`) version. */
const COMPARATOR =
  /^(\^|~|>=|<=|>|<|=)?v?(\d+(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

/**
 * `range` rewritten to `version`. A caret, a tilde, `>=` and an exact pin keep their
 * form (`^1.2.0` -> `^1.4.0`, `1.2.0` stays exact). A strict or upper bound (`<`, `<=`,
 * `>`) and a compound range (`>=1 <2`, `^1 || ^2`, `1.0.0 - 2.0.0`) cannot keep their
 * form without excluding the target — `<2.0.0` bumped to 2.1.0 would become `<2.1.0` —
 * so they become `^<version>` (`bumpChangesForm` tells the PR). null for specifiers left
 * alone: workspace/link/file/npm:, dist-tags like `latest`, `*`, a lone partial version
 * (`1.x`, `^1`), git URLs.
 */
export function bumpRange(range, version) {
  const trimmed = String(range).trim();
  if (isLocalSpecifier(trimmed)) return null;
  if (!SEMVER.test(version)) return null;
  const tokens = trimmed
    .replace(/(\^|~|>=|<=|>|<|=)\s+/g, "$1")
    .replace(/\|\|/g, " || ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens.length === 1) {
    const m = COMPARATOR.exec(tokens[0]);
    if (!m) return null;
    const op = m[1] ?? "";
    if (op === "<" || op === "<=" || op === ">") return `^${version}`;
    if (!SEMVER.test(m[2])) return null;
    return `${op}${version}`;
  }
  if (!tokens.every((t) => t === "||" || t === "-" || COMPARATOR.test(t))) return null;
  return `^${version}`;
}

/** Did `bumpRange` have to change the range's form (to a caret) rather than keep it? */
export const bumpChangesForm = (range, next) =>
  String(next).startsWith("^") && !String(range).trim().startsWith("^");

export const DEP_BLOCKS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

// --- locating a JSON object value without re-serialising the file ------------------

/** Index just past the string literal that starts at `i` (text[i] === '"'). */
function skipString(text, i) {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === "\\") j += 2;
    else if (text[j] === '"') return j + 1;
    else j++;
  }
  return text.length;
}

/** `{start, end}` of the `{ ... }` value of a TOP-LEVEL key, or null. */
function findTopLevelObject(text, key) {
  let depth = 0;
  for (let i = 0; i < text.length; ) {
    const c = text[i];
    if (c === '"') {
      const end = skipString(text, i);
      if (depth === 1) {
        const name = text.slice(i + 1, end - 1);
        const rest = /^\s*:\s*/.exec(text.slice(end));
        if (name === key && rest) {
          const start = end + rest[0].length;
          if (text[start] !== "{") return null;
          let d = 0;
          for (let k = start; k < text.length; ) {
            if (text[k] === '"') k = skipString(text, k);
            else {
              if (text[k] === "{") d++;
              else if (text[k] === "}" && --d === 0) return { start, end: k + 1 };
              k++;
            }
          }
          return null;
        }
      }
      i = end;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    i++;
  }
  return null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Rewrite every declaration of `name` in the four dependency blocks of one
 * package.json to `version`.
 *
 * Returns `{ text, changes, skipped, notes, found }`: whether the package is declared at all, the new text (identical to the input
 * when nothing changed), what changed, what was left alone and why, and other places
 * the package is pinned (`overrides`, `resolutions`, `pnpm.overrides`) that a human
 * should look at.
 */
export function rewriteManifest(text, name, version) {
  let out = text;
  const changes = [];
  const skipped = [];
  const notes = [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, changes, skipped: [{ block: "(file)", range: "", reason: "not valid JSON" }], notes, found: false };
  }

  const found = DEP_BLOCKS.some((b) => typeof parsed?.[b]?.[name] === "string");
  for (const block of DEP_BLOCKS) {
    const declared = parsed?.[block]?.[name];
    if (typeof declared !== "string") continue;
    const next = bumpRange(declared, version);
    if (next === null) {
      skipped.push({
        block,
        range: declared,
        reason: isLocalSpecifier(declared)
          ? "in-repo link (workspace:/link:/file:), not a published version"
          : "range cannot be rewritten safely",
      });
      continue;
    }
    if (next === declared) continue; // already there

    const span = findTopLevelObject(out, block);
    if (!span) continue;
    const body = out.slice(span.start, span.end);
    const re = new RegExp(`("${escapeRe(JSON.stringify(name).slice(1, -1))}"\\s*:\\s*")((?:[^"\\\\]|\\\\.)*)(")`);
    if (!re.test(body)) continue;
    const replaced = body.replace(re, (_m, a, _old, c) => `${a}${next}${c}`);
    out = out.slice(0, span.start) + replaced + out.slice(span.end);
    changes.push({ block, from: declared, to: next });
    if (bumpChangesForm(declared, next)) {
      notes.push(`${block} declared "${declared}", which cannot keep its form without excluding ${version}; rewritten to "${next}"`);
    }
  }

  // The rewrite must leave valid JSON that says what we meant.
  if (changes.length > 0) {
    let check;
    try {
      check = JSON.parse(out);
    } catch {
      return { text, changes: [], skipped: [{ block: "(file)", range: "", reason: "rewrite produced invalid JSON; left unchanged" }], notes, found };
    }
    for (const c of changes) {
      if (check?.[c.block]?.[name] !== c.to) {
        return { text, changes: [], skipped: [{ block: c.block, range: c.from, reason: "rewrite did not take effect; left unchanged" }], notes, found };
      }
    }
  }

  // Pins elsewhere in the file: not ours to change, but the PR should say so.
  for (const [label, obj] of [
    ["overrides", parsed.overrides],
    ["resolutions", parsed.resolutions],
    ["pnpm.overrides", parsed.pnpm?.overrides],
  ]) {
    if (obj && typeof obj === "object" && name in obj) {
      notes.push(`${label} pins ${name} to "${obj[name]}" — left unchanged`);
    }
  }
  return { text: out, changes, skipped, notes, found };
}
