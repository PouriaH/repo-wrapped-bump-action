// The real process runner. Streams output to the job log while keeping a bounded
// capture, so a failure can show its tail in the summary and the PR.

import { spawn } from "node:child_process";

const MAX_CAPTURE = 256 * 1024;

/**
 * On Windows npm, pnpm and yarn are `.cmd` shims, which only a shell can start. git, gh and
 * node are real executables and must NOT go through a shell: it would re-split their
 * arguments (a commit message with spaces). POSIX never needs one.
 */
const WINDOWS_SHIMS = new Set(["npm", "npx", "pnpm", "yarn", "corepack"]);
export const needsShell = (cmd) => process.platform === "win32" && WINDOWS_SHIMS.has(String(cmd).toLowerCase());

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string,string|undefined>, shell?: boolean, stream?: boolean }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, output: string }>}
 */
export function execReal(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: opts.shell ?? needsShell(cmd),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let output = "";
    const keep = (prev, chunk) => (prev + chunk).slice(-MAX_CAPTURE);
    child.stdout.on("data", (b) => {
      const s = b.toString("utf8");
      stdout = keep(stdout, s);
      output = keep(output, s);
      if (opts.stream !== false) process.stdout.write(s);
    });
    child.stderr.on("data", (b) => {
      const s = b.toString("utf8");
      stderr = keep(stderr, s);
      output = keep(output, s);
      if (opts.stream !== false) process.stderr.write(s);
    });
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: `${stderr}${err.message}`, output: `${output}${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr, output }));
  });
}

/** The last `n` non-empty lines of some output. */
export function tail(text, n = 60) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(-n)
    .join("\n");
}
