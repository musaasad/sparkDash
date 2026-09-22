import type { SparkSnapshot, DeploymentStatus } from "../api/types";

export function fleetInventory(sparks: readonly SparkSnapshot[]): SparkSnapshot[];
export function nodeRole(spark: Partial<SparkSnapshot>): "head" | "worker" | "standalone";
export function nodeRoleBadge(spark: Partial<SparkSnapshot>): string;
export function isWorkerNode(spark: Partial<SparkSnapshot>): boolean;
export function nodesWithRole(sparks: readonly SparkSnapshot[], role: string): SparkSnapshot[];
export function workersOf(sparks: readonly SparkSnapshot[], headId?: string | null): SparkSnapshot[];
export function inventoryIds(sparks: readonly SparkSnapshot[]): string[];
export function nodeById(sparks: readonly SparkSnapshot[], id: string): SparkSnapshot | null;
export function primaryAnchorNode(
  sparks: readonly SparkSnapshot[],
  deployment: Pick<DeploymentStatus, "nodeIds"> | null | undefined
): SparkSnapshot | null;
