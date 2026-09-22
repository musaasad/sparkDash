import type { SparkSnapshot, RecipePublic, DeploymentStatus } from "../../api/types";
import type { Route } from "../../hooks/router";
import { SparkPage } from "../SparkPage/SparkPage";
import { SparkTabs } from "../SparkTabs";
import { StatusPill, Chip, EmptyState } from "../ui/Status";
import { recipesOnNode } from "./fleetModel";

interface NodeDetailProps {
  spark: SparkSnapshot;
  allSparks: SparkSnapshot[];
  recipes: readonly RecipePublic[];
  deployments: readonly DeploymentStatus[];
  temperatureUnit: "celsius" | "fahrenheit";
  benchShareImage?: boolean;
  navigate: (route: Route) => void;
  onEdit: () => void;
  onAddNode: () => void;
}

/**
 * Node drill-down. The proven SparkPage monitoring surface is preserved as-is;
 * the control plane adds a breadcrumb and the deployment context on top.
 */
export function NodeDetail({
  spark,
  allSparks,
  recipes,
  deployments,
  temperatureUnit,
  benchShareImage,
  navigate,
  onEdit,
  onAddNode,
}: NodeDetailProps) {
  const onNode = recipesOnNode(recipes, spark.id);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <nav className="cp-crumb" aria-label="Breadcrumb">
        <a
          href="/fleet"
          onClick={(e) => {
            e.preventDefault();
            navigate({ section: "fleet" });
          }}
        >
          Fleet
        </a>
        <span className="cp-crumb-sep">/</span>
        <span className="cp-crumb-current">{spark.name}</span>
      </nav>

      {/* Node sub-nav — the proven tab strip, demoted from primary navigation. */}
      <SparkTabs
        sparks={allSparks}
        activeId={spark.id}
        onSelect={(id) => navigate({ section: "node", nodeId: id })}
        onAdd={onAddNode}
        onEdit={() => onEdit()}
      />

      {onNode.length > 0 ? (
        <div className="cp-panel" style={{ padding: "10px 14px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="cp-panel-title" style={{ margin: 0 }}>
              Deployments on this node
            </span>
            {onNode.map((r) => {
              const dep = deployments.find((d) => d.recipeId === r.id);
              return (
                <button
                  key={r.id}
                  type="button"
                  className="cp-pill"
                  style={{ cursor: "pointer" }}
                  onClick={() => navigate({ section: "model", modelId: r.modelId })}
                  title={`${r.name} · ${r.runtime}`}
                >
                  <span style={{ fontWeight: 600 }}>{r.modelId}</span>
                  <Chip>{r.runtime}</Chip>
                  {dep ? <StatusPill status={dep.state as never} /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="cp-panel" style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
          <span className="cp-panel-title" style={{ margin: 0 }}>
            Deployments on this node
          </span>
          <span style={{ fontSize: 12, color: "var(--color-muted)" }}>
            None — <a
              href="/models"
              className="cp-alert-link"
              onClick={(e) => {
                e.preventDefault();
                navigate({ section: "models" });
              }}
            >
              assign a recipe
            </a>{" "}
            from a model page.
          </span>
        </div>
      )}

      <SparkPage spark={spark} temperatureUnit={temperatureUnit} benchShareImage={benchShareImage} onEdit={onEdit} />
    </div>
  );
}