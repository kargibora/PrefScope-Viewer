import { Filter, RotateCcw } from "lucide-react";
import { useEffect, useMemo } from "react";

import { answerTypeLabel, useAnalysisFilters } from "../analysisFilters";
import { useDataArtifact, type DatasetInfo } from "../data";
import type { ConceptDistribution, Feature } from "../types";

export default function AnalysisFilterBar({
  datasets,
  overlay,
  onDatasetChange,
  features,
}: {
  datasets: DatasetInfo[];
  overlay: string;
  onDatasetChange: (overlay: string) => void;
  features: Feature[];
}) {
  const response = useDataArtifact<ConceptDistribution>(overlay ? null : "concept_distribution.json");
  const prompt = useDataArtifact<ConceptDistribution>(overlay ? null : "prompt_concept_distribution.json");
  const { filters, setGroup, setAnswerType, reset } = useAnalysisFilters();
  const distribution = response ?? prompt;
  const groups = distribution?.groups ?? [];
  const column = distribution?.group_column ?? filters.groupColumn ?? "group";

  useEffect(() => {
    if (filters.group && !groups.includes(filters.group)) reset();
  }, [filters.group, groups, reset]);

  const total = distribution?.n_rows;
  const selected = filters.group && distribution?.group_totals?.[filters.group];
  const hasAnswerTypes = features.some((feature) => feature.semantic_family != null);
  const countText = useMemo(() => {
    if (total == null) return null;
    if (selected != null)
      return `${selected.toLocaleString()} / ${total.toLocaleString()} examples`;
    return `${total.toLocaleString()} examples`;
  }, [selected, total]);

  if (datasets.length < 2 && groups.length < 2 && !hasAnswerTypes) return null;

  return (
    <section className="mb-5 rounded-2xl border border-edge/75 bg-panel/55 px-3 py-3 shadow-sm sm:px-4"
      aria-label="Analysis filters">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-1 flex min-w-0 items-center gap-2 self-center">
          <Filter size={15} className="text-accent-soft" />
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">Filters</div>
            {countText && <div className="mt-0.5 text-[10px] tabular-nums text-slate-600">{countText}</div>}
          </div>
        </div>

        {datasets.length > 1 && (
          <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[9px] font-semibold uppercase tracking-wider text-slate-500 sm:max-w-[320px]">
            Dataset
            <select value={overlay} onChange={(event) => onDatasetChange(event.target.value)}
              aria-label="Dataset"
              className="rounded-lg border border-edge bg-ink px-2.5 py-2 text-xs font-normal normal-case tracking-normal text-slate-200 outline-none focus:border-accent/60">
              {datasets.map((dataset) => <option key={dataset.id} value={dataset.overlay}>{dataset.label}</option>)}
            </select>
          </label>
        )}

        {groups.length > 1 && (
          <label className="flex min-w-[130px] flex-col gap-1 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
            {column}
            <select value={filters.group}
              onChange={(event) => setGroup(event.target.value, column)}
              aria-label={column}
              className="rounded-lg border border-edge bg-ink px-2.5 py-2 text-xs font-normal normal-case tracking-normal text-slate-200 outline-none focus:border-accent/60">
              <option value="">All</option>
              {groups.map((group) => <option key={group} value={group}>{group}</option>)}
            </select>
          </label>
        )}

        {hasAnswerTypes && (
          <label className="flex min-w-[150px] flex-col gap-1 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
            Answer type
            <select value={filters.answerType}
              onChange={(event) => setAnswerType(event.target.value as typeof filters.answerType)}
              aria-label="Answer type"
              className="rounded-lg border border-edge bg-ink px-2.5 py-2 text-xs font-normal normal-case tracking-normal text-slate-200 outline-none focus:border-accent/60">
              <option value="all">All</option>
              <option value="behavioral">Behavior or style</option>
              <option value="prompt_specific">Prompt or topic</option>
              <option value="mixed_or_unclear">Mixed or unclear</option>
              <option value="unclassified">Not classified</option>
            </select>
          </label>
        )}

        {(filters.group || filters.answerType !== "all") && (
          <button type="button" onClick={reset}
            className="inline-flex items-center gap-1.5 self-end rounded-lg border border-edge px-2.5 py-2 text-xs text-slate-400 hover:bg-edge/35 hover:text-slate-200">
            <RotateCcw size={12} />Reset
          </button>
        )}
      </div>
      {(filters.group || filters.answerType !== "all") && (
        <p className="mt-2 border-t border-edge/60 pt-2 text-[10px] leading-relaxed text-slate-500">
          {filters.group && <>Showing <span className="font-medium text-slate-300">{column}={filters.group}</span>. </>}
          {filters.answerType !== "all" && <>Showing answer concepts of type <span className="font-medium text-slate-300">{answerTypeLabel(filters.answerType)}</span>. </>}
          If a result cannot be recalculated for this filter, the page says that clearly.
        </p>
      )}
    </section>
  );
}
