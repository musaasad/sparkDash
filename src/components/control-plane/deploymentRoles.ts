/**
 * DEPLOYMENT role catalogue — pure config DATA, sourced from the server domain
 * vocabulary (DEPLOYMENT_ROLES). A role is a placement INTENT on the binding:
 * it names NO model and is changeable later via PATCH without recreating
 * anything. Default is none/null — primary is never auto-assigned.
 */
import type { DeploymentRole } from "../../api/types";

export const DEPLOYMENT_ROLE_OPTIONS: { id: DeploymentRole; label: string; hint: string }[] = [
  { id: "primary", label: "primary", hint: "Front-line serving target." },
  { id: "worker", label: "worker", hint: "Distributed worker / fan-out unit." },
  { id: "specialist", label: "specialist", hint: "Narrow-capability endpoint." },
  { id: "reviewer", label: "reviewer", hint: "Evaluation / judge endpoint." },
  { id: "experimental", label: "experimental", hint: "Trial shape, no guarantees." },
  { id: "none", label: "none", hint: "Explicitly unroled (config only)." },
];

/** All role ids, for tests / iterators. */
export const DEPLOYMENT_ROLES = DEPLOYMENT_ROLE_OPTIONS.map((r) => r.id);

/** Persisted role value: "none" folds to null so the FE heuristic resumes. */
export function roleToSave(role: DeploymentRole | ""): DeploymentRole | null {
  return role === "" || role === "none" ? null : role;
}
