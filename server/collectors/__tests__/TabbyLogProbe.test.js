/**
 * TabbyAPI READ-ONLY log-tail metrics.
 *
 * The fork exposes NO HTTP metrics endpoint, so these fixtures are the ONLY
 * real source. Golden rule: real numbers from TabbyAPI's own log, labelled
 * with provenance + timestamp; missing/unparseable => null => "—", never 0.
 *
 * Hermetic: fixture text + injected fake SSH executor, no real network.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  parseTabbyLog,
  parseTabbyLogLine,
  parseCompletionLine,
  parseStartLine,
  applyTabbyLog,
  TabbyLogProbe,
  TABBY_LOG_DEFAULT_DIR,
} from "../TabbyLogProbe.js";

const COMPLETION =
  "2026-09-23 08:43:06.141 | INFO     | #67897 chat/completions (stream): 1,893 tokens generated at 59.9 T/s · prompt 191,844 tokens, 99% cached, 2,660 new in 6.33 s (420 T/s) · first token 6.34 s, total 37.9 s · draft 1269/2077 accepted (61%)";

// Real START line: the prompt-token count is followed by the word "prompt"
// before "tokens" (`191,844 prompt tokens ·`). Fixtures MUST match the live
// format — a fixture that omits "prompt" silently hides a START_RE regression.
const START =
  "2026-09-23 08:43:00.000 | INFO     | #67897 chat/completions (stream): 191,844 prompt tokens · temperature: 0.8 (preset), top_k: 40 (preset), top_p: 0.95 (preset), min_p: 0.05 (preset), max_tokens: 32768 (req)";

const START_OPEN =
  "2026-09-23 08:43:10.500 | INFO     | #67898 chat/completions (stream): 12,000 prompt tokens · temperature: 0.8 (preset)";

test("parseCompletionLine extracts every metric exactly (commas + U+00B7)", () => {
  const c = parseCompletionLine(COMPLETION);
  assert.ok(c, "completion line must parse");
  assert.equal(c.id, 67897);
  assert.equal(c.genTps, 59.9);
  assert.equal(c.promptTokens, 191844);
  assert.equal(c.cachedPct, 99);
  assert.equal(c.newTokens, 2660);
  assert.equal(c.prefillTps, 420);
  assert.equal(c.ttftSeconds, 6.34);
  assert.equal(c.totalSeconds, 37.9);
  assert.equal(c.draftAccepted, 1269);
  assert.equal(c.draftTotal, 2077);
  assert.equal(Number.isFinite(c.tsMs), true);
});

test("draft segment is OPTIONAL (some lines lack it)", () => {
  const line = COMPLETION.replace(/ · draft 1269\/2077 accepted \(61%\)$/, "");
  const c = parseCompletionLine(line);
  assert.ok(c);
  assert.equal(c.genTps, 59.9);
  assert.equal(c.draftAccepted, null);
  assert.equal(c.draftTotal, null);
});

// Regression: the live START line reads "191,844 prompt tokens ·" (the word
// "prompt" sits between the count and "tokens"). An earlier START_RE required
// the number to be immediately followed by "tokens" and so NEVER matched real
// START lines => active/BUSY never fired in production. Guard the real format.
test("parseStartLine matches the REAL 'N prompt tokens ·' format", () => {
  const s = parseStartLine(START);
  assert.ok(s, "real START line must parse");
  assert.equal(s.id, 67897);
  assert.equal(Number.isFinite(s.tsMs), true);
});

// Regression: TabbyAPI logs an EMPTY cache as "none cached", not "0% cached".
// An earlier COMPLETION_RE required `N% cached` and so failed on those lines,
// leaving the request unmatched => it looked permanently in-flight => false
// BUSY. A "none cached" completion must parse with cachedPct 0 and mark done.
test("parseCompletionLine accepts 'none cached' (empty cache) as 0%", () => {
  const line =
    "2026-09-23 09:17:03.864 | INFO     | #69978 chat/completions (stream): 5,535 tokens generated at 69.9 T/s · prompt 156,066 tokens, none cached, 156,066 new in 262.6 s (594 T/s) · first token 262.6 s, total 341.8 s · draft 4124/5942 accepted (69%)";
  const c = parseCompletionLine(line);
  assert.ok(c, "'none cached' completion must parse");
  assert.equal(c.id, 69978);
  assert.equal(c.cachedPct, 0);
  assert.equal(c.promptTokens, 156066);
  assert.equal(c.newTokens, 156066);
  assert.equal(c.genTps, 69.9);
  // A START whose (none-cached) completion is present must NOT be active.
  const open =
    "2026-09-23 09:11:22.042 | INFO     | #69978 chat/completions (stream): 156,066 prompt tokens · temperature: 0.8 (preset), max_tokens: 32768 (req)";
  const out = parseTabbyLog([open, line].join("\n"));
  assert.equal(out.active, false, "completed (none-cached) request is not in-flight");
  assert.deepEqual(out.activeIds, []);
});

test("parseTabbyLog: a START id with no COMPLETION => active=true", () => {
  const out = parseTabbyLog([START, START_OPEN].join("\n"));
  assert.equal(out.active, true);
  assert.deepEqual(out.activeIds, [67897, 67898]);
  assert.equal(out.lastRequest, null);
});

test("parseTabbyLog: a matched START+COMPLETION is not active; lastRequest is real", () => {
  const out = parseTabbyLog([START, COMPLETION].join("\n"));
  assert.equal(out.active, false);
  assert.deepEqual(out.activeIds, []);
  assert.equal(out.lastRequest.genTps, 59.9);
  assert.equal(out.lastRequestAtMs, out.lastRequest.tsMs);
});

test("parseTabbyLog: window avg/peak over completions", () => {
  const a = COMPLETION.replace("59.9 T/s", "50 T/s");
  const out = parseTabbyLog([a, COMPLETION].join("\n"));
  assert.equal(out.peakTps, 59.9);
  assert.equal(out.windowAvgTps, 54.95);
});

test("malformed / empty line => null (no throw, no 0)", () => {
  for (const bad of ["", "   ", "garbage", "2026-09-23 08:43:06.141 | INFO | parsed 3 tool call", "not a timestamp | #1 x: 1 tokens"]) {
    assert.equal(parseTabbyLogLine(bad), null, `must be null: ${JSON.stringify(bad)}`);
  }
  const out = parseTabbyLog("\n\nnot a line\n");
  assert.equal(out.lastRequest, null);
  assert.equal(out.lastRequestAtMs, null);
  assert.equal(out.active, false);
  assert.deepEqual(out.recentRequest, []);
  assert.strictEqual(out.windowAvgTps, null);
  assert.strictEqual(out.peakTps, null);
});

test("ignores 'parsed N tool call' and other irrelevant lines", () => {
  const raw = [
    "2026-09-23 08:43:05.000 | INFO     | parsed 12 tool call",
    COMPLETION,
    "2026-09-23 08:43:07.000 | WARNING  | something else",
  ].join("\n");
  const out = parseTabbyLog(raw);
  assert.equal(out.recentRequest.length, 1);
  assert.equal(out.recentRequest[0].genTps, 59.9);
});

test("staleness: old last-request with nothing in flight => stale, not 0", () => {
  const old = COMPLETION.replace("2026-09-23", "2026-01-01");
  const out = parseTabbyLog(old);
  assert.equal(out.active, false);
  assert.equal(out.stale, true);
  assert.notStrictEqual(out.lastRequestAtMs, null);
  assert.equal(out.lastRequest.genTps, 59.9); // historical value kept, not zeroed
});

test("a genuinely active request is never stale even if the last completion is old", () => {
  const old = COMPLETION.replace("2026-09-23", "2026-01-01");
  const out = parseTabbyLog([old, START_OPEN].join("\n"));
  assert.equal(out.active, true);
  assert.equal(out.stale, false);
});

test("applyTabbyLog maps REAL last-request values + provenance onto a tabbyapi entry", () => {
  const log = parseTabbyLog([START, COMPLETION].join("\n"));
  const entry = { backend: "tabbyapi", generationTps: null, slotsTotal: 4 };
  applyTabbyLog(entry, { ...log, available: true, file: "2026-09-20_23-11-54_537787.log" });
  assert.equal(entry.generationTps, 59.9);
  assert.equal(entry.prefillTps, 420);
  assert.equal(entry.ttftSeconds, 6.34);
  assert.equal(entry.prefixCacheHitRate, 0.99);
  assert.equal(entry.mtpAcceptanceRate, Math.round((1269 / 2077) * 10000) / 10000);
  assert.match(entry.provenance, /^TabbyAPI log \(/);
  assert.equal(entry.lastRequestAtMs, log.lastRequestAtMs);
  assert.equal(typeof entry.perfStale, "boolean");
  assert.equal(entry.requestActive, false);
  assert.equal(entry.totalOutputTokens, null); // cumulative not derivable
  assert.equal(entry.slotsTotal, 4);
});

test("applyTabbyLog: active in-flight => requestsRunning/slotsActive 1", () => {
  const log = parseTabbyLog(START_OPEN);
  const entry = { backend: "tabbyapi", generationTps: null };
  applyTabbyLog(entry, { ...log, available: true, file: "f.log" });
  assert.equal(entry.requestActive, true);
  assert.equal(entry.requestsRunning, 1);
  assert.equal(entry.slotsActive, 1);
  assert.equal(entry.generationTps, null); // no completion yet => null, not 0
});

test("applyTabbyLog: failed/absent log leaves the entry untouched (null => —)", () => {
  const entry = { backend: "tabbyapi", generationTps: null };
  applyTabbyLog(entry, { available: false, error: "boom" });
  assert.equal(entry.generationTps, null);
  assert.equal(entry.provenance, undefined);
  // Non-tabbyapi backends are skipped.
  const vllm = { backend: "vllm" };
  applyTabbyLog(vllm, parseTabbyLog(COMPLETION));
  assert.equal(vllm.provenance, undefined);
});

test("TabbyLogProbe: absent tabbyLogDir => honest 'no log configured', no SSH", async () => {
  let sshCalls = 0;
  const probe = new TabbyLogProbe({}, async () => {
    sshCalls++;
    return "";
  });
  const out = await probe.probe();
  assert.equal(out.configured, false);
  assert.equal(out.available, false);
  assert.equal(out.error, "No TabbyAPI log directory configured");
  assert.equal(out.lastRequest, null);
  assert.equal(out.lastRequestAtMs, null);
  assert.strictEqual(out.windowAvgTps, null);
  assert.equal(sshCalls, 0);
});

test("TabbyLogProbe: read-only tail (ls + tail only), marker yields the file name", async () => {
  const cmds = [];
  const probe = new TabbyLogProbe({ id: "dgx-3", tabbyLogDir: TABBY_LOG_DEFAULT_DIR }, async (_s, cmd) => {
    cmds.push(cmd);
    return `__TABBYFILE__=2026-09-20_23-11-54_537787.log\n${COMPLETION}`;
  });
  const out = await probe.probe();
  assert.equal(out.available, true);
  assert.equal(out.file, "2026-09-20_23-11-54_537787.log");
  assert.equal(out.lastRequest.genTps, 59.9);
  assert.equal(cmds.length, 1);
  assert.match(cmds[0], /ls -1t/);
  assert.match(cmds[0], /tail -n 200/);
  // READ-ONLY: no write/rotate/delete verbs.
  assert.equal(/\b(mv|rm|truncate|touch)\b/.test(cmds[0]), false);
});

test("TabbyLogProbe: SSH failure => available false, error kept, perf null", async () => {
  const probe = new TabbyLogProbe({ tabbyLogDir: "/tmp/logs" }, async () => {
    throw new Error("SSH refused");
  });
  const out = await probe.probe();
  assert.equal(out.available, false);
  assert.match(out.error, /SSH refused/);
  assert.equal(out.lastRequest, null);
  assert.strictEqual(out.lastRequestAtMs, null);
});

test("TabbyLogProbe: caches briefly (no re-read every call)", async () => {
  let calls = 0;
  const probe = new TabbyLogProbe({ tabbyLogDir: "/tmp/logs" }, async () => {
    calls++;
    return `__TABBYFILE__=a.log\n${COMPLETION}`;
  });
  await probe.probe();
  await probe.probe();
  await probe.probe();
  assert.equal(calls, 1);
});

test("parseStartLine parses the exact START shape", () => {
  const s = parseStartLine(START);
  assert.ok(s);
  assert.equal(s.id, 67897);
  assert.equal(parseStartLine("nope"), null);
});
