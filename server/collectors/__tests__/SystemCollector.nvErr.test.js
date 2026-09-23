import test from "node:test";
import assert from "node:assert/strict";
import { parseNvErrNoMemoryCount, SystemCollector } from "../SystemCollector.js";

test("parseNvErrNoMemoryCount reads grep -c output", () => {
  assert.equal(parseNvErrNoMemoryCount("12"), 12);
  assert.equal(parseNvErrNoMemoryCount("0"), 0);
  assert.equal(parseNvErrNoMemoryCount(" 43\n"), 43);
});

test("parseNvErrNoMemoryCount defaults invalid input to 0", () => {
  assert.equal(parseNvErrNoMemoryCount(""), 0);
  assert.equal(parseNvErrNoMemoryCount("not-a-number"), 0);
  assert.equal(parseNvErrNoMemoryCount(undefined), 0);
  assert.equal(parseNvErrNoMemoryCount("-3"), 0);
});

/** Collector whose journal command is stubbed (hermetic, no real journalctl). */
function stubCollector(initialOut) {
  const c = new SystemCollector({ id: "n1", isLocal: true });
  c._hasHostProc = () => false;
  let out = initialOut;
  c._exec = async () => out;
  return {
    c,
    setOut(next) {
      out = next;
      c._nvErrCache.at = 0; // force the next poll to be a FRESH sample
    },
  };
}

test("_nvErrNoMemoryStats: first sample seeds, no fabricated recent alert", async () => {
  const s = stubCollector("14");
  const first = await s.c._nvErrNoMemoryStats();
  assert.equal(first.count, 14);
  assert.equal(first.recent, 0, "since-boot history on first sight is not 'recent'");
});

test("_nvErrNoMemoryStats: a genuine increase emits the delta", async () => {
  const s = stubCollector("14");
  await s.c._nvErrNoMemoryStats(); // seed
  s.setOut("15");
  const next = await s.c._nvErrNoMemoryStats();
  assert.equal(next.count, 15);
  assert.equal(next.recent, 1);
});

test("_nvErrNoMemoryStats: unchanged cumulative emits recent 0", async () => {
  const s = stubCollector("14");
  await s.c._nvErrNoMemoryStats();
  s.setOut("14");
  const next = await s.c._nvErrNoMemoryStats();
  assert.equal(next.recent, 0);
});

test("_nvErrNoMemoryStats: reboot (count drops) emits recent 0 and re-seeds", async () => {
  const s = stubCollector("14");
  await s.c._nvErrNoMemoryStats();
  s.setOut("2");
  const next = await s.c._nvErrNoMemoryStats();
  assert.equal(next.count, 2);
  assert.equal(next.recent, 0);
  s.setOut("3");
  const after = await s.c._nvErrNoMemoryStats();
  assert.equal(after.recent, 1);
});
