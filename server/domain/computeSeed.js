/**
 * COMPUTE seed loader — pure, READ-ONLY.
 *
 * `server/seeds/compute.json` is committed data describing the fleet and its
 * CONFIGURED physical fabric triangle. It is used only when `config/sparks.json`
 * (gitignored live fleet) is empty, so the live file is never hand-edited here.
 *
 * The seed never INVENTS a topology: it carries node records and explicit
 * fabricLinks (configured provenance) only.
 */
import fs from "fs";
import path from "path";
import { SEEDS_DIR } from "../config.js";

export const COMPUTE_SEED_PATH = path.join(SEEDS_DIR, "compute.json");

const slug = (v) => {
  const s = String(v ?? "").trim();
  return s.length > 0 ? s : null;
};

/**
 * Load + shape the committed compute seed.
 * @param {string} [file]
 * @returns {{schemaVersion: number, nodes: object[]}}
 */
export function loadComputeSeed(file = COMPUTE_SEED_PATH) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { schemaVersion: 2, nodes: [] };
  }
  const seen = new Set();
  const nodes = [];
  for (const n of Array.isArray(raw?.nodes) ? raw.nodes : []) {
    const id = slug(n?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    nodes.push({ ...n, id, name: slug(n?.name) ?? id, kind: n?.kind === "host" ? "host" : "spark" });
  }
  return { schemaVersion: 2, nodes };
}

/**
 * Seed the Spark registry from the committed compute seed when the live fleet
 * config is empty. Idempotent (addSpark throws on an existing id → skipped).
 * @param {{getSpark?: (id: string) => object|null, addSpark?: (c: object) => object}} registry
 * @returns {number} number of nodes seeded
 */
export function seedComputeNodes(registry) {
  if (!registry?.addSpark || !registry?.getSpark) return 0;
  // Same rule as the registry seed files: only when the live fleet is EMPTY.
  if ((registry.sparks?.length ?? 0) > 0) return 0;
  let added = 0;
  for (const node of loadComputeSeed().nodes) {
    if (registry.getSpark(node.id)) continue;
    try {
      registry.addSpark(node);
      added++;
    } catch {
      // a malformed node must never break boot
    }
  }
  return added;
}
