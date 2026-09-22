/**
 * Recipe lifecycle state machine — legal transitions only.
 *
 *   draft -> validated        (requires a passing validate)
 *   validated -> proven       (requires an operator note)
 *   any active -> deprecated  (active = draft|validated|proven)
 *   deprecated -> archived
 *
 * An archived recipe is read-only and cannot back a new deployment.
 * Illegal transition => Error with status 409 + reason.
 */

export const ACTIVE_STATES = Object.freeze(["draft", "validated", "proven"]);

/** @returns {{ok: boolean, reason?: string}} */
export function canTransition(from, to) {
  if (!to) return { ok: false, reason: "target lifecycleState is required" };
  if (from === to) return { ok: false, reason: `recipe is already ${to}` };
  if (from === "archived") return { ok: false, reason: "archived recipes are read-only" };
  if (to === "validated") {
    return from === "draft"
      ? { ok: true }
      : { ok: false, reason: `cannot go ${from} -> validated (only draft validates)` };
  }
  if (to === "proven") {
    return from === "validated"
      ? { ok: true }
      : { ok: false, reason: `cannot go ${from} -> proven (validate first)` };
  }
  if (to === "deprecated") {
    return ACTIVE_STATES.includes(from)
      ? { ok: true }
      : { ok: false, reason: `cannot go ${from} -> deprecated` };
  }
  if (to === "archived") {
    return from === "deprecated"
      ? { ok: true }
      : { ok: false, reason: "only a deprecated recipe can be archived" };
  }
  return { ok: false, reason: `unknown lifecycle state: ${to}` };
}

/**
 * Apply a transition to a recipe in place. Mutates only lifecycleState +
 * provenance (validatedAt / provenAt / note).
 * @throws {Error & {status:number}}
 */
export function applyTransition(recipe, to, { note = null, now = Date.now() } = {}) {
  const check = canTransition(recipe.lifecycleState, to);
  if (!check.ok) {
    const err = new Error(check.reason);
    err.status = 409;
    throw err;
  }
  if (to === "proven" && !note) {
    const err = new Error("validated -> proven requires an operator note");
    err.status = 400;
    throw err;
  }
  recipe.lifecycleState = to;
  recipe.provenance = recipe.provenance || {};
  if (to === "validated") recipe.provenance.validatedAt = now;
  if (to === "proven") {
    recipe.provenance.provenAt = now;
    if (note) recipe.provenance.note = String(note);
  }
  if (to === "archived") recipe.archived = true;
  else if (to !== "archived") recipe.archived = false;
  recipe.updatedAt = now;
  return recipe;
}
