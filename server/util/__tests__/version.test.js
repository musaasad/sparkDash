import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectVersion } from "../../version.js";

test("inspectVersion reports app identity + mode + commit shape", () => {
  const v = inspectVersion();
  assert.equal(v.app, "sparkDash");
  assert.ok(typeof v.mode === "string" && v.mode.length > 0);
  assert.ok(v.commit === null || /^[0-9a-f]{7,40}$/.test(v.commit));
  assert.equal(v.shortCommit, v.commit ? v.commit.slice(0, 7) : null);
  assert.ok(typeof v.uptimeSeconds === "number" && v.uptimeSeconds >= 0);
});

test("inspectVersion marks a baked image build when GIT_COMMIT is set", () => {
  const prev = process.env.GIT_COMMIT;
  process.env.GIT_COMMIT = "96a500c111111111111111111111111111111111";
  try {
    const v = inspectVersion();
    assert.equal(v.imageBuild, true);
    assert.equal(v.mode, "production");
    assert.equal(v.shortCommit, "96a500c");
  } finally {
    if (prev === undefined) delete process.env.GIT_COMMIT;
    else process.env.GIT_COMMIT = prev;
  }
});