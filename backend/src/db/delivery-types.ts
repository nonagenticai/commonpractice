// src/db/delivery-types.ts — Phase 5 (solution-to-delivery). Shared, drizzle-free TS shapes
// for the canonical delivery payload (spec Part 3) persisted as JSONB on
// solution_deliveries.payload, plus the per-target config/credential shapes. Kept free of
// drizzle imports (like flow-types.ts / dataset-types.ts) so the pure mapper
// (services/delivery-payload.ts), the schema, and any future adapter can all share them.

/** The three pluggable delivery targets. Mirrors the `delivery_target_kind` pg enum. */
export type DeliveryTargetKind = 'jira' | 'azure_devops' | 'fr';

/** The delivery lifecycle. Mirrors the `delivery_status` pg enum. 5A only ever writes 'pending'. */
export type DeliveryStatus =
  | 'pending'
  | 'sent'
  | 'created'
  | 'draft_created'
  | 'approved'
  | 'promoted'
  | 'rejected'
  | 'failed';

/** Provenance back-pointers carried with every delivery — full CP lineage so the created
 *  backlog item (and any audit) can be traced to its source solution. */
export interface DeliveryProvenance {
  cp_solution_id: string;
  cp_challenge_id: string;
  cp_flow_id: string | null;
  cp_tenant_id: string;
  initiated_by: string;
  votes_count: number;
  /** The block-slug chain (flow node slugs in order; falls back to blocks_used). */
  flow_chain: string[];
  blocks_used: string[];
  datasets: string[];
  ontology_entities: string[];
}

/** The target-neutral intermediate the per-target adapters (5B/5C/5D) render. Spec Part 3. */
export interface DeliveryPayload {
  title: string;
  summary: string;
  problem: string;
  outcome: string;
  acceptance_criteria: string[];
  deliverables: string[];
  requirements: string[];
  data_access: string[];
  labels: string[];
  provenance: DeliveryProvenance;
  /** Fields the target requires that CP can't supply (e.g. repo URL / git PAT for fr). */
  needs_human: string[];
}

/** Non-secret per-target config (delivery_targets.config jsonb). Extras the columns don't cover. */
export interface DeliveryTargetConfig {
  /** Jira issue type id (when projectKey + named type isn't enough). */
  jira_issue_type_id?: string;
  /** Azure DevOps area path. */
  ado_area_path?: string;
  /** Break acceptance criteria into child sub-tasks (Jira) — default off. */
  breakdown?: boolean;
}
