import test from "node:test";
import assert from "node:assert/strict";
import {
  parseLoguruLine,
  parseTelemetryLine,
  TelemetryAggregator,
  LiveConsoleManager,
} from "../LiveConsole.js";

// Real lines captured read-only from dgx-3 TabbyAPI logs (2026-09-21).
const START =
  "2026-09-21 20:36:55.347 | INFO     | #1049 chat/completions (stream): 70,240 prompt tokens · temperature: 0.8 (preset), top_k: 40 (preset), top_p: 0.95 (preset), min_p: 0.05 (preset), max_tokens: 32768 (req)";
const TOOL =
  "2026-09-21 20:37:10.333 | INFO     | #1049 chat/completions (stream): parsed 1 tool call (qwen3_coder)";
const COMPLETE =
  "2026-09-21 20:37:10.335 | INFO     | #1049 chat/completions (stream): 471 tokens generated at 64.1 T/s · prompt 70,240 tokens, 95% cached, 3,424 new in 7.62 s (449 T/s) · first token 7.63 s, total 15.0 s · draft 314/489 accepted (64%)";
const COMPLETE_MULTI_TOOL =
  "2026-09-21 20:44:00.415 | INFO     | #1055 chat/completions (stream): 2,234 tokens generated at 57.4 T/s · prompt 87,545 tokens, 89% cached, 9,977 new in 18.0 s (555 T/s) · first token 18.0 s, total 56.9 s · draft 1405/2400 accepted (59%)";

test("parseLoguruLine extracts ts, level, message", () => {
  const l = parseLoguruLine(START);
  assert.equal(l.level, "INFO");
  assert.equal(l.ts, "2026-09-21T20:36:55.347");
  assert.ok(l.msg.startsWith("#1049"));
});

test("parseLoguruLine falls back to raw for non-loguru lines", () => {
  const l = parseLoguruLine("plain startup text");
  assert.equal(l.level, "raw");
  assert.equal(l.msg, "plain startup text");
});

test("parseTelemetryLine: start event", () => {
  const e = parseTelemetryLine(parseLoguruLine(START).msg);
  assert.equal(e.phase, "start");
  assert.equal(e.reqId, 1049);
  assert.equal(e.promptTokens, 70240);
  assert.equal(e.temperature, 0.8);
});

test("parseTelemetryLine: tool event", () => {
  const e = parseTelemetryLine(parseLoguruLine(TOOL).msg);
  assert.equal(e.phase, "tool");
  assert.equal(e.reqId, 1049);
  assert.equal(e.toolCalls, 1);
});

test("parseTelemetryLine: complete event with full MTP metrics", () => {
  const e = parseTelemetryLine(parseLoguruLine(COMPLETE).msg);
  assert.equal(e.phase, "complete");
  assert.equal(e.reqId, 1049);
  assert.equal(e.generatedTokens, 471);
  assert.equal(e.decodeTps, 64.1);
  assert.equal(e.promptTokens, 70240);
  assert.equal(e.cachedPct, 95);
  assert.equal(e.newPromptTokens, 3424);
  assert.equal(e.prefillTps, 449);
  assert.equal(e.ttftSeconds, 7.63);
  assert.equal(e.totalSeconds, 15.0);
  assert.equal(e.draftAccepted, 314);
  assert.equal(e.draftAttempted, 489);
  assert.equal(e.draftPct, 64);
});

test("TelemetryAggregator merges start+tool+complete into one row", () => {
  const agg = new TelemetryAggregator();
  agg.apply(parseTelemetryLine(parseLoguruLine(START).msg), "T1");
  agg.apply(parseTelemetryLine(parseLoguruLine(TOOL).msg), "T2");
  const row = agg.apply(parseTelemetryLine(parseLoguruLine(COMPLETE).msg), "T3");
  assert.equal(row.reqId, 1049);
  assert.equal(row.state, "done");
  assert.equal(row.toolCalls, 1);
  assert.equal(row.decodeTps, 64.1);
  assert.equal(row.cachedPct, 95);
  assert.equal(row.draftPct, 64);
  assert.equal(agg.listNewestFirst().length, 1);
});

test("TelemetryAggregator keeps inflight rows and caps history", () => {
  const agg = new TelemetryAggregator(2);
  agg.apply({ phase: "start", reqId: 1, promptTokens: 10 }, "t");
  agg.apply({ phase: "start", reqId: 2, promptTokens: 20 }, "t");
  assert.equal(agg.listNewestFirst()[0].reqId, 2); // newest first
  agg.apply({ phase: "start", reqId: 3, promptTokens: 30 }, "t");
  assert.equal(agg.rows.has(1), false); // oldest evicted
  assert.equal(agg.rows.get(3).state, "inflight");
});

test("buildTailCommand quotes the validated logDir and keeps the glob live", () => {
  const cmd = LiveConsoleManager.buildTailCommand("/home/musaasad/tabbyAPI/logs");
  assert.ok(cmd.startsWith("tail -n "));
  assert.ok(cmd.includes("'/home/musaasad/tabbyAPI/logs'/*.log") || cmd.includes("/home/musaasad/tabbyAPI/logs/*.log"));
});

test("buildTailCommand refuses a hostile logDir", () => {
  assert.throws(() => LiveConsoleManager.buildTailCommand("/x'; rm -rf /"), /refusing to tail/);
  assert.throws(() => LiveConsoleManager.buildTailCommand("relative/path"), /refusing to tail/);
});