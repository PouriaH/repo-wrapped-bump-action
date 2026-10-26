import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bumpRange, isLocalSpecifier, rewriteManifest } from "../../src/rewrite.mjs";

describe("bumpRange — the range prefix survives", () => {
  const table = [
    ["^1.2.0", "1.4.0", "^1.4.0"],
    ["~1.2.0", "1.4.0", "~1.4.0"],
    ["1.2.0", "1.4.0", "1.4.0"],
    ["=1.2.0", "1.4.0", "=1.4.0"],
    [">=1.2.0", "2.0.0", ">=2.0.0"],
    ["<=1.2.0", "1.4.0", "<=1.4.0"],
    ["^1.2.0-beta.1", "1.4.0", "^1.4.0"],
    ["v1.2.0", "1.4.0", "1.4.0"],
    ["^1.2.0", "2.0.0-rc.1", "^2.0.0-rc.1"],
    ["^ 1.2.0", "1.4.0", "^1.4.0"],
  ];
  for (const [range, version, expected] of table) {
    it(`${range} + ${version} = ${expected}`, () => assert.equal(bumpRange(range, version), expected));
  }
  it("leaves what it cannot rewrite safely alone", () => {
    for (const r of ["workspace:*", "workspace:^", "link:../x", "file:../x", "portal:../x", "npm:other@^1", "latest", "*", "^1 || ^2", ">=1 <2", "1.x", "github:a/b", "^1.2", ""]) {
      assert.equal(bumpRange(r, "1.4.0"), null, JSON.stringify(r));
    }
    assert.equal(bumpRange("^1.0.0", "1.4"), null);
    assert.equal(bumpRange("^1.0.0", "latest"), null);
  });
  it("isLocalSpecifier", () => {
    assert.equal(isLocalSpecifier("workspace:*"), true);
    assert.equal(isLocalSpecifier("^1.0.0"), false);
  });
});

describe("rewriteManifest", () => {
  const pkg = (deps, extra = "") => `{\n  "name": "app",\n  "version": "1.0.0",${extra}\n  "dependencies": ${deps}\n}\n`;

  it("changes only the value, keeping every other byte", () => {
    const before = pkg('{\n    "@acme/ui": "^1.2.0",\n    "left-pad": "^1.3.0"\n  }');
    const r = rewriteManifest(before, "@acme/ui", "1.4.0");
    assert.equal(r.text, before.replace('"^1.2.0"', '"^1.4.0"'));
    assert.deepEqual(r.changes, [{ block: "dependencies", from: "^1.2.0", to: "^1.4.0" }]);
    assert.equal(r.found, true);
  });

  it("rewrites every block that declares it, each with its own prefix", () => {
    const text = JSON.stringify(
      {
        dependencies: { "@acme/ui": "^1.0.0" },
        devDependencies: { "@acme/ui": "~1.0.0" },
        peerDependencies: { "@acme/ui": ">=1.0.0" },
        optionalDependencies: { "@acme/ui": "1.0.0" },
      },
      null,
      2,
    );
    const r = rewriteManifest(text, "@acme/ui", "1.4.0");
    const out = JSON.parse(r.text);
    assert.equal(out.dependencies["@acme/ui"], "^1.4.0");
    assert.equal(out.devDependencies["@acme/ui"], "~1.4.0");
    assert.equal(out.peerDependencies["@acme/ui"], ">=1.4.0");
    assert.equal(out.optionalDependencies["@acme/ui"], "1.4.0");
    assert.equal(r.changes.length, 4);
  });

  it("skips workspace: specifiers and says why", () => {
    const text = pkg('{\n    "@acme/ui": "workspace:*"\n  }');
    const r = rewriteManifest(text, "@acme/ui", "1.4.0");
    assert.equal(r.text, text);
    assert.deepEqual(r.changes, []);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].reason, /in-repo link/);
    assert.equal(r.found, true);
  });

  it("preserves tabs, CRLF, a missing final newline and compact arrays", () => {
    const text = '{\r\n\t"files": ["dist"],\r\n\t"dependencies": {\r\n\t\t"@acme/ui": "^1.0.0"\r\n\t}\r\n}';
    const r = rewriteManifest(text, "@acme/ui", "1.4.0");
    assert.equal(r.text, text.replace("^1.0.0", "^1.4.0"));
  });

  it("works on a minified single-line file", () => {
    const text = '{"name":"a","dependencies":{"@acme/ui":"^1.0.0","x":"1"}}';
    assert.equal(rewriteManifest(text, "@acme/ui", "2.0.0").text, '{"name":"a","dependencies":{"@acme/ui":"^2.0.0","x":"1"}}');
  });

  it("does not touch the same name elsewhere in the file", () => {
    const text = JSON.stringify(
      {
        name: "app",
        description: 'uses "@acme/ui": "^1.0.0" in docs',
        scripts: { build: "echo @acme/ui" },
        dependencies: { "@acme/ui": "^1.0.0" },
        config: { "@acme/ui": "^1.0.0" },
      },
      null,
      2,
    );
    const out = JSON.parse(rewriteManifest(text, "@acme/ui", "1.4.0").text);
    assert.equal(out.dependencies["@acme/ui"], "^1.4.0");
    assert.equal(out.description, 'uses "@acme/ui": "^1.0.0" in docs');
    assert.equal(out.config["@acme/ui"], "^1.0.0");
  });

  it("does not confuse a package with a longer name sharing its prefix", () => {
    const text = pkg('{\n    "@acme/ui-forms": "^1.0.0",\n    "@acme/ui": "^1.0.0"\n  }');
    const out = JSON.parse(rewriteManifest(text, "@acme/ui", "1.4.0").text);
    assert.equal(out.dependencies["@acme/ui-forms"], "^1.0.0");
    assert.equal(out.dependencies["@acme/ui"], "^1.4.0");
  });

  it("an unscoped name with regex characters is matched literally", () => {
    const text = pkg('{\n    "lodash.merge": "^4.0.0",\n    "lodashXmerge": "^1.0.0"\n  }');
    const out = JSON.parse(rewriteManifest(text, "lodash.merge", "4.6.2").text);
    assert.equal(out.dependencies["lodash.merge"], "^4.6.2");
    assert.equal(out.dependencies["lodashXmerge"], "^1.0.0");
  });

  it("is a no-op when the range is already there, or the package is absent", () => {
    const text = pkg('{\n    "@acme/ui": "^1.4.0"\n  }');
    const same = rewriteManifest(text, "@acme/ui", "1.4.0");
    assert.equal(same.text, text);
    assert.deepEqual(same.changes, []);
    assert.equal(same.found, true);
    const absent = rewriteManifest(text, "@acme/other", "1.4.0");
    assert.equal(absent.found, false);
    assert.equal(absent.text, text);
  });

  it("reports overrides / resolutions / pnpm.overrides pins without changing them", () => {
    const text = JSON.stringify(
      {
        dependencies: { "@acme/ui": "^1.0.0" },
        overrides: { "@acme/ui": "1.0.0" },
        resolutions: { "@acme/ui": "1.0.0" },
        pnpm: { overrides: { "@acme/ui": "1.0.0" } },
      },
      null,
      2,
    );
    const r = rewriteManifest(text, "@acme/ui", "1.4.0");
    assert.equal(r.notes.length, 3);
    const out = JSON.parse(r.text);
    assert.equal(out.overrides["@acme/ui"], "1.0.0");
    assert.equal(out.pnpm.overrides["@acme/ui"], "1.0.0");
    assert.equal(out.dependencies["@acme/ui"], "^1.4.0");
  });

  it("leaves a file that is not JSON alone", () => {
    const r = rewriteManifest("{ not json", "@acme/ui", "1.4.0");
    assert.equal(r.text, "{ not json");
    assert.equal(r.found, false);
    assert.equal(r.skipped.length, 1);
  });

  it("handles an escaped character in a neighbouring string", () => {
    const text = '{"description":"say \\"hi\\" {","dependencies":{"@acme/ui":"^1.0.0"}}';
    const r = rewriteManifest(text, "@acme/ui", "1.4.0");
    assert.equal(JSON.parse(r.text).dependencies["@acme/ui"], "^1.4.0");
    assert.equal(JSON.parse(r.text).description, 'say "hi" {');
  });
});
