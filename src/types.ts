export interface Meta {
  lens: string;
  input_rep?: string | null; // "individual" | "difference" | "prompt" — drives the lens description
  dataset_mode?: "single" | "paired" | string | null;
  embed_model_id: string | null;
  m_total: number;
  k: number;
  input_dim: number;
  n_battles: number;
  ev: number | null;
  n_verified: number | null;
  n_named?: number | null; // named features (verified fraction reads against this, not m_total)
  loo_r2: number | null; // back-compat: null unless genuinely leave-one-model-out
  // fit quality of whatever predictions exist + whether they're held-out. Older bundles
  // only have loo_r2 (which could silently be in-sample — hence the split).
  r2?: number | null;
  is_loo?: boolean;
  n_models: number | null;
  // false when the dataset has no preference labels — the viewer then hides every
  // preference-derived surface (Bias, Validation, reward columns, "what wins" panels).
  // absent in older bundles → treated as true (label-bearing) for backward compat.
  has_preference?: boolean;
}

// bundle_manifest.json — written LAST by the export, so it describes a completed run.
// Files not listed are treated as absent (stale artifacts can't masquerade as current).
export interface BundleManifest {
  schema_version: number;
  generated_at?: string;
  lens?: string;
  files: string[]; // artifact names written this run ("examples/" covers the shard dir)
  errors?: { stage: string; error: string }[];
}
export const BUNDLE_SCHEMA_VERSION = 2;

export type BehaviorCategory = "general" | "context_specific" | "prompt_content" | "unclassified";

export interface Feature {
  feature_id: number;
  concept?: string;
  type?: string; // coarse label: capability | format | style | topic | safety
  corr_confound_len?: number; // |corr|>=0.3 ⇒ "does more" may be "does longer"
  correlation?: number;
  sign?: number;
  p_bonferroni?: number;
  fidelity_pass?: boolean;
  // full fidelity verdict (un-dropped from feature_fidelity.csv)
  fidelity_n?: number; // # held-out examples the verifier judged
  precision?: number;
  recall?: number;
  f1?: number;
  fp_rate?: number; // false-positive rate on silent pairs
  agreement?: number;
  // semantic presence calibration: unlike fidelity (valid on held-out extremes), this
  // supports corpus-level rates above a learned feature-specific activation threshold.
  calibration_status?: "calibrated" | "extreme_only" | "not_calibratable";
  semantic_threshold?: number | null;
  threshold_quantile?: number | null;
  precision_lcb?: number | null;
  semantic_coverage?: number | null;
  silent_concept_rate?: number | null;
  semantic_role?: string;
  semantic_family?: "behavioral" | "prompt_specific" | "mixed_or_unclear" | string;
  classification_status?: string;
  role_confidence?: string;
  role_agreement?: number | null;
  prompt_relation?: string;
  relation_agreement?: number | null;
  requested_share?: number | null;
  elicited_share?: number | null;
  prompt_driven_share?: number | null;
  independent_share?: number | null;
  prompt_scope?: string;
  behavior_scope?: string;
  feature_summary?: string;
  n_examples?: number;
  n_labelled?: number;
  n_present?: number;
  label_coverage?: number | null;
  concept_present_rate?: number | null;
  presence_pass?: boolean;
  semantic_presence_rate?: number | null;
  prompt_dependence_nmi?: number | null;
  prompt_context_js?: number | null;
  effective_prompt_contexts?: number | null;
  max_prompt_context_share?: number | null;
  n_supported_prompt_contexts?: number;
  paired_choice_ratio?: number | null;
  behavior_category?: BehaviorCategory;
  top_prompt_contexts_json?: string;
  // win relevance: raw gap AND length-controlled AME (WIMHF App. A.2)
  win_assoc?: number;
  fire_rate?: number;
  win_significant?: boolean;
  n_fire?: number; // battles where the feature fires
  win_rate_a_more?: number;
  win_rate_a_less?: number;
  delta_win_rate?: number; // length-controlled Δwin-rate — the honest quantity
  delta_win_significant?: boolean;
  cluster_id?: number;
  behavior?: string;
  // generality = pervasiveness: fraction of responses this feature fires in (from z_a/z_b).
  // High = a general behaviour that pervades responses; low = niche / content-bound.
  generality?: number | null; // null only when the lens has no per-side codes
  n_prompt_types?: number; // # prompt concepts that significantly elicit it (topic-gatedness)
}

export interface ModelValidation {
  model: string;
  n_battles: number;
  predicted_score: number;
  predicted_score_loo?: number;
  actual_win_rate: number;
}

export interface DiagnosisRow {
  win_rate: number;
  n_battles: number;
  net_direction: number[];
  delta_vs_pool: number[];
  // report-card extras (added by export_viewer_data.py; absent in older bundles)
  fire_rate?: number[]; // per-feature activation rate for this model, parallel to features
  // raw counts (fires-positive / fires-negative per feature) — with Diagnosis.tot_pos/
  // tot_neg/n_total these let the viewer z-test delta_vs_pool + BH instead of showing
  // bare effects. Absent in older bundles → no significance shown.
  fire_pos?: number[];
  fire_neg?: number[];
  behavior_category?: BehaviorCategory[];
  cross_context_stable?: boolean[];
  context_q_value?: (number | null)[];
  prompt_types?: { concept: string; win_rate: number; n: number; feature_id?: number }[];
  // per-model prompt-concept -> response-concept -> within-prompt Δwin edges
  relations?: { prompt_concept: string; response_concept: string; delta_win: number; n: number }[];
}

export interface Diagnosis {
  features: number[];
  concepts: string[];
  models: string[];
  rows: Record<string, DiagnosisRow>;
  // "absolute" = fire_rate is P(z_self>0) prevalence (share of the model's OWN answers
  // expressing the behaviour); "contrast" = it's the bank disagreement rate (how often the
  // model differs from its opponent), for a difference lens. Absent in older bundles →
  // treat as "contrast" (that's what pre-fix bundles actually held). Governs the "Does a
  // lot" vs "Distinguishes from opponents" labeling.
  fire_rate_kind?: "absolute" | "contrast";
  presence_basis?: ("semantic_threshold" | "positive_nonzero")[];
  clusters?: number[]; // cluster_id parallel to `features`
  behaviors?: Record<string, string>;
  // pool totals over ALL battles (incl. each model's own — subtract fire_pos/fire_neg
  // to get the everyone-else pool), parallel to `features`. For poolContrastP.
  tot_pos?: number[];
  tot_neg?: number[];
  n_total?: number;
  // honest stub written when no oriented bank exists (export couldn't build a diagnosis)
  error?: string;
  message?: string;
}

export interface Example {
  z: number;
  activation_percentile?: number;
  activation_reference?: "positive_activation" | "absolute_contrast" | string;
  selection_kind?: "strongest" | "group_strongest" | "random_present" | "random_contrast" | "near_threshold" | "near_boundary" | string;
  prompt: string;
  model_a: string;
  model_b: string;
  completion_a: string;
  completion_b: string;
  group?: string;
  group_column?: string;
}

export type Examples = Record<string, Example[]>;

// per-model example answers: model -> feature_id -> the model's OWN answers exhibiting it
export interface ModelExample {
  z: number; // activation of the feature on this answer
  prompt: string;
  answer: string; // this model's answer
  outcome?: "win" | "loss" | "tie";
  preference_probability?: number; // continuous probability for this model, when available
}
export type ExamplesByModel = Record<string, Record<string, ModelExample[]>>;

// Prompt-feature × response-feature evidence, sharded by prompt feature. These are
// concrete responses for which both positive-pole codes are nonzero, ranked by balanced
// joint activation. They support relationship drill-ins; they do not establish causality.
export interface JointExample {
  prompt_activation: number;
  response_activation: number;
  joint_score: number;
  prompt: string;
  response: string;
  model: string;
  side: "a" | "b";
  outcome?: "win" | "loss" | "tie";
  group?: string;
  group_column?: string;
}
export interface JointExampleShard {
  prompt_feature: number;
  examples: Record<string, JointExample[]>;
}

export interface MapPoint {
  x: number;
  y: number;
  f: number; // dominant verified feature_id, or -1 if nothing fired
  m?: number; // dominant verified-feature activation magnitude (0 = noise)
  ma: string;
  mb: string;
  p: string; // prompt (clipped)
  ca?: string; // completion A (clipped)
  cb?: string; // completion B (clipped)
}

export interface MapData {
  n_total: number;
  n_sampled: number;
  metric: string;
  mode?: string; // sampling mode: random | top-activating | hybrid
  features: number[];
  concepts: string[];
  points: MapPoint[];
  clusters?: number[]; // cluster_id parallel to `features`
  behaviors?: Record<string, string>; // cluster_id -> behavior name
}

// --- prompt-space map (one point per battle, positioned by prompt latents) ---
export interface PromptMapPoint {
  x: number;
  y: number;
  f: number; // dominant positive-pole prompt feature_id, or -1 when none fires
  m?: number; // its activation magnitude
  pc: number; // prompt concept/cluster key (matches delta keyspace), or -1
  ma: string;
  mb: string;
  win: "A" | "B"; // human-preferred slot
  p: string; // prompt text (clipped)
  ca?: string; // response A (clipped)
  cb?: string; // response B (clipped)
  pf: { id: number; concept: string; z: number }[]; // prompt features firing (positive)
  cf: { id: number; concept: string; z: number; delta: number | null; sig: boolean }[]; // completion contrast (+ winner / − loser)
}
export interface PromptMapData {
  n_total: number;
  n_sampled: number;
  mode?: string;
  features: number[];
  concepts: string[];
  points: PromptMapPoint[];
  clusters?: number[]; // cluster_id parallel to `features`
  behaviors?: Record<string, string>;
}

// --- response-level feature map (one point per single response, individual lens) ---
export interface ResponseMapPoint {
  x: number;
  y: number;
  f: number; // dominant verified feature_id, or -1
  m?: number; // its activation magnitude
  side: "A" | "B"; // which response of the battle
  model: string;
  p: string; // prompt (clipped)
  r: string; // THIS response (clipped)
}
export interface ResponseMapData {
  n_total: number;
  n_sampled: number;
  mode?: string;
  features: number[];
  concepts: string[];
  points: ResponseMapPoint[];
  clusters?: number[];
  behaviors?: Record<string, string>;
}

// --- SAE feature atlas (one point per decoder direction; never sampled) ---
export interface FeatureMapPoint {
  feature_id: number;
  x: number;
  y: number;
  decoder_norm: number;
  zero_decoder: boolean;
}

export interface FeatureMapData {
  n_total: number;
  n_named: number;
  n_verified: number;
  n_zero_decoder: number;
  projection: "umap" | "svd" | string;
  basis: "sae_decoder_direction" | string;
  metric: "cosine" | string;
  seed: number;
  points: FeatureMapPoint[];
}

// --- confound screen ---
export interface BiasRow {
  feature_id: number;
  concept?: string;
  win_assoc?: number;
  correlation?: number;
  corr_confound_len?: number;
  correlation_resid_len?: number;
  confound_entangled?: boolean;
  fidelity_pass?: boolean;
}

// --- prompt-lens concepts ---
export interface PromptFeature {
  feature_id: number;
  concept?: string;
  fidelity_pass?: boolean;
  cluster_id?: number;
  behavior?: string;
  correlation?: number;
}
export interface PromptFeatures {
  features: PromptFeature[];
}

// Statistical co-firing communities. These organize feature axes; they do not merge
// their meanings. Member ids remain the canonical identity for examples and reports.
export interface FeatureClusterMember extends Partial<Omit<Feature, "feature_id">> {
  feature_id: number;
}
export interface FeatureCluster {
  cluster_id: number;
  supercluster_id?: number | null;
  label: string | null;
  n_features: number;
  n_named: number;
  n_verified: number;
  feature_ids: number[];
  representative_feature_ids: number[];
  representative_concepts: string;
  within_affinity_mean?: number | null;
  external_affinity_mean?: number | null;
  affinity_separation?: number | null;
  within_phi_mean?: number | null;
  negative_pair_fraction?: number | null;
  members: FeatureClusterMember[];
}
export interface FeatureClusterBundle {
  kind: "response" | "prompt";
  method: string | null;
  n_total_features: number;
  n_clustered_features: number;
  n_unclustered_features: number;
  n_clusters: number;
  unclustered_feature_ids: number[];
  diagnostics: Record<string, string | number | boolean | null> | null;
  clusters: FeatureCluster[];
}

export interface PromptExample {
  z: number;
  activation_percentile?: number;
  activation_reference?: "positive_activation" | string;
  selection_kind?: "strongest" | "group_strongest" | "random_present" | "near_threshold" | "near_boundary" | string;
  prompt: string;
  group?: string;
  group_column?: string;
}

// --- conditional δ_{f,k}: behavior win-relevance WITHIN each prompt type ---
export interface CondCell {
  pc: number; // prompt concept/type id
  f: number; // completion feature id
  delta: number; // length-controlled Δwin-rate within this prompt type
  p: number | null; // cond_p_bonferroni
  sig: boolean; // cond_significant
  n: number | null; // battles of this prompt type
  nf?: number | null; // battles of this type where the feature FIRES — the honest support
}
export interface ConditionalData {
  prompt_concepts: { id: number; name: string | null }[];
  features: { id: number; concept: string | null }[];
  cells: CondCell[];
  n_cells: number;
  n_significant: number;
}

// conditional.json wraps two keyspaces: RAW (individual prompt concepts, default) and
// CLUSTERED (prompt clusters). `clustered` is null when exported without the clustered CSV.
export interface ConditionalBundle {
  raw: ConditionalData | null;
  clustered: ConditionalData | null;
}

// --- prompt → response elicitation (co-activation lift, preference-independent) ---
export interface ElicEdge {
  px: number; // prompt feature id
  cy: number; // response (completion) feature id
  lift: number; // P(Y|X)/P(Y)
  l2: number; // log2 lift (signed; >0 elicits, <0 suppresses)
  pyx: number; // P(Y fires | X fires)
  py: number; // base rate P(Y)
  nx: number; // responses where X fires
  nco: number; // X&Y co-occurrences
  p: number | null; // p_bonferroni
  sig: boolean;
}
export interface ElicitationData {
  prompt_concepts: { id: number; concept: string | null }[];
  response_concepts: { id: number; concept: string | null }[];
  edges: ElicEdge[];
  n_edges: number; // full tested-and-reported count
  n_significant: number; // significant among ALL tested
  n_shown?: number; // how many edges survived the payload cap (≤ n_edges)
}

// --- report-card drill-in: per (model × prompt-concept) sample battles ---
export interface ReportBattle {
  prompt: string;
  self: string; // this model's answer
  other: string; // the opponent's answer
  other_model?: string;
  outcome?: "win" | "loss" | "tie";
  preference_probability?: number;
  preference_probability_swap_1?: number;
  preference_probability_swap_2?: number;
  prompt_activation?: number;
  row_id?: string;
}
// { model: { promptConceptName: ReportBattle[] } }
export type ReportBattles = Record<string, Record<string, ReportBattle[]>>;

// --- head-to-head: paired prompt-matched feature contrast between model pairs ---
// bpos[k] = # shared battles where feature k fires in model `a`'s answer but NOT `b`'s;
// cpos[k] = the reverse. a<b index into `models`. The viewer forms the paired estimate
// (bpos-cpos)/n and a McNemar test from (bpos,cpos); bpos+cpos is the effective sample.
export interface H2HPair {
  a: number;
  b: number;
  n: number; // shared battles
  bpos: number[]; // per-feature: a fires, b doesn't
  cpos: number[]; // per-feature: b fires, a doesn't
}
export interface HeadToHead {
  models: string[];
  features: number[]; // feature ids parallel to bpos/cpos
  concepts: (string | null)[];
  min_shared: number;
  pairs: H2HPair[];
}

// --- BYO model comparison (model_compare.json) — thin smoke view -----------
export interface MCConcept { f: number; concept: string }
export interface MCPowerRow { f: number; mean: number | null; fire: number | null }
export interface MCPair { a: string; b: string; n: number; n_decisive: number }
export interface MCContrastRow {
  f: number; contrast: number | null;
  pa: number | null; pb: number | null; fa: number | null; fb: number | null; won: number | null;
}
export interface MCDataset {
  source: string; n_battles: number;
  models: { name: string; n: number }[];
  pairs: MCPair[];
  model_power: Record<string, MCPowerRow[]>;
  pair_contrast: Record<string, MCContrastRow[]>;
}
export interface ModelCompare {
  concepts: MCConcept[]; n_concepts: number; verified_only: boolean; datasets: MCDataset[];
}

// --- paired, label-free response-set comparison -------------------------------
export type ResponseScope =
  | "general_tendency"
  | "context_specific_tendency"
  | "prompt_content"
  | "unclassified";

export interface PairedComparisonMeta {
  schema_version: number;
  analysis: "paired_response_concept_shift";
  side_a_name: string;
  side_b_name: string;
  n_pairs: number;
  n_features: number;
  confidence?: number;
  presence_policy: "calibrated" | "positive_nonzero" | "mixed";
  region_kind?: "prompt_concept" | "prompt_cluster" | null;
  preference_labels_used: false;
  activity_interpretation?: string;
}

export interface PairedConceptShift {
  feature_id: number;
  concept?: string | null;
  prevalence_a: number;
  prevalence_b: number;
  delta_b_minus_a: number;
  ci_low?: number | null;
  ci_high?: number | null;
  ci_method?: "hoeffding";
  n_pairs: number;
  n_groups: number;
  a_only: number;
  b_only: number;
  n_discordant: number;
  p_value: number;
  q_value: number;
  test: "exact_mcnemar" | "cluster_sign";
  presence_basis: "semantic_threshold" | "positive_nonzero" | "unspecified";
  semantic_role?: string | null;
  requested_share?: number | null;
  n_supported_contexts?: number;
  cross_context_consistency?: number | null;
  response_scope: ResponseScope;
}

export interface PairedContextShift extends PairedConceptShift {
  region_id: number;
  region_kind?: "prompt_concept" | "prompt_cluster";
  region_concept?: string | null;
  region_support: number;
  q_value_within_region: number;
}

export interface PairedComparisonExample {
  feature_id: number;
  concept?: string | null;
  direction: "a_only" | "b_only";
  item_id: string;
  prompt: string;
  response_a: string;
  response_b: string;
  activation_a: number;
  activation_b: number;
  side_a_name: string;
  side_b_name: string;
}

export interface PairedComparison {
  meta: PairedComparisonMeta;
  concepts: PairedConceptShift[];
  contexts: PairedContextShift[];
  examples: PairedComparisonExample[];
}

// --- Prompt-concept co-activation (coactivation.json) — compound prompts ----
export interface CoactPair { a: number; b: number; na: string; nb: string; lift: number; log2: number }
export interface Coactivation { n_pairs: number; n_significant: number; pairs: CoactPair[] }

// NOTE: the per-model "omissions" surface (omissions.json) was retired — winner-loser
// concept gaps are ≤5pp (presence ≠ quality; the prompt fixes content for both sides),
// so "what a model lacks that wins" isn't supportable. The Behavioural profile replaced
// it. The type + loader were removed with it.

export interface Bundle {
  meta: Meta;
  manifest: BundleManifest | null; // null = legacy bundle without a manifest
  features: Feature[];
  validation: ModelValidation[];
  diagnosis: Diagnosis | null;
  examples: Examples | null;
  bias: BiasRow[] | null;
  promptFeatures: PromptFeatures | null;
  conditional: ConditionalBundle | null;
  elicitation: ElicitationData | null;
  reportBattles: ReportBattles | null;
  headToHead: HeadToHead | null;
  modelCompare: ModelCompare | null;
  coactivation: Coactivation | null;
}

/** concept_distribution.json — how often each concept fires across the corpus. */
export interface ConceptDistributionFeature {
  feature_id: number;
  concept: string;
  n_active: number;
  fire_rate: number;
  mean_activation: number;
  max_activation?: number;
  group_fire_rate?: Record<string, number>;
}

export interface ConceptDistribution {
  n_rows: number;
  n_features: number;
  rows_with_any_concept: number;
  coverage: number;
  concepts_per_row: {
    mean: number;
    quantiles: Record<string, number>;
    histogram: number[];
  };
  dead_features: number[];
  groups: string[];
  group_totals?: Record<string, number>;
  group_column: string | null;
  code_array: string;
  selection?: "all" | "named" | "verified" | string;
  n_total_features?: number;
  features: ConceptDistributionFeature[];
}

/** coactivation.json — concept pairs that co-fire more than independence predicts. */
export interface CoactivationPair {
  a: number;
  b: number;
  a_concept?: string;
  b_concept?: string;
  count: number;
  lift: number;
  rows: number[];
}

export interface CoactivationExample {
  prompt: string;
  response?: string;
  /** Sparse values for axes participating in retained pairs on this row. */
  activations?: Record<string, number>;
  group?: string;
  group_column?: string;
}

export interface ConceptCoactivation {
  n_rows: number;
  examples?: Record<string, CoactivationExample>;
  min_pair_count: number;
  truncated: boolean;
  code_array: string;
  pairs: CoactivationPair[];
}
