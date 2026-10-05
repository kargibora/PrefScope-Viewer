import { ArrowUpRight, Database, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useDataArtifact } from "../data";
import type { JointExample, JointExampleShard } from "../types";
import { Card, ConceptLabel, SkeletonList } from "./ui";
import { ActivationMeter, EvidencePager, EvidenceText, ExampleGroupSelect, activationDomain } from "./ActivationEvidence";
import { useAnalysisFilters } from "../analysisFilters";

type EvidenceKind = "elicitation" | "preference";

export default function JointEvidence({
  promptFeature,
  responseFeature,
  promptName,
  responseName,
  kind,
  onOpenPrompt,
  onOpenBehavior,
}: {
  promptFeature: number;
  responseFeature: number;
  promptName: string | null | undefined;
  responseName: string | null | undefined;
  kind: EvidenceKind;
  onOpenPrompt?: () => void;
  onOpenBehavior?: () => void;
}) {
  const shard = useDataArtifact<JointExampleShard>(`joint_examples/${promptFeature}.json`);
  const allExamples = shard?.examples[String(responseFeature)] ?? [];
  const { filters, setGroup } = useAnalysisFilters();
  const group = filters.group;
  const groups = useMemo(() => [...new Set(allExamples.map((example) => example.group).filter((value): value is string => Boolean(value)))].sort(), [allExamples]);
  const examples = allExamples.filter((example) => !group || example.group === group);
  const [exampleIndex, setExampleIndex] = useState(0);
  useEffect(() => { setExampleIndex(0); }, [promptFeature, responseFeature, group]);
  const activeExample = examples[exampleIndex] ?? examples[0];
  const promptDomain = activationDomain(allExamples.map((example) => example.prompt_activation));
  const responseDomain = activationDomain(allExamples.map((example) => example.response_activation));
  const groupColumn = allExamples.find((example) => example.group_column)?.group_column ?? "language";

  return (
    <Card className="border-accent/25 bg-accent/[0.035]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Sparkles size={15} className="text-accent" />
            <h4 className="text-sm font-semibold text-slate-100">Matched evidence</h4>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-400">
            A concrete response where both <ConceptLabel id={promptFeature} name={promptName} wrap className="text-slate-200" /> and{" "}
            <ConceptLabel id={responseFeature} name={responseName} wrap className="text-slate-200" /> activate strongly.
          </p>
        </div>
        {(onOpenPrompt || onOpenBehavior) && (
          <div className="flex flex-wrap gap-2">
            {onOpenPrompt && <EvidenceLink onClick={onOpenPrompt}>Open prompt</EvidenceLink>}
            {onOpenBehavior && <EvidenceLink onClick={onOpenBehavior}>Open behavior</EvidenceLink>}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <ExampleGroupSelect groups={groups} value={group} onChange={(value) => setGroup(value, groupColumn)} column={groupColumn} />
          <EvidencePager index={Math.min(exampleIndex, Math.max(0, examples.length - 1))} count={examples.length} onChange={setExampleIndex} />
        </div>
      </div>

      {shard === undefined ? (
        <div className="mt-3"><SkeletonList n={2} itemClass="h-32" /></div>
      ) : shard === null ? (
        <div className="mt-3 flex gap-2 rounded-xl border border-dashed border-edge bg-ink/30 p-3 text-xs leading-relaxed text-slate-500">
          <Database size={15} className="mt-0.5 shrink-0" />
          <span>Matched transcripts were not included in this bundle. Re-export it with <code className="text-slate-300">--joint-examples</code>.</span>
        </div>
      ) : examples.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-edge bg-ink/30 p-3 text-xs text-slate-500">
          No saved answer had a positive score for both selected concepts.
        </p>
      ) : (
        <div className="mt-3">
          <EvidenceCard example={activeExample} promptDomain={promptDomain} responseDomain={responseDomain} />
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        Selected because both concepts have strong positive scores. This lets you inspect the link,
        but {kind === "preference" ? "one example does not explain the full win-rate result" : "appearing together does not show that one caused the other"}.
        Checked label cutoffs were not used for this saved evidence.
      </p>
    </Card>
  );
}

function EvidenceLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="inline-flex items-center gap-1 rounded-lg border border-edge bg-ink/50 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:border-accent/50 hover:text-slate-100">
      {children}<ArrowUpRight size={13} />
    </button>
  );
}

function EvidenceCard({ example, promptDomain, responseDomain }: {
  example: JointExample;
  promptDomain: { min: number; max: number };
  responseDomain: { min: number; max: number };
}) {
  const outcomeTone = example.outcome === "win" ? "bg-good/15 text-good"
    : example.outcome === "loss" ? "bg-bad/15 text-bad" : "bg-slate-600/20 text-slate-400";
  return (
    <article className="min-w-0 rounded-xl border border-edge bg-ink/45 p-3 text-xs">
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="rounded-md bg-slate-600/25 px-1.5 py-0.5 font-medium text-slate-300">{example.model}</span>
        {example.outcome && <span className={`rounded-md px-1.5 py-0.5 font-medium ${outcomeTone}`}>{example.outcome}</span>}
      </div>
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <ActivationMeter value={example.prompt_activation} min={promptDomain.min} max={promptDomain.max} label="Prompt activation" compact />
        <ActivationMeter value={example.response_activation} min={responseDomain.min} max={responseDomain.max} label="Response activation" compact />
      </div>
      <div className="space-y-2">
        <EvidenceText kind="prompt" preview>{example.prompt}</EvidenceText>
        <EvidenceText kind="response" preview>{example.response}</EvidenceText>
      </div>
    </article>
  );
}
