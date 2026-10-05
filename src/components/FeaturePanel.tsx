import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type {
  BehaviorCategory, ConceptDistribution, ConditionalBundle, ElicitationData, Example, Feature,
} from "../types";
import {
  Card, Explain, ConceptLabel, conceptLabel, ConceptBarRow, Segmented, SkeletonList, clip, divergeColor, WINRATE_REF, VerifiedBadge,
} from "./ui";
import { fmt, pct, useDataArtifact, useFeatureExamples } from "../data";
import JointEvidence from "./JointEvidence";
import { VirtualList } from "./VirtualList";
import { ActivationEvidenceCard, EvidenceModeSelect, EvidencePager, ExampleGroupSelect, activationDomain, evidenceMode, evidenceModes, type EvidenceMode } from "./ActivationEvidence";
import { answerTypeOf, useAnalysisFilters } from "../analysisFilters";

// Feature-first hub (master-detail). Left: browse/sort/filter response features. Right:
// the selected feature's fire rate + reward (header, always visible) and three sub-tabs —
// Activated by (feature→prompt), Reward (Δwin by prompt type), Examples. Folds in the old
// Features table, Win relevance, Feature detail, response scopes, and Elicits' feature
// side. Corpus-marginal (aggregated over all models) — per-model lives in Model report.

type Sort = "reward" | "generality" | "fidelity" | "name";
type SubTab = "activated" | "reward" | "examples";

export default function FeaturePanel({
  features,
  elicitation,
  conditional,
  lensInputRep,
  hasLabels = true,
  focus,
  onJumpPrompt,
}: {
  features: Feature[];
  elicitation: ElicitationData | null;
  conditional: ConditionalBundle | null;
  lensInputRep?: string | null;
  hasLabels?: boolean;
  focus?: { cf: number } | null;
  onJumpPrompt?: (pc: number) => void;
}) {
  const cond = conditional?.raw ?? null;
  const [query, setQuery] = useState("");
  // no preference labels → no reward signal; default-sort by pervasiveness instead.
  const [sortBy, setSortBy] = useState<Sort>(hasLabels ? "reward" : "generality");
  const [category, setCategory] = useState<"" | BehaviorCategory>("");
  // verified features are the only ones with elicitation/conditional data, so default to
  // them — otherwise browsing lands on unverified features with empty sub-tabs. But if the
  // bundle was never verified at all, defaulting to true would render an EMPTY list.
  const anyVerified = useMemo(() => features.some((f) => f.fidelity_pass), [features]);
  const hasInferentialEffects = useMemo(
    () => features.some((f) => f.delta_win_rate != null || f.win_significant != null),
    [features],
  );
  const [verifiedOnly, setVerifiedOnly] = useState(anyVerified);
  const [sel, setSel] = useState<number | null>(null);
  const [sub, setSub] = useState<SubTab>("activated");
  const { filters } = useAnalysisFilters();
  const distribution = useDataArtifact<ConceptDistribution>("concept_distribution.json");
  const groupRates = useMemo(() => new Map(
    (distribution?.features ?? []).map((feature) => [
      feature.feature_id,
      filters.group ? feature.group_fire_rate?.[filters.group] ?? 0 : feature.fire_rate,
    ]),
  ), [distribution, filters.group]);

  const hasContextClassification = useMemo(
    () => features.some((f) => f.behavior_category != null), [features]);
  useEffect(() => {
    if (!hasContextClassification && category !== "" && category !== "unclassified") {
      setCategory("");
    }
  }, [hasContextClassification, category]);

  const named = useMemo(() => features.filter((f) => f.concept && f.concept.trim() !== ""), [features]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let r = named.filter((f) => !q || (f.concept ?? "").toLowerCase().includes(q));
    if (filters.group) r = r.filter((f) => (groupRates.get(f.feature_id) ?? 0) > 0);
    if (filters.answerType !== "all") r = r.filter((f) => answerTypeOf(f) === filters.answerType);
    if (verifiedOnly) r = r.filter((f) => f.fidelity_pass);
    if (category) r = r.filter((f) =>
      (f.behavior_category ?? "unclassified") === category);
    const rew = (f: Feature) => f.delta_win_rate ?? f.win_assoc ?? 0;
    return [...r].sort((a, b) => {
      if (sortBy === "reward") return Math.abs(rew(b)) - Math.abs(rew(a));
      if (sortBy === "generality") return (groupRates.get(b.feature_id) ?? b.generality ?? -1) - (groupRates.get(a.feature_id) ?? a.generality ?? -1);
      if (sortBy === "fidelity") return Number(b.fidelity_pass ?? false) - Number(a.fidelity_pass ?? false) || Math.abs(rew(b)) - Math.abs(rew(a));
      return (a.concept ?? "").localeCompare(b.concept ?? "");
    });
  }, [named, query, category, verifiedOnly, sortBy, filters.group, filters.answerType, groupRates]);

  // default / cross-tab focus selection
  const handledFocus = useRef<unknown>(null);
  useEffect(() => {
    if (focus && handledFocus.current !== focus) { setSel(focus.cf); handledFocus.current = focus; }
    // default to the first VERIFIED feature — only verified axes carry elicitation /
    // conditional data, so opening on an unverified one would show empty sub-tabs.
    else if (sel == null && rows.length) setSel((rows.find((f) => f.fidelity_pass) ?? rows[0]).feature_id);
  }, [focus, rows, sel]);

  const feat = features.find((f) => f.feature_id === sel) ?? null;
  const selectionHidden = sel != null && !rows.some((f) => f.feature_id === sel);
  const exItems = useFeatureExamples(sel); // lazy per-feature shard, cached

  // Activated-by / Reward-by-prompt are pipeline-gated to VERIFIED features, so they're
  // always empty for unverified ones — show only Examples there (no dead-click tabs).
  const subTabs = useMemo<[SubTab, string][]>(() => {
    const all: [SubTab, string][] = [
      ["activated", "Activated by"], ["reward", "Preference by prompt"], ["examples", "Examples"],
    ];
    return all.filter(([v]) => {
      if (v === "examples") return true;
      if (!feat?.fidelity_pass) return false;
      if (v === "reward") return hasLabels && cond != null;
      return true;
    });
  }, [feat, hasLabels, cond]);
  // derived so the active tab is always valid for the current feature (→ Examples).
  const activeSub: SubTab = subTabs.some(([v]) => v === sub) ? sub : "examples";

  return (
    <div className="flex flex-col gap-4">
      <Explain>
        Browse by <b>answer concept</b>. Pick one to see how often it appears, which prompts bring
        it out,{hasLabels && <> how it is associated with the dataset preference outcome
        (Δ preference in <b>pp</b>; length-controlled when that estimate is available, otherwise the raw probability gap), and where it
        is associated with stronger or weaker preference outcomes,</>} with example answers.
      </Explain>
      {filters.group && (
        <p className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs text-amber-200/80">
          The list, answer share, and examples use {filters.groupColumn}={filters.group}. Prompt links{cond ? " and conditional preference estimates" : ""} still use all languages.
        </p>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* master list */}
        <Card className="h-fit lg:sticky lg:top-4">
          <div className="grid gap-3">
            <label className="block">
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">Search response concepts</span>
              <span className="relative block">
                <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-slate-500" />
                <input value={query} onChange={(e) => setQuery(e.target.value)}
                  placeholder="filter response features…"
                  className="w-full rounded-lg border border-edge bg-ink py-2 pl-8 pr-2 text-sm outline-none placeholder:text-slate-600 focus:border-accent/60" />
              </span>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">Sort by</span>
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value as Sort)}
                  className="w-full rounded-lg border border-edge bg-ink px-2 py-2 text-xs text-slate-300 outline-none focus:border-accent/60">
                  {hasLabels && <option value="reward">Preference association</option>}
                  <option value="generality">Fire rate</option>
                  <option value="fidelity">Label check</option>
                  <option value="name">Name</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">Category</span>
                <select value={category} onChange={(e) => setCategory(e.target.value as "" | BehaviorCategory)}
                  className="w-full rounded-lg border border-edge bg-ink px-2 py-2 text-xs text-slate-300 outline-none focus:border-accent/60">
                  <option value="">All</option>
                  {hasContextClassification ? <>
                    <option value="general">General</option>
                    <option value="context_specific">Context-specific</option>
                    <option value="prompt_content">Prompt/content</option>
                  </> : null}
                  <option value="unclassified">Unclassified</option>
                </select>
              </label>
            </div>
            {!hasContextClassification && <p className="text-[10px] text-amber-400/80">
              No concept types were exported.
            </p>}
            <label className="flex items-start gap-2 rounded-lg bg-ink/35 p-2 text-[11px] leading-snug text-slate-400">
              <input type="checkbox" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} className="mt-0.5 accent-accent" />
              <span><b className="font-medium text-slate-300">Checked labels only</b><br />Unchecked concepts may not have prompt-association results.</span>
            </label>
            <div className="flex items-center justify-between border-t border-edge/60 pt-2 text-[11px] text-slate-500">
              <span>{rows.length.toLocaleString()} of {named.length.toLocaleString()} response concepts</span>
              {(query || category || verifiedOnly !== anyVerified) && <button onClick={() => { setQuery(""); setCategory(""); setVerifiedOnly(anyVerified); }} className="text-accent hover:text-accent/80">Reset filters</button>}
            </div>
          </div>
          {selectionHidden && (
            <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-2 text-[11px] leading-snug text-amber-200/80">
              Your selected response concept is hidden by the filters; its details remain open.
            </div>
          )}
          <div className="mt-3 border-t border-edge/60 pt-2 pr-1">
            <VirtualList
              items={rows}
              rowHeight={58}
              height={Math.round(typeof window === "undefined" ? 520 : window.innerHeight * 0.58)}
              emptyMessage="No feature matches."
              renderRow={(f) => {
              const rew = f.delta_win_rate ?? f.win_assoc ?? 0;
              const rsig = f.delta_win_significant ?? f.win_significant ?? false;
              const tested = f.delta_win_rate != null || f.win_significant != null;
              const rewardKind = f.delta_win_rate != null
                ? "length-controlled Δ preference score"
                : "raw mean preference-probability gap";
              const fireRate = groupRates.get(f.feature_id) ?? f.generality;
              return (
                <button onClick={() => setSel(f.feature_id)}
                  className={`flex h-full w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition ${
                    sel === f.feature_id ? "bg-accent/20 text-slate-100" : "text-slate-300 hover:bg-edge/40"}`}>
                  {!verifiedOnly && (
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${f.fidelity_pass ? "bg-good ring-2 ring-good/10" : "bg-slate-700"}`}
                      title={f.fidelity_pass ? "label check passed" : "label not checked"}
                      aria-label={f.fidelity_pass ? "label check passed" : "label not checked"} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block overflow-hidden" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                      <ConceptLabel id={f.feature_id} name={f.concept} wrap />
                    </span>
                    <span className="block text-[10px] tabular-nums text-slate-600" title="fire rate: % of responses this feature appears in">
                      appears in {fireRate != null ? `${(fireRate * 100).toFixed(fireRate < 0.01 ? 1 : 0)}%` : "—"}
                    </span>
                  </span>
                  {hasLabels && (
                    <>
                      {/* bar and its number are the SAME quantity (reward), same normalization */}
                      <span className={`hidden h-2 w-16 shrink-0 overflow-hidden rounded-full bg-edge/40 sm:block ${tested && !rsig ? "opacity-40" : ""}`}
                        title={`${rewardKind} ${fmt(rew, 2)}${tested && !rsig ? " (not significant)" : !tested ? " (descriptive only)" : ""}`}>
                        <span className="block h-full rounded-full" style={{ width: `${Math.round(Math.min(1, Math.abs(rew) / WINRATE_REF) * 100)}%`, background: divergeColor(rew, WINRATE_REF) }} />
                      </span>
                      <span className={`w-12 shrink-0 text-right text-[11px] tabular-nums ${tested && !rsig ? "text-slate-600" : "text-slate-400"}`}
                        title={tested ? (rsig ? rewardKind : `${rewardKind} — not significant`) : `${rewardKind} — descriptive only`}>
                        {rew >= 0 ? "+" : ""}{Math.round(rew * 100)}pp{tested && !rsig ? "*" : ""}
                      </span>
                    </>
                  )}
                </button>
              );
            }}
            />
            {hasLabels && hasInferentialEffects && <p className="px-2 pt-1 text-[10px] text-slate-600">* = not statistically significant</p>}
          </div>
        </Card>

        {/* detail */}
        {!feat ? <Card>Pick a feature.</Card> : (
          <div className="min-w-0 flex flex-col gap-4">
            <Card>
              <h3 className="text-lg font-semibold leading-snug text-slate-100">
                <ConceptLabel id={feat.feature_id} name={feat.concept} wrap />
                <span className="ml-2 whitespace-nowrap rounded bg-edge/60 px-1.5 py-0.5 align-middle font-mono text-[10px] font-normal text-slate-500">
                  f{feat.feature_id}
                </span>
              </h3>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
                <Stat label="answer share" value={(groupRates.get(feat.feature_id) ?? feat.generality) != null
                  ? pct(groupRates.get(feat.feature_id) ?? feat.generality, (groupRates.get(feat.feature_id) ?? feat.generality ?? 0) < 0.01 ? 1 : 0)
                  : "—"}
                  sub="answers where it appears" />
                {hasLabels && (() => {
                  const rsig = feat.delta_win_significant ?? feat.win_significant ?? false;
                  const tested = feat.delta_win_rate != null || feat.win_significant != null;
                  const effect = feat.delta_win_rate ?? feat.win_assoc;
                  const kind = feat.delta_win_rate != null ? "length-controlled" : "raw probability gap";
                  const suffix = tested && !rsig ? " (ns)" : "";
                  const detail = effect == null
                    ? "not available"
                    : !tested
                      ? `${kind}; descriptive only`
                      : rsig
                        ? kind
                        : `${kind}; not statistically significant`;
                  return (
                    <Stat label="preference association"
                      value={effect != null ? `${effect >= 0 ? "+" : ""}${(effect * 100).toFixed(0)}pp${suffix}` : "—"}
                      sub={detail}
                      tone={tested && rsig ? effect : null} />
                  );
                })()}
                <Stat label="prompt types" value={feat.n_prompt_types != null ? String(feat.n_prompt_types) : "—"} sub="sig. elicitors" />
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-slate-500">label check</div>
                  <div className="mt-0.5"><VerifiedBadge pass={feat.fidelity_pass} n={feat.fidelity_n} /></div>
                </div>
              </div>
              <FidelityMetrics f={feat} />
              {feat.semantic_role && (
                <div className="mt-3 border-t border-edge/60 pt-2">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Concept type
                  </p>
                  {feat.feature_summary && (
                    <p className="mt-1 text-xs leading-relaxed text-slate-300">
                      {feat.feature_summary}
                    </p>
                  )}
                  <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                    {String(feat.semantic_family ?? "unclassified").replace(/_/g, " ")}
                    {` · role: ${String(feat.semantic_role).replace(/_/g, " ")}`}
                    {feat.prompt_relation && ` · ${String(feat.prompt_relation).replace(/_/g, " ")}`}
                    {feat.n_present != null && feat.n_examples != null
                      && ` · visible in ${feat.n_present}/${feat.n_examples} sampled activations`}
                    {feat.role_confidence && ` · ${feat.role_confidence} confidence`}
                  </p>
                </div>
              )}
              <p className="mt-2 text-[11px] text-slate-500">
                category: <span className="text-slate-300">{
                  (feat.behavior_category ?? "unclassified").replace(/_/g, " ")
                }</span>
                {feat.presence_pass
                  ? <> · label cutoff checked</>
                  : <> · no checked label cutoff</>}
              </p>
              {feat.behavior && <p className="mt-2 text-[11px] text-slate-500">cluster: {feat.behavior}</p>}
            </Card>

            <Segmented value={activeSub} onChange={(v) => setSub(v)}
              options={subTabs.map(([v, lbl]) => ({ value: v, label: lbl }))} />

            {activeSub === "activated" && <ActivatedBy elicitation={elicitation} fid={feat.feature_id} responseName={feat.concept} unverified={!feat.fidelity_pass} onJumpPrompt={onJumpPrompt} />}
            {activeSub === "reward" && <RewardByPrompt cond={cond} fid={feat.feature_id} responseName={feat.concept} overall={feat.delta_win_rate} unverified={!feat.fidelity_pass} onJumpPrompt={onJumpPrompt} />}
            {activeSub === "examples" && <FeatureExamples items={exItems} concept={conceptLabel(feat.feature_id, feat.concept)}
              contrastOnly={lensInputRep === "difference" || lensInputRep === "individual"}
              semanticThreshold={feat.semantic_threshold} />}
          </div>
        )}
      </div>
    </div>
  );
}

// held-out verification metrics, as scannable label/value chips. Shown for any tested
// feature — verified OR not — so a failed axis reveals WHY it failed. The pass gate is
// |corr| ≥ 0.3 with Bonferroni p < 0.05, so the corr chip is tinted by that gate.
// `n` is deliberately NOT repeated here — the VerifiedBadge above already shows it.
function FidelityMetrics({ f }: { f: Feature }) {
  const num = (x?: number, d = 2) => (x == null || Number.isNaN(x) ? null : x.toFixed(d));
  const chips: { k: string; v: string; tip: string; tone?: "good" | "bad" }[] = [];
  const add = (k: string, v: string | null, tip: string, tone?: "good" | "bad") => {
    if (v != null) chips.push({ k, v, tip, tone });
  };
  add("F1", num(f.f1), "harmonic mean of precision and recall on held-out examples");
  add("precision", num(f.precision), "when the verifier said 'label present', how often the feature fired");
  add("recall", num(f.recall), "of the examples where the feature fired, how many the verifier confirmed");
  add("FP rate", num(f.fp_rate), "how often the verifier saw the label where the feature was silent");
  add("corr", num(f.correlation),
    "verifier-vs-feature correlation on held-out examples — one input to the configured multi-part pass rule");
  add("agreement", num(f.agreement), "raw verifier/feature agreement rate");
  if (!chips.length) return null;
  return (
    <div className="mt-3 border-t border-edge/60 pt-2">
      <p className="mb-1.5 text-[11px] text-slate-500">
        <span className="uppercase tracking-wider">verification</span>
        {f.fidelity_n != null && <> — an LLM verifier re-judged {f.fidelity_n} held-out examples against this label</>}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map(({ k, v, tip, tone }) => (
          <span key={k} title={tip}
            className="rounded-md border border-edge/60 bg-ink/50 px-1.5 py-0.5 text-[11px] text-slate-400">
            {k}{" "}
            <b className={`tabular-nums ${tone === "good" ? "text-good" : tone === "bad" ? "text-amber-400" : "text-slate-200"}`}>
              {v}
            </b>
          </span>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: number | null }) {
  const color = tone == null ? "text-slate-100" : tone > 0 ? "text-good" : tone < 0 ? "text-bad" : "text-slate-100";
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`text-base font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

function ActivatedBy({ elicitation, fid, responseName, unverified, onJumpPrompt }: {
  elicitation: ElicitationData | null;
  fid: number;
  responseName: string | null | undefined;
  unverified?: boolean;
  onJumpPrompt?: (pc: number) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const rows = useMemo(() => {
    if (!elicitation) return [];
    const nameOf = new Map(elicitation.prompt_concepts.map((p) => [p.id, p.concept]));
    const edges = elicitation.edges.filter((e) => e.cy === fid && e.l2 > 0 && (showAll || e.sig)).sort((a, b) => b.lift - a.lift).slice(0, 16);
    const maxL2 = Math.max(0.5, ...edges.map((e) => e.l2));
    return edges.map((e) => ({ id: e.px, name: nameOf.get(e.px) ?? null, lift: e.lift,
      pyx: e.pyx, sig: e.sig, nx: e.nx, nco: e.nco, w: e.l2 / maxL2 }));
  }, [elicitation, fid, showAll]);
  useEffect(() => { setSelected(null); }, [fid]);
  useEffect(() => {
    if (selected == null || !rows.some((r) => r.id === selected))
      setSelected(rows[0]?.id ?? null);
  }, [rows, selected]);
  const active = rows.find((r) => r.id === selected) ?? null;
  return (
    <div className="flex flex-col gap-3">
      <Card>
      <h4 className="text-sm font-semibold text-slate-200">Activated by these prompts</h4>
      <p className="mb-2 mt-0.5 text-[11px] text-slate-500">Prompt concepts whose presence raises this feature's firing. Select one to inspect a concrete prompt and response carrying both concepts.</p>
      {elicitation && elicitation.edges.some((e) => e.cy === fid && e.l2 > 0 && !e.sig) && (
        <label className="mb-2 flex items-center gap-1.5 text-[11px] text-slate-500">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-accent" />
          show non-significant estimates
        </label>
      )}
      {rows.length === 0 ? <p className="px-1 py-3 text-sm text-slate-500">
        {!elicitation ? "Prompt→answer links were not included in this dataset."
          : unverified ? "This name has not passed its label check, so prompt links were not calculated."
          : "No specific prompt raises this feature above its base rate (it fires broadly)."}</p> :
        rows.map((r) => <ConceptBarRow key={r.id} id={r.id} name={r.name} value={`×${r.lift.toFixed(1)}`}
          title={`lift ×${r.lift.toFixed(2)} · fires ${pct(r.pyx, 0)}${r.sig ? "" : " (ns)"}`}
          detail={`${r.nco.toLocaleString()} co-occurrences · ${r.nx.toLocaleString()} prompt activations`}
          width={r.w} color="rgba(96,165,250,0.85)" dim={!r.sig}
          selected={selected === r.id} onClick={() => setSelected(r.id)} />)}
      </Card>
      {active && <JointEvidence promptFeature={active.id} responseFeature={fid}
        promptName={active.name} responseName={responseName} kind="elicitation"
        onOpenPrompt={onJumpPrompt ? () => onJumpPrompt(active.id) : undefined} />}
    </div>
  );
}

function RewardByPrompt({ cond, fid, responseName, overall, unverified, onJumpPrompt }: {
  cond: import("../types").ConditionalData | null;
  fid: number;
  responseName: string | null | undefined;
  overall?: number;
  unverified?: boolean;
  onJumpPrompt?: (pc: number) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const rows = useMemo(() => {
    if (!cond) return [];
    const nameOf = new Map(cond.prompt_concepts.map((p) => [p.id, p.name]));
    const cells = cond.cells.filter((c) => c.f === fid && (showAll || c.sig)).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 16);
    const maxD = Math.max(0.02, ...cells.map((c) => Math.abs(c.delta)));
    return cells.map((c) => ({ id: c.pc, name: nameOf.get(c.pc) ?? null, delta: c.delta, sig: c.sig,
      n: c.n ?? null, nf: c.nf ?? null, w: Math.abs(c.delta) / maxD }));
  }, [cond, fid, showAll]);
  useEffect(() => { setSelected(null); }, [fid]);
  useEffect(() => {
    if (selected == null || !rows.some((r) => r.id === selected))
      setSelected(rows[0]?.id ?? null);
  }, [rows, selected]);
  const active = rows.find((r) => r.id === selected) ?? null;
  return (
    <div className="flex flex-col gap-3">
      <Card>
      <h4 className="text-sm font-semibold text-slate-200">Preference association by prompt type</h4>
      <p className="mb-2 mt-0.5 text-[11px] text-slate-500">
        Estimated preference-score difference associated with this feature within each prompt type (length-controlled; not causal).
        {overall != null && <> Overall: <span className="text-slate-300">{overall >= 0 ? "+" : ""}{(overall * 100).toFixed(0)}pp</span>.</>} Faded = not significant.
      </p>
      {cond && cond.cells.some((c) => c.f === fid && !c.sig) && (
        <label className="mb-2 flex items-center gap-1.5 text-[11px] text-slate-500">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-accent" />
          show non-significant estimates
        </label>
      )}
      {rows.length === 0 ? <p className="px-1 py-3 text-sm text-slate-500">
        {!cond ? "No conditional preference results were included in this dataset."
          : unverified ? "This name has not passed its label check, so per-prompt preference results were not calculated."
          : "No prompt-type preference data for this feature."}</p> :
        rows.map((r) => (
          <ConceptBarRow key={r.id} id={r.id} name={r.name} value={`${r.delta >= 0 ? "+" : ""}${Math.round(r.delta * 100)}pp`}
            title={`preference-score difference ${(r.delta * 100).toFixed(1)}pp${r.sig ? " (significant)" : " (ns)"}`}
            detail={r.nf != null ? `${r.nf.toLocaleString()} fires / ${(r.n ?? 0).toLocaleString()} battles` : r.n != null ? `${r.n.toLocaleString()} battles` : undefined}
            width={r.w} color={divergeColor(r.delta, WINRATE_REF)} dim={!r.sig}
            selected={selected === r.id} onClick={() => setSelected(r.id)} />
        ))}
      </Card>
      {active && <JointEvidence promptFeature={active.id} responseFeature={fid}
        promptName={active.name} responseName={responseName} kind="preference"
        onOpenPrompt={onJumpPrompt ? () => onJumpPrompt(active.id) : undefined} />}
    </div>
  );
}

function FeatureExamples({ items: raw, concept, contrastOnly, semanticThreshold }: {
  items: Example[] | null | undefined;
  concept: string;
  contrastOnly?: boolean;
  semanticThreshold?: number | null;
}) {
  // Single-response data has no second answer, so there is no side to choose and no
  // contrast to report: the activation is simply the concept's strength on that response.
  const paired = useMemo(
    () => (raw ?? []).some((e) => Boolean(e.completion_b)),
    [raw],
  );
  const { filters, setGroup } = useAnalysisFilters();
  const group = filters.group;
  const [mode, setMode] = useState<EvidenceMode>("strongest");
  const [exampleIndex, setExampleIndex] = useState(0);
  useEffect(() => { setMode("strongest"); setExampleIndex(0); }, [concept]);
  useEffect(() => { setExampleIndex(0); }, [group, mode]);
  const allItems = useMemo(() => {
    return (raw ?? []).map((e) => {
      const aSide = e.z >= 0; // A exhibits the feature more when z_diff > 0
      return {
        z: e.z,
        prompt: e.prompt,
        model: paired ? (aSide ? e.model_a : e.model_b) : "",
        completion: paired ? (aSide ? e.completion_a : e.completion_b) : e.completion_a,
        group: e.group,
        groupColumn: e.group_column,
        activationPercentile: e.activation_percentile,
        activationReference: e.activation_reference,
        selectionKind: e.selection_kind,
      };
    }).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  }, [raw, paired]);
  const groups = useMemo(() => [...new Set(allItems.map((item) => item.group).filter((value): value is string => Boolean(value)))].sort(), [allItems]);
  const modes = useMemo(() => evidenceModes(allItems.map((item) => ({ selection_kind: item.selectionKind }))), [allItems]);
  const effectiveMode = modes.includes(mode) ? mode : modes[0] ?? "strongest";
  const items = useMemo(() => allItems.filter((item) =>
    (!group || item.group === group) && evidenceMode(item.selectionKind) === effectiveMode,
  ).slice(0, 12), [allItems, group, effectiveMode]);
  const domain = useMemo(() => activationDomain(allItems.map((item) => item.z)), [allItems]);
  const groupColumn = allItems.find((item) => item.groupColumn)?.groupColumn ?? "language";
  const loading = raw === undefined;
  if (loading)
    return (
      <Card>
        <h4 className="mb-2 text-sm font-semibold text-slate-200">Strongest examples of “{concept}”</h4>
        <SkeletonList n={3} itemClass="h-24" />
      </Card>
    );
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3"><h4 className="text-sm font-semibold text-slate-200">Evidence for “{concept}”</h4><div className="flex flex-wrap items-center gap-3"><EvidenceModeSelect modes={modes} value={effectiveMode} onChange={setMode} /><ExampleGroupSelect groups={groups} value={group} onChange={(value) => setGroup(value, groupColumn)} column={groupColumn} /><EvidencePager index={Math.min(exampleIndex, Math.max(0, items.length - 1))} count={items.length} onChange={setExampleIndex} /></div></div>
      {contrastOnly && paired && (
        <p className="mt-1 text-[11px] leading-relaxed text-amber-300/80">
          Selected by relative axis contrast: this side scores above the paired answer. That
          alone does not prove positive-pole concept presence.
        </p>
      )}
      {items.length === 0 ? <p className="mt-1 px-1 py-3 text-xs text-slate-500">No examples for this feature in the bundle.</p> : (
        <div className="mt-2">
          {(() => { const it = items[exampleIndex] ?? items[0]; return <ActivationEvidenceCard prompt={it.prompt}
            response={it.completion} value={it.z} min={domain.min} max={domain.max}
            label={paired ? "A−B contrast" : "Activation"} model={it.model}
            percentile={it.activationPercentile}
            threshold={it.activationReference === "positive_activation" ? semanticThreshold : null}
            selectionKind={it.selectionKind} />; })()}
        </div>
      )}
    </Card>
  );
}
