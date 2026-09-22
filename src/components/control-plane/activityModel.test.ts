import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../../api/types";
import {
  activityFacets,
  activityLevel,
  activitySource,
  applyLevels,
  dedupeActivity,
  filterActivity,
} from "./activityModel";

function ev(over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    seq: 1,
    ts: new Date().toISOString(),
    kind: "lifecycle",
    subject: "r1",
    summary: "recipe saved",
    attribution: null,
    meta: null,
    ...over,
  };
}

describe("activityModel severity + source derivation", () => {
  it("maps alerts and failure language to error", () => {
    expect(activityLevel(ev({ kind: "alert", summary: "gpu overtemp" }))).toBe("error");
    expect(activityLevel(ev({ summary: "deployment failed" }))).toBe("error");
  });

  it("maps offline/degraded language to warning and the rest to info", () => {
    expect(activityLevel(ev({ kind: "node", summary: "node went offline" }))).toBe("warning");
    expect(activityLevel(ev({ summary: "node came online" }))).toBe("info");
  });

  it("buckets sources honestly", () => {
    expect(activitySource(ev({ kind: "console" }))).toBe("console");
    expect(activitySource(ev({ kind: "bench" }))).toBe("lifecycle");
    expect(activitySource(ev({ kind: "node" }))).toBe("system");
  });
});

describe("activityModel facet counts", () => {
  it("counts each severity over the scoped set", () => {
    const events = [ev({ seq: 1, summary: "failed" }), ev({ seq: 2, summary: "offline" }), ev({ seq: 3 }), ev({ seq: 4 })];
    const facets = activityFacets(events);
    expect(facets.map((f) => f.level)).toEqual(["error", "warning", "info"]);
    expect(facets.map((f) => f.count)).toEqual([1, 1, 2]);
  });

  it("refreshes counts against the other filters", () => {
    const events = [
      ev({ seq: 1, summary: "console failure", kind: "console" }),
      ev({ seq: 2, summary: "bench failed", kind: "bench" }),
    ];
    const scoped = filterActivity(events, { source: "console" });
    expect(activityFacets(scoped).find((f) => f.level === "error")?.count).toBe(1);
  });
});

describe("activityModel filters", () => {
  it("filters by free text, source and time window", () => {
    const now = Date.now();
    const events = [
      ev({ seq: 1, ts: new Date(now - 60_000).toISOString(), subject: "spark-1", kind: "console" }),
      ev({ seq: 2, ts: new Date(now - 3 * 3600_000).toISOString(), subject: "spark-2" }),
    ];
    expect(filterActivity(events, { query: "spark-1", now })).toHaveLength(1);
    expect(filterActivity(events, { source: "console", now })).toHaveLength(1);
    expect(filterActivity(events, { window: "1h", now })).toHaveLength(1);
  });

  it("applies severity facets", () => {
    const events = [ev({ seq: 1, summary: "failed" }), ev({ seq: 2 })];
    expect(applyLevels(events, ["error"]).map((e) => e.seq)).toEqual([1]);
    expect(applyLevels(events, undefined)).toHaveLength(2);
  });
});

describe("activityModel dedupe", () => {
  it("collapses identical repeats to one row with an xN count", () => {
    const events = [ev({ seq: 1 }), ev({ seq: 2 }), ev({ seq: 3, summary: "other" })];
    const rows = dedupeActivity(events);
    expect(rows).toHaveLength(2);
    expect(Math.max(...rows.map((r) => r.count))).toBe(2);
  });
});
