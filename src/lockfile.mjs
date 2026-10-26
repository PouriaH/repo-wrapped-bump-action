// Resolved versions of named packages in a lockfile — enough to answer "does this
// lockfile carry two copies of X?" after a bump. Three formats, the same three the
// Repo Wrapped app reads (src/lib/native-scan/lockfiles/npm.ts): package-lock.json,
// pnpm-lock.yaml and yarn.lock (classic and Berry).
//
// Best-effort and PURE: text in, `Map<name, Set<version>>` out; text that does not
// parse yields an empty map, never an exception.

/** Strip a pnpm peer-dependency suffix: `1.2.3(react@18)` / `1.2.3_react@18`. */
function cleanPnpmVersion(v) {
  return v.replace(/\(.*$/, "").replace(/_.*$/, "");
}

function add(map, name, version) {
  if (!name || !version) return;
  const set = map.get(name) ?? new Set();
  set.add(version);
  map.set(name, set);
}

function splitAt(key) {
  // `@scope/name@1.2.3` and `name@1.2.3`: the version follows the LAST-needed `@`.
  const at = key.startsWith("@") ? key.indexOf("@", 1) : key.indexOf("@");
  return at > 0 ? [key.slice(0, at), key.slice(at + 1)] : [null, null];
}

export function parsePackageLock(text, wanted) {
  const out = new Map();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return out;
  }
  const want = (n) => !wanted || wanted.has(n);
  if (json?.packages && typeof json.packages === "object") {
    for (const [key, pkg] of Object.entries(json.packages)) {
      if (!key || pkg?.link) continue;
      const i = key.lastIndexOf("node_modules/");
      if (i < 0) continue;
      const name = key.slice(i + "node_modules/".length);
      if (want(name) && typeof pkg?.version === "string") add(out, name, pkg.version);
    }
  } else if (json?.dependencies && typeof json.dependencies === "object") {
    // lockfileVersion 1: a nested tree
    const walk = (deps) => {
      for (const [name, d] of Object.entries(deps ?? {})) {
        if (want(name) && typeof d?.version === "string") add(out, name, d.version);
        if (d?.dependencies) walk(d.dependencies);
      }
    };
    walk(json.dependencies);
  }
  return out;
}

export function parsePnpmLock(text, wanted) {
  const out = new Map();
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (line.length > 0 && !line.startsWith(" ")) {
      inPackages = false;
      continue;
    }
    const m = /^ {2}(\S.*):\s*$/.exec(line);
    if (!m) continue;
    let key = m[1].trim().replace(/^['"]|['"]$/g, "");
    if (key.startsWith("/")) key = key.slice(1);
    key = key.replace(/\(.*$/, ""); // v9 peer suffix on the key
    let name;
    let version;
    [name, version] = splitAt(key);
    if (!name) {
      // pnpm v5: `/name/1.2.3` or `/@scope/name/1.2.3`
      const slash = key.lastIndexOf("/");
      if (slash > 0) {
        name = key.slice(0, slash);
        version = key.slice(slash + 1);
      }
    }
    if (name && (!wanted || wanted.has(name))) add(out, name, cleanPnpmVersion(version));
  }
  return out;
}

export function parseYarnLock(text, wanted) {
  const out = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith(" ") || line.startsWith("#") || !line.trimEnd().endsWith(":")) continue;
    const specs = line
      .trimEnd()
      .slice(0, -1)
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""));
    const [name] = splitAt(specs[0] ?? "");
    let version = null;
    for (let j = i + 1; j < lines.length && lines[j].startsWith(" "); j++) {
      const m = /^\s+version:?\s+"?([^"\s]+)"?/.exec(lines[j]);
      if (m) {
        version = m[1];
        break;
      }
    }
    if (name && version && (!wanted || wanted.has(name))) add(out, name, version);
  }
  return out;
}

/** Pick the parser by lockfile name. */
export function parseLockfile(fileName, text, wanted) {
  const base = fileName.slice(fileName.lastIndexOf("/") + 1);
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") return parsePackageLock(text, wanted);
  if (base === "pnpm-lock.yaml") return parsePnpmLock(text, wanted);
  if (base === "yarn.lock") return parseYarnLock(text, wanted);
  return new Map();
}

/** Names resolved at more than one version, as `[{ name, versions }]` sorted by name. */
export function findDuplicates(resolved) {
  return [...resolved.entries()]
    .filter(([, versions]) => versions.size > 1)
    .map(([name, versions]) => ({ name, versions: [...versions].sort(compareVersions) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Semver precedence, enough to list versions oldest first (a release outranks its pre-releases). */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v));
    return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : null } : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return pa ? -1 : pb ? 1 : String(a).localeCompare(String(b));
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
