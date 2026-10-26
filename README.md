# Repo Wrapped Bump

Bump **one internal package** across a repository — rewrite the version everywhere it is declared, refresh the lockfile, refuse duplicate copies, run **your own build**, and open a pull request. Dispatched from the **Packages** tab of [Repo Wrapped](https://repowrapped.com) with one click, or run by hand with `gh workflow run`.

It exists because the version that matters is not "latest on npm" but "does _this app_ still build on it". A lockfile bump that passes `tsc` and unit tests can still fail `next build` (two copies of a singleton, a changed export used only at build time), so the build is the default gate.

## Install

Add one workflow to the **consumer** repository:

```yaml
# .github/workflows/repo-wrapped-bump.yml
name: Repo Wrapped bump
on:
  workflow_dispatch:
    inputs:
      package: { required: true }
      version: { required: true }
      base: { required: false } # defaults to the repo's default branch
      request_id: { required: false } # Repo Wrapped tracking id
      singletons: { required: false } # the org's must-be-one-copy packages
permissions:
  contents: write
  pull-requests: write
  packages: read
jobs:
  bump:
    runs-on: ubuntu-latest
    steps:
      - uses: PouriaH/repo-wrapped-bump-action@v1
        with:
          package: ${{ inputs.package }}
          version: ${{ inputs.version }}
          base: ${{ inputs.base }}
          request-id: ${{ inputs.request_id }}
          singletons: ${{ inputs.singletons }}
          # Optional — see "CI on the PR" below
          pr-token: ${{ secrets.REPO_WRAPPED_BUMP_TOKEN }}
          registry-token: ${{ secrets.GITHUB_TOKEN }}
```

Repo Wrapped notices the file (`.github/workflows/repo-wrapped-bump.yml`) and marks the repo "bump-ready". The workflow **must have that name** — Repo Wrapped dispatches it by file name. Repo Wrapped passes your org's Package Map singletons as `singletons`; a workflow installed before that input existed still works (Repo Wrapped retries without it), but add the two `singletons` lines to have those duplicates refused too.

Run it yourself:

```bash
gh workflow run repo-wrapped-bump.yml -R acme/web -f package=@acme/ui -f version=1.4.0
```

## What it does

1. Checks out `base` (the default branch when empty). Detects the package manager from the lockfile (`pnpm-lock.yaml` → pnpm, `package-lock.json` → npm, `yarn.lock` → yarn, Berry included) and Node from `.nvmrc` / `.node-version` / `engines.node`, else 20.
2. **Registry auth.** If the package's scope maps to `npm.pkg.github.com` (from your `.npmrc` or a manifest's `publishConfig`), `registry-token` is written to the **runner's** `~/.npmrc` for the install only — never to the repository — and removed again (or the file restored) before the build runs.
3. **Rewrites specifiers, keeping the range prefix**: `^1.2.0` → `^1.4.0`, `~` stays `~`, an exact pin stays exact, `>=` stays `>=`. A bound that would exclude the new version (`<2.0.0`, `<=`, `>`) or a compound range (`>=1 <2`, `^1 || ^2`, `1.0.0 - 2.0.0`) becomes `^<version>`, and the PR says so. Every `package.json` that declares the package, in `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`. `workspace:` / `link:` / `file:` specifiers are in-repo links and are left alone. Formatting is preserved byte for byte. A pin in `overrides` / `resolutions` / `pnpm.overrides` is reported, not changed.
4. **Installs, refreshing the lockfile** (`pnpm install --no-frozen-lockfile`, `npm install`, `yarn install`) — once per lockfile directory, with the manager that wrote that lockfile.
5. **Duplicate check.** If the refreshed lockfile resolves the bumped package — or anything in `singletons` — at more than one version, the run fails and lists the versions.
6. **Verifies.** Runs `verify-command`, or by default `<pm> run build` if the root `package.json` has a `build` script, else `typecheck`, else `test`. If there is none, it says the bump was **not** verified (in the log, the summary and the PR).
7. **On success:** branch `repo-wrapped/bump-<pkg>-<version>`, commit `chore(deps): bump <pkg> to <version>`, then opens the PR — or **updates** it if one is already open for that branch (re-running is safe). Label `repo-wrapped:bump`. Only manifests and lockfiles are ever staged. The body ends with a marker Repo Wrapped uses to follow the request:

   ```
   <!-- repo-wrapped:bump pkg=@acme/ui ver=1.4.0 request=<id> -->
   ```

8. **On failure:** no PR by default; the job summary shows the failing step and the tail of its log. With `open-pr-on-failure: true` a **draft** PR labelled `repo-wrapped:bump-failed` is opened so the attempt is visible.

## Inputs

| Input                | Required | Default      | Meaning                                                                                                                        |
| -------------------- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `package`            | yes      |              | The package, e.g. `@acme/ui`. Validated as an npm package name.                                                                |
| `version`            | yes      |              | The version, e.g. `1.4.0` (a leading `v` is accepted). Validated as semver.                                                    |
| `base`               | no       | default      | Branch to bump against and open the PR into. Teams that promote `sandbox → dev → qa → main` set it to the first environment.   |
| `request-id`         | no       |              | Repo Wrapped's tracking id, embedded in the PR body.                                                                           |
| `verify-command`     | no       | build chain  | Command that proves the bump builds. Runs at the repository root, `CI=true`.                                                   |
| `singletons`         | no       |              | Extra packages (space/comma separated) that must resolve to one version. The bumped package is always checked.                 |
| `open-pr-on-failure` | no       | `false`      | Open a draft `repo-wrapped:bump-failed` PR when the bump does not pass.                                                        |
| `pr-token`           | no       |              | A fine-grained PAT or GitHub App token — see below.                                                                            |
| `registry-token`     | no       |              | Token for GitHub Packages, when the package lives on `npm.pkg.github.com`. `secrets.GITHUB_TOKEN` with `packages: read` works. |
| `dry-run`            | no       | `false`      | Do everything except push and open the PR.                                                                                     |
| `working-directory`  | no       | `.`          | Repository root, relative to the workspace.                                                                                    |
| `skip-checkout`      | no       | `false`      | Use the repository already in the workspace (this action's own CI).                                                            |

Outputs: `status` (`bumped` · `dry-run` · `nothing-to-do` · `failed`), `branch`, `pr-url`, `changed-files`.

## CI on the PR — read this

A pull request opened with the workflow's `GITHUB_TOKEN` **does not trigger other workflows** (GitHub's recursion guard), so your normal PR checks will not run on it. The bump is still verified inside the job, and the PR body says so. To get your normal checks, give the action a `pr-token`: a fine-grained personal access token or a GitHub App token with **Contents: read and write** and **Pull requests: read and write** on the repository. The branch is pushed and the PR opened as that identity.

## Triggering it from Repo Wrapped

The Packages tab dispatches this workflow with **your own** GitHub token (a fine-grained PAT you saved in Repo Wrapped's BYOK settings), so GitHub enforces _your_ permissions. The token needs **Actions: read and write** on the target repositories. Without one, the dialog gives you the `gh workflow run` commands to paste.

**Repo Wrapped's GitHub App stays read-only.** It never writes to your repositories; this action does, inside your repository, with your repository's token.

## Guarantees

- The registry token goes to the runner's user `~/.npmrc` for the install only, is masked in logs, and is never on a command line or in the repository.
- **No write token reaches your repository's code.** The checkout does not persist credentials; the install (dependency lifecycle scripts), the build and the local git commands run with `GH_TOKEN`, `GITHUB_TOKEN`, the action's own `BUMP_*` inputs and the `ACTIONS_*` runtime tokens removed from their environment. The push token is handed only to `git push` (a per-process auth header, `--no-verify`) and to `gh`.
- Only `package.json` files and lockfiles are staged. Nothing else the install or the build produced is committed.
- Inputs are validated before use (they arrive from whoever dispatched the workflow): an invalid package name, version or branch stops the run before anything is touched.
- Re-running with the same package and version updates the same branch and PR.

## Not covered

- npm ecosystem only (npm, pnpm, Yarn). Go and PyPI are not supported.
- "Latest" is whatever version you pass; Repo Wrapped suggests the producer's `package.json` version on its default branch, which can be ahead of what is published.
- One package per run.

## Development

```bash
npm test              # unit tests (node:test, no dependencies)
npm run e2e npm       # a real install + build against test/fixtures/npm (also: pnpm, yarn, npm-duplicate)
```

The fixtures use `is-odd` 2.x → 3.0.0 as a stand-in for an internal package, so they install from the public registry. `bumpRange` mirrors `src/lib/org/package-map.ts` in the Repo Wrapped app; keep them in step.

MIT licensed.
