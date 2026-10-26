import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSecretEnvName, pushAuthEnv, scrubEnv } from "../../src/env.mjs";

describe("scrubEnv — what repo code may see", () => {
  it("drops every GitHub credential, the action's own inputs and the Actions runtime", () => {
    const env = {
      PATH: "/bin",
      HOME: "/home/runner",
      CI: "true",
      GITHUB_WORKSPACE: "/w",
      GITHUB_REPOSITORY: "acme/app",
      RUNNER_TEMP: "/t",
      NODE_AUTH_TOKEN: "the user's own registry auth",
      GH_TOKEN: "x",
      GITHUB_TOKEN: "x",
      GH_ENTERPRISE_TOKEN: "x",
      BUMP_PR_TOKEN: "x",
      BUMP_REGISTRY_TOKEN: "x",
      BUMP_PACKAGE: "@acme/ui",
      ACTIONS_RUNTIME_TOKEN: "x",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "x",
      ACTIONS_ID_TOKEN_REQUEST_URL: "x",
      ACTIONS_CACHE_URL: "x",
      ACTIONS_RESULTS_URL: "x",
      INPUT_PR_TOKEN: "x",
      gh_token: "lower-case on Windows",
    };
    assert.deepEqual(scrubEnv(env), {
      PATH: "/bin",
      HOME: "/home/runner",
      CI: "true",
      GITHUB_WORKSPACE: "/w",
      GITHUB_REPOSITORY: "acme/app",
      RUNNER_TEMP: "/t",
      NODE_AUTH_TOKEN: "the user's own registry auth",
    });
    assert.equal(env.GH_TOKEN, "x", "never mutates its input");
  });
  it("isSecretEnvName", () => {
    for (const n of ["GH_TOKEN", "github_token", "BUMP_PR_TOKEN", "ACTIONS_RUNTIME_TOKEN"]) assert.equal(isSecretEnvName(n), true, n);
    for (const n of ["PATH", "GITHUB_SHA", "NPM_CONFIG_USERCONFIG", "NODE_AUTH_TOKEN"]) assert.equal(isSecretEnvName(n), false, n);
  });
  it("tolerates undefined values and a missing env", () => {
    assert.deepEqual(scrubEnv({ A: undefined, B: "1" }), { B: "1" });
    assert.deepEqual(scrubEnv(undefined), {});
  });
});

describe("pushAuthEnv — the token for one git push", () => {
  it("is an http extraheader for the server, set through GIT_CONFIG_*", () => {
    assert.deepEqual(pushAuthEnv({}, "tok", "https://github.com/"), {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from("x-access-token:tok").toString("base64")}`,
    });
  });
  it("appends after GIT_CONFIG_* the environment already carries", () => {
    const out = pushAuthEnv({ GIT_CONFIG_COUNT: "2" }, "tok", "https://ghe.example.com");
    assert.equal(out.GIT_CONFIG_COUNT, "3");
    assert.equal(out.GIT_CONFIG_KEY_2, "http.https://ghe.example.com/.extraheader");
  });
  it("adds nothing without a token", () => {
    assert.deepEqual(pushAuthEnv({}, ""), {});
  });
});
