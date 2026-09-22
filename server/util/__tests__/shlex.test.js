import test from "node:test";
import assert from "node:assert/strict";
import { shlexQuote, shlexJoin, isShlexSafe } from "../shlex.js";

test("shlexQuote leaves safe tokens bare", () => {
  assert.equal(shlexQuote("/home/musaasad/models/Qwen3.8-Flash-Next-EXL3"), "/home/musaasad/models/Qwen3.8-Flash-Next-EXL3");
  assert.equal(shlexQuote("5-9,15-19"), "5-9,15-19");
  assert.ok(isShlexSafe("abc"));
});

test("shlexQuote neutralizes hostile path interpolation", () => {
  const evil = "/x'; rm -rf / #";
  const quoted = shlexQuote(evil);
  // The whole value must be wrapped in single quotes with the inner quote
  // escaped via the '\'' idiom — nothing left shell-live.
  assert.equal(quoted, `'/x'\\''; rm -rf / #'`);
  // A shell-safe bare token would be returned untouched; this one is not.
  assert.notEqual(quoted, evil);
});

test("shlexQuote escapes embedded single quotes with the '\\'' idiom", () => {
  assert.equal(shlexQuote("it's"), `'it'\\''s'`);
});

test("shlexQuote quotes command substitution and backticks", () => {
  const q = shlexQuote("$(whoami)`id`");
  assert.ok(q.startsWith("'"));
  assert.ok(q.includes("$(whoami)")); // literal, not expanded
});

test("shlexQuote empty string becomes ''", () => {
  assert.equal(shlexQuote(""), "''");
});

test("shlexQuote rejects non-strings", () => {
  assert.throws(() => shlexQuote(42), TypeError);
  assert.throws(() => shlexQuote(null), TypeError);
});

test("shlexJoin quotes and joins", () => {
  assert.equal(shlexJoin(["echo", "hello world"]), "echo 'hello world'");
});

test("leading-dash token is quoted (option-injection guard)", () => {
  assert.ok(shlexQuote("-rf").startsWith("'"));
  assert.ok(!isShlexSafe("-rf"));
});