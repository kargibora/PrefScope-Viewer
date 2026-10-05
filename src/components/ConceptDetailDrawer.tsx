import { useEffect, useMemo, useState } from "react";
import type { ConceptCoactivation, ConceptDistribution, ElicitationData, Example, Feature } from "../types";
import { pct, useDataArtifact, useFeatureExamples } from "../data";
import { Card, conceptLabel } from "./ui";
import JointEvidence from "./JointEvidence";
import CoactivationPairEvidence from "./CoactivationPairEvidence";
import FeatureDetailDrawerShell from "./FeatureDetailDrawerShell";
import { ActivationEvidenceCard, EvidenceModeSelect, EvidencePager, ExampleGroupSelect, activationDomain, evidenceMode, evidenceModes, type EvidenceMode } from "./ActivationEvidence";
import {
  answerTypeLabel,
  answerTypeOf,
  useAnalysisFilters,
  type AnswerTypeFilter,
} from "../analysisFilters";

export default function ConceptDetailDrawer({
  featureId,
  features,
  onClose,
  onSelectFeature,
}: {
  featureId: number;
  features: Feature[];
  onClose: () => void;
  onSelectFeature: (featureId: number) => void;
}) {
  const feature = features.find((row) => row.feature_id === featureId);
  const examples = useFeatureExamples(featureId);
  const coactivation = useDataArtifact<ConceptCoactivation>("coactivation.json");
  const elicitation = useDataArtifact<ElicitationData>("elicitation.json");
  const distribution = useDataArtifact<ConceptDistribution>("concept_distribution.json");
  const [activePair, setActivePair] = useState<string | null>(null);
  const [activePrompt, setActivePrompt] = useState<number | null>(null);
  const { filters, setGroup } = useAnalysisFilters();
  const group = filters.group;
  const [relatedAnswerType, setRelatedAnswerType] = useState<AnswerTypeFilter>(filters.answerType);
  const [mode, setMode] = useState<EvidenceMode>("strongest");
  const [exampleIndex, setExampleIndex] = useState(0);
  const featureById = useMemo(() => new Map(features.map((row) => [row.feature_id, row])), [features]);

  useEffect(() => { setActivePair(null); setActivePrompt(null); setMode("strongest"); setExampleIndex(0); }, [featureId]);
  useEffect(() => { setExampleIndex(0); }, [group, mode]);
  useEffect(() => { setRelatedAnswerType(filters.answerType); }, [featureId, filters.answerType]);
  const pairs = useMemo(() => (coactivation?.pairs ?? [])
    .filter((pair) => pair.a === featureId || pair.b === featureId)
    .filter((pair) => {
      if (relatedAnswerType === "all") return true;
      const other = pair.a === featureId ? pair.b : pair.a;
      return answerTypeOf(featureById.get(other)) === relatedAnswerType;
    })
    .sort((a, b) => b.lift - a.lift || b.count - a.count)
    .slice(0, 10), [coactivation, featureId, relatedAnswerType, featureById]);
  const promptEdges = useMemo(() => (elicitation?.edges ?? [])
    .filter((edge) => edge.cy === featureId && edge.l2 > 0)
    .sort((a, b) => Number(b.sig) - Number(a.sig) || b.lift - a.lift)
    .slice(0, 10), [elicitation, featureId]);
  const promptNames = useMemo(() => new Map(
    (elicitation?.prompt_concepts ?? []).map((row) => [row.id, row.concept]),
  ), [elicitation]);
  const selectedPair = pairs.find((pair) => `${pair.a}-${pair.b}` === activePair) ?? null;

  const allExamples = useMemo(() => (examples ?? []).map((row: Example) => {
    const paired = Boolean(row.completion_b);
    const sideA = row.z >= 0;
    return {
      z: row.z,
      prompt: row.prompt,
      response: paired ? (sideA ? row.completion_a : row.completion_b) : row.completion_a,
      group: row.group,
      groupColumn: row.group_column,
      activationPercentile: row.activation_percentile,
      activationReference: row.activation_reference,
      selectionKind: row.selection_kind,
    };
  }).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)), [examples]);
  const groups = useMemo(() => [...new Set(allExamples.map((row) => row.group).filter((value): value is string => Boolean(value)))].sort(), [allExamples]);
  const modes = useMemo(() => evidenceModes(allExamples.map((row) => ({ selection_kind: row.selectionKind }))), [allExamples]);
  const effectiveMode = modes.includes(mode) ? mode : modes[0] ?? "strongest";
  const ownExamples = useMemo(() => allExamples.filter((row) =>
    (!group || row.group === group) && evidenceMode(row.selectionKind) === effectiveMode,
  ).slice(0, 5), [allExamples, group, effectiveMode]);
  const distributionFeature = distribution?.features.find((row) => row.feature_id === featureId);
  const maxHint = distributionFeature?.max_activation;
  const answerShare = group
    ? distributionFeature?.group_fire_rate?.[group]
    : feature?.semantic_presence_rate ?? feature?.generality ?? feature?.fire_rate;
  const domain = useMemo(() => activationDomain(allExamples.map((row) => row.z), maxHint), [allExamples, maxHint]);
  const groupColumn = allExamples.find((row) => row.groupColumn)?.groupColumn ?? distribution?.group_column ?? "language";
  const missingGroupMetadata = Boolean(group && examples && groups.length === 0);

  return (
    <FeatureDetailDrawerShell kind="response" featureId={featureId} feature={feature} onClose={onClose}>
      <Card className="overflow-hidden bg-gradient-to-br from-panel/90 to-ink/60">
        <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Interpretation</div>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-slate-300">
          {feature?.feature_summary || "This name was suggested by an LLM. Check the examples before using it."}
        </p>
        <dl className="mt-5 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <div className="rounded-xl border border-edge/70 bg-ink/45 px-3 py-2.5"><dt className="text-slate-500">Answer share{group ? ` · ${group}` : ""}</dt><dd className="mt-1 text-sm font-medium text-slate-100">{pct(answerShare, 2)}</dd></div>
          <div className="rounded-xl border border-edge/70 bg-ink/45 px-3 py-2.5"><dt className="text-slate-500">Answer type</dt><dd className="mt-1 text-sm text-slate-200">{feature?.semantic_family?.replace(/_/g, " ") ?? "not classified"}</dd></div>
          <div className="rounded-xl border border-edge/70 bg-ink/45 px-3 py-2.5"><dt className="text-slate-500">Scope</dt><dd className="mt-1 text-sm text-slate-200">{feature?.behavior_category?.replace(/_/g, " ") ?? "not classified"}</dd></div>
          <div className="rounded-xl border border-edge/70 bg-ink/45 px-3 py-2.5"><dt className="text-slate-500">Label agreement</dt><dd className="mt-1 text-sm font-medium text-slate-100">{pct(feature?.agreement, 0)}</dd></div>
        </dl>
      </Card>

          <Card>
            <div className="mb-3 flex items-center justify-between gap-3">
              <div><div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Examples</div><h3 className="mt-1 text-base font-semibold text-slate-100">Answers with positive feature activity</h3></div>
              <div className="flex flex-wrap items-center gap-3"><EvidenceModeSelect modes={modes} value={effectiveMode} onChange={setMode} /><ExampleGroupSelect groups={groups} value={group} onChange={(value) => setGroup(value, groupColumn ?? "language")} column={groupColumn ?? "language"} /><EvidencePager index={Math.min(exampleIndex, Math.max(0, ownExamples.length - 1))} count={ownExamples.length} onChange={setExampleIndex} /></div>
            </div>
            {examples === undefined ? <p className="text-sm text-slate-500">Loading examples…</p>
              : missingGroupMetadata ? <p className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-sm text-amber-200/80">This older example shard has no {groupColumn} metadata. Re-export the bundle to filter evidence by {groupColumn}.</p>
              : ownExamples.length === 0 ? <p className="text-sm text-slate-500">No example was saved for this concept.</p>
                : (() => {
                  const example = ownExamples[exampleIndex] ?? ownExamples[0];
                  return <ActivationEvidenceCard prompt={example.prompt} response={example.response}
                    value={example.z} min={domain.min} max={domain.max}
                    percentile={example.activationPercentile}
                    threshold={example.activationReference === "positive_activation" ? feature?.semantic_threshold : null}
                    selectionKind={example.selectionKind} />;
                })()}
          </Card>

          <Card>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Response relationships</div>
                <h3 className="mt-1 text-base font-semibold text-slate-100">Often has positive activity with</h3>
              </div>
              <label className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Related answer type
                <select
                  value={relatedAnswerType}
                  onChange={(event) => setRelatedAnswerType(event.target.value as AnswerTypeFilter)}
                  aria-label="Related answer type"
                  className="rounded-lg border border-edge bg-ink px-2 py-1.5 text-xs font-normal normal-case tracking-normal text-slate-300 outline-none focus:border-accent/60"
                >
                  {(["all", "behavioral", "prompt_specific", "mixed_or_unclear", "unclassified"] as AnswerTypeFilter[])
                    .map((value) => <option key={value} value={value}>{answerTypeLabel(value)}</option>)}
                </select>
              </label>
            </div>
            <p className="mb-3 mt-1 text-xs leading-relaxed text-slate-500">
              Concepts found on the same answers more often than expected. The type filter applies to the related concepts; × and n use the full dataset.
            </p>
            {pairs.length === 0 ? <p className="text-sm text-slate-500">No saved relationship matches this answer type.</p>
              : <div className="space-y-1">{pairs.map((pair) => {
                const other = pair.a === featureId ? pair.b : pair.a;
                const otherName = pair.a === featureId ? pair.b_concept : pair.a_concept;
                const key = `${pair.a}-${pair.b}`;
                return <div key={key} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-edge/35">
                  <button type="button" onClick={() => onSelectFeature(other)} className="min-w-0 flex-1 truncate text-left text-sm text-slate-300 hover:underline">{conceptLabel(other, otherName)}</button>
                  <span className="font-mono text-xs text-accent-soft">{pair.lift.toFixed(1)}×</span>
                  <span className="w-20 text-right text-xs text-slate-500">n={pair.count.toLocaleString()}</span>
                  {pair.rows.length > 0 && <button type="button" onClick={() => setActivePair(activePair === key ? null : key)} aria-expanded={activePair === key} className="rounded border border-edge px-2 py-1 text-xs text-slate-400 hover:bg-edge/40">{activePair === key ? "Hide evidence" : "Evidence"}</button>}
                </div>;
              })}</div>}
            {selectedPair && coactivation && <div className="mt-3">
              <CoactivationPairEvidence pair={selectedPair} coactivation={coactivation} />
            </div>}
          </Card>

          <Card>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Prompt relationships</div>
            <h3 className="mt-1 text-base font-semibold text-slate-100">Activated by these prompts</h3>
            <p className="mb-3 mt-1 text-xs text-slate-500">Prompt concepts often found with this answer concept. The clearest links are listed first.</p>
            {promptEdges.length === 0 ? <p className="text-sm text-slate-500">No retained positive prompt linkage for this feature.</p>
              : <div className="space-y-1">{promptEdges.map((edge) => <button key={edge.px} type="button" onClick={() => setActivePrompt(edge.px)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left ${activePrompt === edge.px ? "bg-accent/15" : "hover:bg-edge/35"}`}>
                <span className="min-w-0 flex-1 truncate text-sm text-slate-300">{conceptLabel(edge.px, promptNames.get(edge.px))}</span>
                <span className="font-mono text-xs text-accent-soft">{edge.lift.toFixed(1)}×</span>
                <span className="text-[10px] text-slate-500">{edge.sig ? "significant" : "exploratory"}</span>
              </button>)}</div>}
          </Card>
          {activePrompt != null && <JointEvidence promptFeature={activePrompt} responseFeature={featureId}
            promptName={promptNames.get(activePrompt)} responseName={feature?.concept ?? null} kind="elicitation" />}
    </FeatureDetailDrawerShell>
  );
}
