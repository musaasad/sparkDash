import { describe, expect, it } from "vitest";
import type { ConsoleTelemetryRow } from "../../api/types";
import {
  ALL_WINDOW,
  EMPTY_QUERY,
  INITIAL_FOLLOW,
  bucketize,
  buildSources,
  countBySeverity,
  extractReqId,
  fieldTable,
  filterRows,
  hasActiveQuery,
  indexRawLines,
  isOutlier,
  metricChips,
  outlierThresholds,
  parseQuery,
  percentile,
  rangeForWindow,
  reduceFollow,
  sourceLabel,
  sourceForRecipe,
  streamState,
  toConsoleRow,
  toCopyText,
  toJsonl,
  type ConsoleRow,
} from "./liveConsoleModel";

const telemetryRow = (reqId: number, over: Partial<ConsoleTelemetryRow> = {}): ConsoleTelemetryRow => ({
  reqId,
  ts: null,
  state: "done",
  promptTokens: 100,
  generatedTokens: 20,
  cachedPct: 10,
  newPromptTokens: 90,
  prefillTps: 50,
  ttftSeconds: 0.4,
  decodeTps: 30,
  totalSeconds: 1.5,
  draftAccepted: 3,
  draftAttempted: 4,
  draftPct: 75,
  toolCalls: 0,
  temperature: 0.7,
  ...over,
});

let clock = Date.parse("2026-09-22T12:00:00.000Z");
const rowOf = (reqId: number, over: Partial<ConsoleTelemetryRow> = {}, modelId = "deepseek", nodeIds = ["dgx-1"], raw = "INFO #" + reqId + " prefill ok") => {
  const row = { ...telemetryRow(reqId, over), ts: new Date(clock).toISOString() };
  clock += 1000;
  return toConsoleRow("r1", modelId, nodeIds, row, raw);
};

describe("parseQuery", () => {
  it("reads the three field prefixes case-insensitively and strips the # on reqId", () => {
    const q = parseQuery("reqId:#42 model:DeepSeek node:DGX-1 prefill");
    expect(q.reqId).toBe(42);
    expect(q.model).toBe("deepseek");
    expect(q.node).toBe("dgx-1");
    expect(q.terms).toEqual(["prefill"]);
  });

  it("falls back to free text for a bare prefix and non-numeric reqId", () => {
    const q = parseQuery("reqId: model: node:abc reqId:xyz");
    expect(q.model).toBeNull();
    expect(q.node).toBe("abc");
    expect(q.reqId).toBeNull();
    expect(q.terms).toEqual(["reqId:", "model:", "xyz"]);
  });

  it("keeps every free term as an AND condition", () => {
    expect(parseQuery("MTP accepted").terms).toEqual(["mtp", "accepted"]);
  });
});

describe("filter pipeline", () => {
  const rows: ConsoleRow[] = [
    rowOf(1, {}, "deepseek", ["dgx-1"]),
    rowOf(2, { ttftSeconds: 9 }, "qwen", ["dgx-3"], "ERROR #2 decode slow"),
    rowOf(3, {}, "deepseek", ["dgx-2"]),
  ];

  it("filters by reqId, model and node independently", () => {
    expect(filterRows(rows, parseQuery("reqId:2"), ALL_WINDOW).map((r) => r.row.reqId)).toEqual([2]);
    expect(filterRows(rows, parseQuery("model:qwen"), ALL_WINDOW).map((r) => r.row.reqId)).toEqual([2]);
    expect(filterRows(rows, parseQuery("node:dgx-2"), ALL_WINDOW).map((r) => r.row.reqId)).toEqual([3]);
  });

  it("applies free text across the raw payload and ANDs terms", () => {
    expect(filterRows(rows, parseQuery("slow"), ALL_WINDOW)).toHaveLength(1);
    expect(filterRows(rows, parseQuery("decode slow"), ALL_WINDOW)).toHaveLength(1);
    expect(filterRows(rows, parseQuery("decode prefill"), ALL_WINDOW)).toHaveLength(0);
  });

  it("filters by severity facet and time window", () => {
    const errorOnly = filterRows(rows, parseQuery("error"), ALL_WINDOW);
    // "error" is free text here — the facet set is separate
    expect(errorOnly.map((r) => r.row.reqId)).toEqual([2]);

    const facet = { ...EMPTY_QUERY, severity: new Set(["error" as const]) };
    expect(filterRows(rows, facet, ALL_WINDOW)).toHaveLength(1);

    const ts = rows.map((r) => r.ts as number);
    expect(filterRows(rows, EMPTY_QUERY, { from: ts[1], to: ts[1] })).toHaveLength(1);
  });

  it("groups node ids into an enclosure label and defaults the tab to the focused recipe", () => {
    expect(sourceLabel(["dgx-1", "dgx-2"], "m")).toBe("TP2");
    expect(sourceLabel(["dgx-3"], "m")).toBe("Qwen");
    expect(sourceLabel(["dgx-9"], "ModelX")).toBe("ModelX");

    const sources = buildSources(
      [
        { recipeId: "a", modelId: "m", nodeIds: ["dgx-1"] },
        { recipeId: "b", modelId: "m2", nodeIds: ["dgx-3"] },
      ] as never,
      "b"
    );
    expect(sources.map((s) => s.label)).toEqual(["TP2", "Qwen", "All"]);
    expect(sourceForRecipe(sources, "b")).toBe("Qwen");
  });

  it("indexes raw lines by reqId so rows keep their original log line", () => {
    const map = indexRawLines([{ recipeId: "r1", line: { ts: null, level: "INFO", msg: "#77 ok", raw: "INFO #77 ok" } }]);
    expect(map.get("r1:77")).toBe("INFO #77 ok");
  });

  it("anchors reqId extraction to the request token, not any digit run", () => {
    expect(extractReqId("INFO #77 prefill ok")).toBe(77);
    expect(extractReqId("INFO reqId=42 done")).toBe(42);
    expect(extractReqId("INFO req_id: 7 done")).toBe(7);
    // port / IP / token-count digit runs must not become fake ids
    expect(extractReqId("listening on 10.0.0.5:8888 with 123 tokens")).toBeNull();
    expect(extractReqId("#12 request queued")).toBe(12);
  });

  it("does not index an unrelated digit run as a reqId key", () => {
    const map = indexRawLines([
      { recipeId: "r1", line: { ts: null, level: "INFO", msg: "port 8888 open", raw: "port 8888 open" } },
      { recipeId: "r1", line: { ts: null, level: "INFO", msg: "#9 ok", raw: "INFO #9 ok" } },
    ]);
    expect(map.size).toBe(1);
    expect(map.get("r1:9")).toBe("INFO #9 ok");
  });

  it("reports whether any filter is active", () => {
    expect(hasActiveQuery(EMPTY_QUERY, ALL_WINDOW)).toBe(false);
    expect(hasActiveQuery(parseQuery("x"), ALL_WINDOW)).toBe(true);
    expect(hasActiveQuery(EMPTY_QUERY, rangeForWindow("15m", 1000))).toBe(true);
  });
});

describe("follow/pause reducer", () => {
  it("auto-pauses on scroll up and counts unseen only while paused", () => {
    let s = reduceFollow(INITIAL_FOLLOW, { type: "scroll", atBottom: false });
    expect(s.following).toBe(false);
    s = reduceFollow(s, { type: "append", at: 10 });
    s = reduceFollow(s, { type: "append", at: 20 });
    expect(s.unseen).toBe(2);
    expect(s.lastSync).toBe(20);
  });

  it("resumes on scroll back to the bottom and clears unseen", () => {
    let s: typeof INITIAL_FOLLOW = { following: false, unseen: 4, lastSync: 1 };
    s = reduceFollow(s, { type: "scroll", atBottom: true });
    expect(s.following).toBe(true);
    expect(s.unseen).toBe(0);
  });

  it("keeps lastSync fresh while following without accruing unseen", () => {
    const s = reduceFollow(INITIAL_FOLLOW, { type: "append", at: 99 });
    expect(s.following).toBe(true);
    expect(s.unseen).toBe(0);
    expect(s.lastSync).toBe(99);
  });

  it("pause/resume are explicit and resume clears the backlog", () => {
    const paused = reduceFollow({ following: true, unseen: 0, lastSync: null }, { type: "pause" });
    expect(paused.following).toBe(false);
    const resumed = reduceFollow({ following: false, unseen: 7, lastSync: null }, { type: "resume", at: 5 });
    expect(resumed).toMatchObject({ following: true, unseen: 0, lastSync: 5 });
  });
});

describe("JSONL export shape", () => {
  it("emits one JSON object per row with ISO ts, attribution and raw line", () => {
    const rows = [rowOf(7), rowOf(8, { ts: null })];
    const out = toJsonl(rows).split("\n");
    expect(out).toHaveLength(2);
    const first = JSON.parse(out[0]);
    expect(first).toMatchObject({ reqId: 7, level: "info", recipeId: "r1", modelId: "deepseek", nodeIds: ["dgx-1"] });
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first.raw).toContain("#7");
    expect(JSON.parse(out[0])).toHaveProperty("decodeTps");
  });

  it("copy text falls back to a synthesized line when raw is empty", () => {
    const rows = [toConsoleRow("r1", "m", ["n"], { ...telemetryRow(9), ts: null }, "")];
    expect(toCopyText(rows)).toContain("#9");
  });
});

describe("metric chips, drawer fields, outliers, histogram", () => {
  it("keeps chips in fixed order and marks absent parsed fields", () => {
    const chips = metricChips(telemetryRow(1, { cachedPct: null, toolCalls: 0 }));
    expect(chips.map((c) => c.key)).toEqual(["prompt", "gen", "cached", "prefill", "ttft", "decode", "mtp", "tools", "duration"]);
    expect(chips.find((c) => c.key === "cached")).toMatchObject({ text: "—", present: false });
    expect(chips.find((c) => c.key === "ttft")?.text).toBe("400ms");
  });

  it("never fabricates drawer field values", () => {
    const fields = fieldTable(telemetryRow(1, { newPromptTokens: null }));
    expect(fields.find((f) => f.key === "newPromptTokens")?.value).toBe("—");
  });

  it("computes p90 outliers only once enough samples exist", () => {
    const short = [rowOf(1), rowOf(2)];
    expect(outlierThresholds(short)).toEqual({ ttft: null, decode: null });

    const many = Array.from({ length: 10 }, (_, i) => rowOf(i + 1, { ttftSeconds: i / 10, decodeTps: i }));
    const t = outlierThresholds(many);
    expect(t.ttft).toBeCloseTo(0.8, 5);
    const worst = many[many.length - 1];
    expect(isOutlier(worst, t)).toBe(true);
    expect(isOutlier(many[0], t)).toBe(false);
  });

  it("buckets rows by time and overlays errors", () => {
    const rows = [rowOf(1), rowOf(2, {}, "m", ["n"], "ERROR #2 boom")];
    const from = rows[0].ts as number;
    const buckets = bucketize(rows, { from, to: from + 2000 }, from + 2000, 4);
    expect(buckets).toHaveLength(4);
    expect(buckets.reduce((n, b) => n + b.total, 0)).toBe(2);
    expect(buckets.reduce((n, b) => n + b.errors, 0)).toBe(1);
  });

  it("percentile is nearest-rank and null-safe", () => {
    expect(percentile([], 90)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5], 90)).toBe(5);
  });

  it("counts severities", () => {
    const rows = [rowOf(1), rowOf(2, {}, "m", ["n"], "ERROR boom")];
    expect(countBySeverity(rows)).toMatchObject({ info: 1, error: 1 });
  });
});

describe("streamState", () => {
  it("treats a recipe without logDir as not-configured regardless of connection", () => {
    expect(streamState(null, true)).toBe("not-configured");
    expect(streamState(null, false)).toBe("not-configured");
  });

  it("only reports a disconnect on a configured recipe whose stream dropped", () => {
    expect(streamState("/logs", true)).toBe("streaming");
    expect(streamState("/logs", false)).toBe("disconnected");
  });
});
