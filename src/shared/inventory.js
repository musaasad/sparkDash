/**
 * CANONICAL COMPUTE INVENTORY — ONE source of truth for "every configured /
 * adopted node". Shared by the React app and the Node server.
 *
 * A worker node NEVER disappears from the inventory. It carries its explicit
 * cluster role (head / worker / standalone) as a badge. Role collapsing is only
 * ever used to pick a deployment's telemetry ANCHOR — never to hide a node.
 *
 * All associations are IDENTITY-based (stable node ids), never positional.
 */

/** Every node, config order, workers included. The canonical inventory. */
export function fleetInventory(sparks) {
  return Array.isArray(sparks) ? [...sparks] : [];
}

/** Explicit cluster role for a node (legacy workerNode supported). */
export function nodeRole(spark) {
  if (spark?.role === "head" || spark?.role === "worker" || spark?.role === "standalone") {
    return spark.role;
  }
  return spark?.workerNode ? "worker" : "standalone";
}

/** Display badge for a node role — head/worker/standalone, never null. */
export function nodeRoleBadge(spark) {
  return nodeRole(spark);
}

export function isWorkerNode(spark) {
  return nodeRole(spark) === "worker";
}

/** Nodes (identity) for one role. */
export function nodesWithRole(sparks, role) {
  return fleetInventory(sparks).filter((s) => nodeRole(s) === role);
}

/** Worker nodes; optional `headId` narrows to one head's reported workers. */
export function workersOf(sparks, headId) {
  return fleetInventory(sparks).filter((s) => {
    if (!isWorkerNode(s)) return false;
    if (headId == null) return true;
    return s.workerHeadId === headId || !s.workerHeadId;
  });
}

/** Node ids present in the inventory, in config order (stable identity list). */
export function inventoryIds(sparks) {
  return fleetInventory(sparks).map((s) => s.id);
}

/** Node by stable id. */
export function nodeById(sparks, id) {
  return fleetInventory(sparks).find((s) => s.id === id) ?? null;
}

/**
 * Telemetry ANCHOR node for a deployment: identity-based over the deployment's
 * explicit `nodeIds`, preferring a non-worker coordinator. Falls back to the
 * first present member. Used only to READ telemetry — never to hide nodes.
 */
export function primaryAnchorNode(sparks, deployment) {
  const present = (deployment?.nodeIds || [])
    .map((id) => nodeById(sparks, id))
    .filter((s) => !!s);
  return present.find((s) => !isWorkerNode(s)) ?? present[0] ?? null;
}
