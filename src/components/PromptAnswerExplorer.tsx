import { ArrowRight, MessageSquareText, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { answerTypeOf, useAnalysisFilters } from "../analysisFilters";
import { normalizeConditional, pct, useDataArtifact } from "../data";
import type { ConceptDistribution, ElicitationData, Feature } from "../types";
import { Card, ConceptLabel, Explain, Segmented, SkeletonList, conceptLabel } from "./ui";
import JointEvidence from "./JointEvidence";

type Rank = "probability" | "enrichment" | "support" | "preference";

const pp = (value: number) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp`;

export default function PromptAnswerExplorer({
  features,
  hasLabels,
}: {
  features: Feature[];
  hasLabels: boolean;
}) {
  const elicitation = useDataArtifact<ElicitationData>("elicitation.json");
  const conditionalRaw = useDataArtifact<unknown>(hasLabels ? "conditional.json" : null);
  const promptDistribution = useDataArtifact<ConceptDistribution>("prompt_concept_distribution.json");
  const { filters } = useAnalysisFilters();
  const [query, setQuery] = useState("");
  const [selectedPrompt, setSelectedPrompt] = useState<number | null>(null);
  const [selectedResponse, setSelectedResponse] = useState<number | null>(null);
  const [rank, setRank] = useState<Rank>("probability");

  const conditional = useMemo(() => normalizeConditional(conditionalRaw)?.raw ?? null, [conditionalRaw]);
  const relationGrid = conditional
    ? "grid-cols-[minmax(0,1fr)_76px_65px] sm:grid-cols-[minmax(0,1fr)_90px_70px_90px]"
    : "grid-cols-[minmax(0,1fr)_76px_65px]";
  const featureById = useMemo(() => new Map(features.map((feature) => [feature.feature_id, feature])), [features]);
  const promptRate = useMemo(() => new Map(
    (promptDistribution?.features ?? []).map((feature) => [feature.feature_id,
      filters.group ? feature.group_fire_rate?.[filters.group] ?? 0 : feature.fire_rate]),
  ), [promptDistribution, filters.group]);

  const prompts = useMemo(() => {
    if (!elicitation) return [];
    const q = query.trim().toLowerCase();
    const support = new Map<number, { count: number; n: number }>();
    for (const edge of elicitation.edges) {
      if (edge.l2 <= 0) continue;
      const current = support.get(edge.px) ?? { count: 0, n: 0 };
      current.count += 1;
      current.n = Math.max(current.n, edge.nx);
      support.set(edge.px, current);
    }
    return elicitation.prompt_concepts
      .filter((prompt) => !q || conceptLabel(prompt.id, prompt.concept).toLowerCase().includes(q) || String(prompt.id) === q)
      .map((prompt) => ({ ...prompt, ...support.get(prompt.id), rate: promptRate.get(prompt.id) ?? 0 }))
      .filter((prompt) => !filters.group || prompt.rate > 0)
      .sort((a, b) => b.rate - a.rate || (b.n ?? 0) - (a.n ?? 0));
  }, [elicitation, query, promptRate, filters.group]);

  useEffect(() => {
    if (selectedPrompt == null || !prompts.some((prompt) => prompt.id === selectedPrompt)) {
      setSelectedPrompt(prompts[0]?.id ?? null);
      setSelectedResponse(null);
    }
  }, [prompts, selectedPrompt]);

  const relations = useMemo(() => {
    if (!elicitation || selectedPrompt == null) return [];
    const conditionalByFeature = new Map(
      (conditional?.cells ?? []).filter((cell) => cell.pc === selectedPrompt).map((cell) => [cell.f, cell]),
    );
    const rows = elicitation.edges
      .filter((edge) => edge.px === selectedPrompt && edge.l2 > 0)
      .map((edge) => ({ edge, feature: featureById.get(edge.cy), preference: conditionalByFeature.get(edge.cy) }))
      .filter(({ feature }) => filters.answerType === "all" || answerTypeOf(feature) === filters.answerType);
    const compare: Record<Rank, (a: typeof rows[number], b: typeof rows[number]) => number> = {
      probability: (a, b) => b.edge.pyx - a.edge.pyx,
      enrichment: (a, b) => b.edge.lift - a.edge.lift,
      support: (a, b) => b.edge.nco - a.edge.nco,
      preference: (a, b) => Math.abs(b.preference?.delta ?? 0) - Math.abs(a.preference?.delta ?? 0),
    };
    return rows.sort(compare[rank]);
  }, [elicitation, selectedPrompt, conditional, featureById, filters.answerType, rank]);

  useEffect(() => {
    if (selectedResponse == null || !relations.some(({ edge }) => edge.cy === selectedResponse))
      setSelectedResponse(relations[0]?.edge.cy ?? null);
  }, [relations, selectedResponse]);

  if (elicitation === undefined || promptDistribution === undefined || (hasLabels && conditionalRaw === undefined))
    return <SkeletonList n={3} itemClass="h-40" />;
  if (!elicitation)
    return <Card><p className="text-sm text-slate-500">This dataset does not include prompt→answer links.</p></Card>;

  const promptName = elicitation.prompt_concepts.find((prompt) => prompt.id === selectedPrompt)?.concept;
  const selected = relations.find(({ edge }) => edge.cy === selectedResponse);
  const maxProbability = relations.reduce((maximum, row) => Math.max(maximum, row.edge.pyx), 0) || 1;

  return (
    <div className="space-y-4">
      <Explain>
        Choose a prompt type to see which answer-feature activations occur with it. <b>Here</b> is
        the share of these prompts whose answer has positive activity on the feature. <b>Compared</b> says
        how many times more common that activation is here than in the full dataset. {conditional && <>
        The last column shows its conditional preference association.</>}
      </Explain>

      {filters.group && (
        <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs leading-relaxed text-amber-200/80">
          Prompt counts and examples use {filters.groupColumn}={filters.group}.
          The prompt→answer percentages still use all languages because separate results by language were not exported.
        </div>
      )}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card className="min-w-0">
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-slate-500" />
            <input value={query} onChange={(event) => setQuery(event.target.value)}
              aria-label="Search prompt concepts" placeholder="Search prompt concepts…"
              className="w-full rounded-lg border border-edge bg-ink py-2 pl-8 pr-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-accent/60" />
          </div>
          <div className="mt-3 max-h-[650px] space-y-1 overflow-auto pr-1">
            {prompts.map((prompt) => (
              <button key={prompt.id} type="button" onClick={() => { setSelectedPrompt(prompt.id); setSelectedResponse(null); }}
                className={`w-full rounded-xl px-3 py-2.5 text-left ${selectedPrompt === prompt.id ? "bg-accent/15 ring-1 ring-inset ring-accent/30" : "hover:bg-edge/35"}`}>
                <div className="flex items-start gap-2">
                  <MessageSquareText size={13} className="mt-0.5 shrink-0 text-sky-300/70" />
                  <span className="min-w-0 flex-1 text-sm leading-snug text-slate-300"><ConceptLabel id={prompt.id} name={prompt.concept} wrap /></span>
                </div>
                <div className="mt-1.5 flex justify-between gap-3 pl-5 text-[10px] text-slate-600">
                  <span>{pct(prompt.rate, 1)} of prompts</span>
                  <span>{prompt.count ?? 0} answer concepts</span>
                </div>
              </button>
            ))}
          </div>
        </Card>

        <div className="min-w-0 space-y-4">
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-sky-300/70">Selected prompt concept</div>
                <h2 className="mt-1 text-xl font-semibold leading-snug text-slate-50">
                  {selectedPrompt == null ? "Choose a prompt concept" : <ConceptLabel id={selectedPrompt} name={promptName} wrap />}
                </h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <Segmented value={rank} onChange={setRank} options={[
                  { value: "probability" as const, label: "Most common" },
                  { value: "enrichment" as const, label: "Most unusual here" },
                  { value: "support" as const, label: "Most evidence" },
                  ...(conditional ? [{ value: "preference" as const, label: "Largest preference association" }] : []),
                ]} />
              </div>
            </div>
          </Card>

          <Card>
            <div className={`mb-3 grid ${relationGrid} gap-3 px-2 text-[9px] font-semibold uppercase tracking-wider text-slate-600`}>
              <span>Answer concept</span><span className="text-right">Here</span><span className="text-right" title="Times more common here than in the whole dataset">Compared</span>{conditional && <span className="text-right">Preference gap</span>}
            </div>
            <div className="max-h-[560px] space-y-1 overflow-auto pr-1">
              {relations.length === 0 ? <p className="px-2 py-8 text-center text-sm text-slate-500">No positive relationship matches these filters.</p> : relations.map(({ edge, feature, preference }) => (
                <button key={edge.cy} type="button" onClick={() => setSelectedResponse(edge.cy)}
                  className={`grid w-full ${relationGrid} items-center gap-3 rounded-xl px-2 py-2.5 text-left ${selectedResponse === edge.cy ? "bg-accent/12 ring-1 ring-inset ring-accent/25" : "hover:bg-edge/35"}`}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm text-slate-300"><ArrowRight size={12} className="shrink-0 text-emerald-300/70" /><span className="truncate">{conceptLabel(edge.cy, feature?.concept)}</span></div>
                    <div className="mt-1 ml-5 h-1 overflow-hidden rounded-full bg-edge/50"><div className="h-full rounded-full bg-emerald-400/70" style={{ width: `${Math.max(1, edge.pyx / maxProbability * 100)}%` }} /></div>
                  </div>
                  <span className="text-right font-mono text-xs text-slate-200">{pct(edge.pyx, 1)}</span>
                  <span className="text-right font-mono text-xs text-accent-soft">{edge.lift.toFixed(1)}×</span>
                  {conditional && <span className={`text-right font-mono text-xs ${preference?.sig ? (preference.delta >= 0 ? "text-good" : "text-bad") : "text-slate-600"}`}>
                    {preference ? pp(preference.delta) : "—"}
                  </span>}
                </button>
              ))}
            </div>
          </Card>

          {selected && selectedPrompt != null && (
            <JointEvidence promptFeature={selectedPrompt} responseFeature={selected.edge.cy}
              promptName={promptName} responseName={selected.feature?.concept}
              kind={hasLabels && selected.preference ? "preference" : "elicitation"} />
          )}
        </div>
      </div>
    </div>
  );
}
