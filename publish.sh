#!/usr/bin/env bash
# One-command publish of the Bump Action to its own public repo (the Marketplace
# requires action.yml at a repo ROOT). NOT run by the build that created it — review,
# then run it yourself once you are ready to publish.
#
# Requires: gh CLI authenticated as the owner (`gh auth login`), git.
# Usage:    ./publish.sh [owner] [repo]      (default: PouriaH repo-wrapped-bump-action)
#
# Creates the public repo, pushes main, tags v1.0.0 + the floating v1. After it
# finishes, ONE manual step remains (GitHub UI only): draft a release for v1.0.0 and
# tick "Publish this Action to the GitHub Marketplace".
set -euo pipefail

OWNER="${1:-PouriaH}"
REPO="${2:-repo-wrapped-bump-action}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Gate on the tests: never publish something that does not pass.
npm test

if gh repo view "$OWNER/$REPO" >/dev/null 2>&1; then
  echo "-> $OWNER/$REPO already exists — pushing current contents."
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$OWNER/$REPO.git"
  git push origin main
else
  gh repo create "$OWNER/$REPO" --public --source . --remote origin --push \
    --description "Bump one internal package across a repo, build-verified, as a PR — dispatched from Repo Wrapped's Package Map"
fi

git tag -f v1.0.0
git tag -f v1
git push -f origin v1.0.0 v1
echo "Now draft the v1.0.0 release and tick 'Publish this Action to the GitHub Marketplace':"
echo "  https://github.com/$OWNER/$REPO/releases/new?tag=v1.0.0"
