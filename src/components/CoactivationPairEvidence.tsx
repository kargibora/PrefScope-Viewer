import { useEffect, useMemo, useState } from "react";
import type { CoactivationPair, ConceptCoactivation } from "../types";
import { conceptLabel } from "./ui";
import { ActivationMeter, EvidencePager, EvidenceText, ExampleGroupSelect, activationDomain } from "./ActivationEvidence";
import { useAnalysisFilters } from "../analysisFilters";

const activation = (
  example: NonNullable<ConceptCoactivation["examples"]>[string],
  featureId: number,
) => example.activations?.[String(featureId)];

export default function CoactivationPairEvidence({
  pair,
  coactivation,
  kind = "response",
  limit = 3,
}: {
  pair: CoactivationPair;
  coactivation: ConceptCoactivation;
  kind?: "response" | "prompt";
  limit?: number;
}) {
  const { filters, setGroup } = useAnalysisFilters();
  const group = filters.group;
  const allExamples = pair.rows
    .map((row) => ({ row, example: coactivation.examples?.[String(row)] }))
    .filter((item): item is {
      row: number;
      example: NonNullable<ConceptCoactivation["examples"]>[string];
    } => Boolean(item.example));
  const groups = useMemo(() => [...new Set(allExamples.map(({ example }) => example.group).filter((value): value is string => Boolean(value)))].sort(), [allExamples]);
  const examples = allExamples.filter(({ example }) => !group || example.group === group).slice(0, limit);
  const [exampleIndex, setExampleIndex] = useState(0);
  useEffect(() => { setExampleIndex(0); }, [pair.a, pair.b, group]);
  const active = examples[exampleIndex] ?? examples[0];
  const shown = active ? [active] : [];
  const aName = conceptLabel(pair.a, pair.a_concept);
  const bName = conceptLabel(pair.b, pair.b_concept);
  const hasActivationValues = examples.some(({ example }) =>
    activation(example, pair.a) != null && activation(example, pair.b) != null,
  );
  const axisValues = (featureId: number) => Object.values(coactivation.examples ?? {})
    .map((example) => activation(example, featureId))
    .filter((value): value is number => value != null);
  const aDomain = activationDomain(axisValues(pair.a));
  const bDomain = activationDomain(axisValues(pair.b));
  const groupColumn = allExamples.find(({ example }) => example.group_column)?.example.group_column ?? "language";

  return (
    <div className="rounded-xl border border-accent/25 bg-accent/5 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {kind === "prompt" ? "Prompts" : "Answers"} where both feature axes have positive activity
      </div>
      <div className="mt-1 text-sm font-medium text-slate-200">
        {aName} <span className="text-slate-500">+</span> {bName}
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          {pair.lift.toFixed(1)}× more common together · {pair.count.toLocaleString()} matches
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <ExampleGroupSelect groups={groups} value={group} onChange={(value) => setGroup(value, groupColumn)} column={groupColumn} />
          <EvidencePager index={Math.min(exampleIndex, Math.max(0, examples.length - 1))} count={examples.length} onChange={setExampleIndex} />
        </div>
      </div>

      {examples.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">
          No example was saved for this concept pair.
        </p>
      ) : (
        <div className="mt-3">
          {shown.map(({ row, example }) => {
            const aValue = activation(example, pair.a);
            const bValue = activation(example, pair.b);
            return (
              <details key={row} className="group rounded-lg border border-edge/60 bg-ink/45 p-3" open>
                <summary className="cursor-pointer list-none">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {aValue != null && <ActivationMeter value={aValue} min={aDomain.min} max={aDomain.max} label={`Concept #${pair.a}`} compact />}
                    {bValue != null && <ActivationMeter value={bValue} min={bDomain.min} max={bDomain.max} label={`Concept #${pair.b}`} compact />}
                  </div>
                  <div className="mt-3 group-open:hidden"><EvidenceText kind="prompt" preview>{example.prompt}</EvidenceText></div>
                  <span className="mt-1 block text-right text-[9px] text-slate-600">row {row}</span>
                </summary>
                <div className="mt-3 space-y-3 border-t border-edge/60 pt-3">
                  <EvidenceText kind="prompt">{example.prompt}</EvidenceText>
                  {example.response && <EvidenceText kind="response">{example.response}</EvidenceText>}
                </div>
              </details>
            );
          })}
        </div>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
        {hasActivationValues
          ? "Both feature scores are positive. The strongest balanced matches are shown first."
          : "These examples were selected because both concept scores were positive; this older dataset does not include the scores."}
        {" "}Positive activity together does not prove that either concept name is correct or that one causes the other.
      </p>
    </div>
  );
}
