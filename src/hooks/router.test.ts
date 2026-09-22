import { describe, it, expect } from "vitest";
import { parseRoute, routeToPath, sectionOf } from "./router";

describe("control-plane router", () => {
  it("maps root to overview", () => {
    expect(parseRoute("/")).toEqual({ section: "overview" });
  });

  it("parses section routes", () => {
    expect(parseRoute("/models")).toEqual({ section: "models" });
    expect(parseRoute("/fleet")).toEqual({ section: "fleet" });
    expect(parseRoute("/activity")).toEqual({ section: "activity" });
    expect(parseRoute("/benchmarks")).toEqual({ section: "benchmarks" });
    expect(parseRoute("/settings")).toEqual({ section: "settings" });
  });

  it("parses detail routes with tab", () => {
    expect(parseRoute("/models/qwen38")).toEqual({ section: "model", modelId: "qwen38", tab: undefined });
    expect(parseRoute("/models/qwen38/live-console")).toEqual({ section: "model", modelId: "qwen38", tab: "live-console" });
    expect(parseRoute("/fleet/dgx-3")).toEqual({ section: "node", nodeId: "dgx-3" });
  });

  it("keeps legacy /spark/:id URLs resolving to a node detail", () => {
    expect(parseRoute("/spark/dgx-1")).toEqual({ section: "node", nodeId: "dgx-1" });
  });

  it("decodes encoded ids", () => {
    expect(parseRoute("/fleet/dgx%20spark%201")).toEqual({ section: "node", nodeId: "dgx spark 1" });
  });

  it("falls back to overview for unknown sections", () => {
    expect(parseRoute("/nonsense/xyz")).toEqual({ section: "overview" });
  });

  it("round-trips paths", () => {
    for (const route of [
      { section: "overview" as const },
      { section: "models" as const },
      { section: "model" as const, modelId: "m 1", tab: "recipes" },
      { section: "node" as const, nodeId: "dgx-3" },
      { section: "settings" as const },
    ]) {
      expect(parseRoute(routeToPath(route))).toEqual(route);
    }
  });

  it("collapses detail routes to their nav section", () => {
    expect(sectionOf({ section: "model", modelId: "m" })).toBe("models");
    expect(sectionOf({ section: "node", nodeId: "n" })).toBe("fleet");
    expect(sectionOf({ section: "activity" })).toBe("activity");
  });
});