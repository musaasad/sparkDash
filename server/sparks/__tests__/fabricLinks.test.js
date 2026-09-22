/** fabricLinks is a READ-ONLY config passthrough, normalized + de-duplicated. */
import test from "node:test";
import assert from "node:assert/strict";
import { SparkRegistry } from "../SparkRegistry.js";

const r = Object.create(SparkRegistry.prototype);
const n = (partial) => r._normalizeConfig({ id: "s1", name: "S1", lanIp: "10.0.0.1", ...partial });

test("fabricLinks is absent-safe and passthrough by default", () => {
  assert.equal(n({}).fabricLinks, null);
  assert.equal(n({ fabricLinks: [] }).fabricLinks, null);
  assert.equal(n({ fabricLinks: "bogus" }).fabricLinks, null);
});

test("fabricLinks normalizes peer id, speed and medium (config-only)", () => {
  const links = n({ fabricLinks: [{ to: " s2 ", speedMbps: 200000 }, { to: "s3", medium: "cx7", speedMbps: "100000" }] }).fabricLinks;
  assert.deepEqual(links, [
    { to: "s2", speedMbps: 200000, medium: "fabric" },
    { to: "s3", speedMbps: 100000, medium: "cx7" },
  ]);
});

test("fabricLinks drops empty/duplicate peers and clamps bad speed", () => {
  const links = n({ fabricLinks: [{ to: "s2", speedMbps: 0 }, { to: "s2" }, { to: "" }, { to: "s3" }] }).fabricLinks;
  assert.deepEqual(links, [
    { to: "s2", speedMbps: null, medium: "fabric" },
    { to: "s3", speedMbps: null, medium: "fabric" },
  ]);
});
