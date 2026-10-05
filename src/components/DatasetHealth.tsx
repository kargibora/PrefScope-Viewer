import { AlertTriangle, CheckCircle2, CircleDashed } from "lucide-react";
import { useMemo } from "react";

import { useDataArtifact } from "../data";
import type { Bundle, ConceptDistribution } from "../types";
import { Card, Metric, SkeletonList, conceptLabel, isUnnamed } from "./ui";

const ratio = (value: number, total: number) => total ? `${(value / total * 100).toFixed(1)}%` : "—";

export default function DatasetHealth({ bundle }: { bundle: Bundle }) {
  const response = useDataArtifact<ConceptDistribution>("concept_distribution.json");
  const prompt = useDataArtifact<ConceptDistribution>("prompt_concept_distribution.json");
  const files = new Set(bundle.manifest?.files ?? []);
  const legacy = bundle.manifest == null;

  const named = bundle.features.filter((feature) => !isUnnamed(feature.concept));
  const tested = named.filter((feature) => feature.fidelity_pass != null);
  const passed = tested.filter((feature) => feature.fidelity_pass === true);
  const unclassified = named.filter((feature) =>
    !feature.semantic_family || feature.semantic_family === "mixed_or_unclear" || feature.semantic_family === "unclassified",
  );
  const duplicates = useMemo(() => {
    const groups = new Map<string, typeof bundle.features>();
    for (const feature of named) {
      const key = feature.concept!.trim().toLocaleLowerCase();
      groups.set(key, [...(groups.get(key) ?? []), feature]);
    }
    return [...groups.values()].filter((rows) => rows.length > 1)
      .sort((a, b) => b.length - a.length);
  }, [bundle.features, named]);

  if (response === undefined || prompt === undefined)
    return <SkeletonList n={3} itemClass="h-40" />;

  const groupTotals = response?.group_totals ?? prompt?.group_totals ?? {};
  const groupCounts = Object.values(groupTotals);
  const imbalance = groupCounts.length > 1
    ? Math.max(...groupCounts) / Math.max(1, Math.min(...groupCounts))
    : null;
  const warnings = [
    ...(bundle.manifest?.errors ?? []).map((error) => ({
      title: `Partial export: ${error.stage}`,
      detail: error.error,
      tone: "bad" as const,
    })),
    ...(named.length < bundle.features.length ? [{
      title: `${bundle.features.length - named.length} answer concepts have no name`,
      detail: "You can still inspect their examples, but do not describe their meaning yet.",
      tone: "warn" as const,
    }] : []),
    ...(tested.length < named.length ? [{
      title: `${named.length - tested.length} names have not been checked`,
      detail: "Treat these names as suggestions until their examples are checked.",
      tone: "warn" as const,
    }] : []),
    ...(response?.dead_features.length ? [{
      title: `${response.dead_features.length} answer concepts never appear`,
      detail: "They have no examples in this dataset. The lens and dataset may not match well.",
      tone: "warn" as const,
    }] : []),
    ...(duplicates.length ? [{
      title: `${duplicates.length} duplicated concept labels`,
      detail: "The features may capture different cases. Compare their examples before renaming or merging them.",
      tone: "warn" as const,
    }] : []),
    ...(imbalance != null && imbalance > 1.5 ? [{
      title: `Some ${response?.group_column ?? prompt?.group_column ?? "group"} groups have ${imbalance.toFixed(1)}× more rows than others`,
      detail: "Use the filter above when comparing how common concepts are.",
      tone: "warn" as const,
    }] : []),
  ];

  const capabilities = [
    { label: "Prompt concepts", available: legacy || files.has("prompt_features.json"), evidence: "prompt concepts and examples" },
    { label: "Answer concepts", available: bundle.features.length > 0, evidence: "answer concepts and examples" },
    { label: "Prompt → answer", available: legacy || files.has("elicitation.json"), evidence: "links and matched examples" },
    { label: "Compare answer sets", available: files.has("paired_comparison.json") || files.has("model_compare.json"), evidence: "changes on the same prompts" },
    { label: "Preference analysis", available: bundle.meta.has_preference ?? true, evidence: "concepts associated with higher and lower preference scores" },
    { label: "Model reports", available: files.has("diagnosis.json"), evidence: "results for each model" },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card><Metric label="Answer coverage" value={response ? ratio(response.rows_with_any_concept, response.n_rows) : "not available"} sub="answers with at least one concept" /></Card>
        <Card><Metric label="Checked labels" value={`${passed.length} / ${named.length}`} sub={tested.length ? `${ratio(passed.length, tested.length)} of checked names passed` : "no label checks"} /></Card>
        <Card><Metric label="Prompt coverage" value={prompt ? ratio(prompt.rows_with_any_concept, prompt.n_rows) : "not available"} sub="prompts with at least one concept" /></Card>
        <Card><Metric label="Unclassified names" value={unclassified.length.toLocaleString()} sub={`${duplicates.length} duplicated labels`} /></Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <Card>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Available views</div>
          <h3 className="mt-1 text-base font-semibold text-slate-100">What can this dataset show?</h3>
          <div className="mt-4 divide-y divide-edge/60">
            {capabilities.map((capability) => (
              <div key={capability.label} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                {capability.available
                  ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-good" />
                  : <CircleDashed size={16} className="mt-0.5 shrink-0 text-slate-600" />}
                <div className="min-w-0 flex-1">
                  <div className={capability.available ? "text-sm text-slate-200" : "text-sm text-slate-500"}>{capability.label}</div>
                  <div className="mt-0.5 text-xs text-slate-600">{capability.available ? capability.evidence : "not included in this dataset"}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Checks</div>
          <h3 className="mt-1 text-base font-semibold text-slate-100">Things to inspect before reporting</h3>
          {warnings.length === 0 ? (
            <div className="mt-4 flex gap-2 rounded-xl border border-good/20 bg-good/5 p-3 text-sm text-good"><CheckCircle2 size={16} className="mt-0.5" />The exported checks found no obvious data problem.</div>
          ) : (
            <div className="mt-3 space-y-2">
              {warnings.map((warning, index) => (
                <div key={`${warning.title}-${index}`} className={`rounded-xl border p-3 ${warning.tone === "bad" ? "border-bad/25 bg-bad/5" : "border-amber-400/20 bg-amber-400/5"}`}>
                  <div className={`flex items-center gap-2 text-sm font-medium ${warning.tone === "bad" ? "text-bad" : "text-amber-200"}`}><AlertTriangle size={14} />{warning.title}</div>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">{warning.detail}</p>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {duplicates.length > 0 && (
        <Card>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Repeated concept names</div>
          <h3 className="mt-1 text-base font-semibold text-slate-100">The same name can describe different features</h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">A repeated name does not mean the features are identical. Check whether their examples differ by language, format, topic, or prompt before changing them.</p>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {duplicates.slice(0, 12).map((rows) => (
              <div key={rows[0].concept} className="rounded-xl border border-edge/70 bg-ink/35 p-3">
                <div className="text-sm text-slate-300">{rows[0].concept}</div>
                <div className="mt-1 text-[10px] text-slate-600">{rows.map((row) => `#${row.feature_id}`).join(" · ")} · {rows.length} features</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <p className="px-1 text-[11px] leading-relaxed text-slate-600">
        These checks help you find missing or weak evidence. They are not one overall quality score.
        A label such as {conceptLabel(bundle.features[0]?.feature_id ?? 0, bundle.features[0]?.concept)} is still a hypothesis until its examples support it.
      </p>
    </div>
  );
}
