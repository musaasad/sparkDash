/**
 * Recipe feasibility validation — DRY-RUN only. Never executes a command.
 *
 * Returns {ok, errors[], warnings[]}. The recipe is validated for the nodes it
 * is (or would be) bound to via the deployment registry; a caller may pass
 * `nodeIds` to test a hypothetical binding.
 */
import { validateRecipeV2 } from "./schema.js";
import { hasRecipeSecret } from "../secretsStore.js";

const ACTIVE_STATES = new Set(["draft", "validated", "proven"]);

/**
 * @param {object} recipe normalised v2 recipe
 * @param {{
 *   knownNodeIds?: string[]|null,
 *   modelRegistry?: {get: (id:string)=>object|null}|null,
 *   recipeRegistry?: {get: (id:string)=>object|null}|null,
 *   deploymentRegistry?: {list: ()=>object[]}|null,
 *   nodeIds?: string[],
 * }} [ctx]
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateRecipeFeasibility(recipe, ctx = {}) {
  const errors = [];
  const warnings = [];

  const schema = validateRecipeV2(recipe);
  errors.push(...schema.errors);

  const topo = recipe?.topology || {};
  const nodes = Array.isArray(ctx.nodeIds) ? ctx.nodeIds : recipe?.nodeIds || [];
  if (nodes.length === 0) {
    warnings.push("recipe has no bound nodes yet — create a deployment to bind it");
  } else {
    if (nodes.length < (topo.minNodes ?? 1) || nodes.length > (topo.maxNodes ?? 1)) {
      errors.push(`topology ${topo.mode}${topo.parallelism} requires ${topo.minNodes}–${topo.maxNodes} node(s), got ${nodes.length}`);
    }
    const known = Array.isArray(ctx.knownNodeIds) ? new Set(ctx.knownNodeIds) : null;
    if (known) {
      for (const n of nodes) if (!known.has(n)) errors.push(`unknown node id: ${n}`);
    } else {
      warnings.push("no node registry available — node ids not checked");
    }
  }

  // Weight variant must exist on the referenced model.
  const model = ctx.modelRegistry?.get?.(recipe?.modelRef?.modelId) || null;
  if (model) {
    if (model.archived) errors.push("referenced model is archived");
    const variant = recipe.modelRef?.weightId || "default";
    if (!model.weightPaths?.[variant]) {
      errors.push(`model "${model.id}" has no weight variant "${variant}"`);
    }
  } else {
    warnings.push(`model "${recipe?.modelRef?.modelId ?? "(none)"}" not found in registry`);
  }

  // Port collision against other deployments' observed endpoints sharing a node.
  const deps = ctx.deploymentRegistry?.list?.() || [];
  for (const d of deps) {
    if (d.recipeId === recipe.id) continue;
    const other = ctx.recipeRegistry?.get?.(d.recipeId);
    if (!other || Number(other.endpoint?.port) !== Number(recipe?.endpoint?.port)) continue;
    const overlap = (d.nodeIds || []).filter((n) => nodes.includes(n));
    if (overlap.length > 0) {
      errors.push(`endpoint port ${recipe.endpoint.port} already used by deployment "${d.id}" on node(s) ${overlap.join(", ")}`);
    }
  }

  // secretRefs must resolve by name.
  for (const e of recipe?.launch?.env || []) {
    if (!e.secretRef) continue;
    const refName = e.secretRef.split(":").pop();
    if (e.name !== refName) {
      warnings.push(`secretRef for ${e.name} points at a different name (${refName})`);
    }
    if (!hasRecipeSecret(e.secretRef) && !e.value) {
      warnings.push(`secret ${e.name} has no stored value yet (resolvable by name only)`);
    }
  }

  // Lifecycle sanity.
  if (recipe?.lifecycleState && !ACTIVE_STATES.has(recipe.lifecycleState)) {
    if (recipe.lifecycleState === "archived") warnings.push("recipe is archived — cannot back new deployments");
  }

  return { ok: errors.length === 0, errors, warnings };
}
