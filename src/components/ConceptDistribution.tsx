import { useMemo, useState } from "react";
import type { ConceptDistribution as Dist, ConceptDistributionFeature, Feature } from "../types";
import { Card, ConceptLabel, Explain, Metric, Segmented, conceptLabel } from "./ui";
import { VirtualList } from "./VirtualList";
import { answerTypeOf, useAnalysisFilters } from "../analysisFilters";

type Sort = "prevalence" | "rarity" | "strength";

const SORTS: { value: Sort; label: string }[] = [
  { value: "prevalence", label: "Most common" },
  { value: "rarity", label: "Rarest" },
  { value: "strength", label: "Strongest" },
];

const pct = (v: number) => `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`;

/** Concepts-per-row histogram, trimmed to the populated range. */
function CountHistogram({
  histogram,
  rowKind,
}: {
  histogram: number[];
  rowKind: "response" | "prompt";
}) {
  const trimmed = useMemo(() => {
    let end = histogram.length;
    while (end > 1 && histogram[end - 1] === 0) end--;
    return histogram.slice(0, end);
  }, [histogram]);
  const max = useMemo(() => trimmed.reduce((m, v) => (v > m ? v : m), 0), [trimmed]);
  if (!max) return null;
  return (
    <div className="flex items-end gap-px h-24" aria-label={`concepts per ${rowKind}`}>
      {trimmed.map((count, i) => (
        <div
          key={i}
          title={`${count.toLocaleString()} ${rowKind}${count === 1 ? "" : "s"} activate ${i} concept${i === 1 ? "" : "s"}`}
          className="flex-1 min-w-[2px] bg-accent/60 hover:bg-accent rounded-t"
          style={{ height: `${Math.max(1, (count / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

/** Per-group fire rates for one concept, as a compact bar row. */
function GroupBars({ rates, groups }: { rates?: Record<string, number>; groups: string[] }) {
  if (!rates) return null;
  const max = groups.reduce((m, g) => Math.max(m, rates[g] ?? 0), 0) || 1;
  return (
    <div className="flex gap-1 items-end h-6" aria-hidden>
      {groups.map((g) => (
        <div key={g} className="flex-1 h-full flex flex-col justify-end" title={`${g}: ${pct(rates[g] ?? 0)}`}>
          <div
            className="bg-accent-soft/70 rounded-sm"
            style={{ height: `${Math.max(2, ((rates[g] ?? 0) / max) * 100)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

export default function ConceptDistribution({
  dist,
  kind = "response",
  group = "",
  onGroupChange,
  onSelectConcept,
  features = [],
}: {
  dist: Dist;
  kind?: "response" | "prompt";
  group?: string;
  onGroupChange?: (group: string) => void;
  onSelectConcept?: (featureId: number) => void;
  features?: Feature[];
}) {
  const [sort, setSort] = useState<Sort>("prevalence");
  const [query, setQuery] = useState("");
  const { filters: globalFilters } = useAnalysisFilters();
  const featureById = useMemo(() => new Map(features.map((feature) => [feature.feature_id, feature])), [features]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let filtered = q
      ? dist.features.filter(
          (f) =>
            (f.concept ?? "").toLowerCase().includes(q) || String(f.feature_id) === q,
        )
      : dist.features;
    if (group) filtered = filtered.filter((feature) => (feature.group_fire_rate?.[group] ?? 0) > 0);
    if (kind === "response" && globalFilters.answerType !== "all")
      filtered = filtered.filter((feature) => answerTypeOf(featureById.get(feature.feature_id)) === globalFilters.answerType);
    const live = filtered.filter((f) => f.n_active > 0);
    const rate = (feature: ConceptDistributionFeature) =>
      group ? feature.group_fire_rate?.[group] ?? 0 : feature.fire_rate;
    const cmp: Record<Sort, (a: ConceptDistributionFeature, b: ConceptDistributionFeature) => number> = {
      prevalence: (a, b) => rate(b) - rate(a),
      rarity: (a, b) => rate(a) - rate(b),
      strength: (a, b) => b.mean_activation - a.mean_activation,
    };
    return [...live].sort(cmp[sort]);
  }, [dist.features, sort, query, group, kind, globalFilters.answerType, featureById]);

  const rateOf = (feature: ConceptDistributionFeature) =>
    group ? feature.group_fire_rate?.[group] ?? 0 : feature.fire_rate;
  const maxRate = rows.length ? rows.reduce((m, f) => Math.max(m, rateOf(f)), 0) : 1;
  const q = dist.concepts_per_row.quantiles;
  const rowKind = kind === "prompt" ? "prompt" : "response";
  const RowKind = kind === "prompt" ? "Prompts" : "Responses";
  const conceptKind = kind === "prompt" ? "prompt concepts" : "response concepts";

  return (
    <div className="space-y-4">
      <Explain>
        See which {conceptKind} are common or rare, how many appear in a typical {rowKind},
        and which concepts never appear. “Appears” here means that the corresponding feature has positive activity; it is not validated semantic presence unless a calibrated threshold is reported. These counts do not use win labels. This view contains{" "}
        {dist.n_features.toLocaleString()} {dist.selection === "verified" ? "verified" : dist.selection === "named" ? "named" : "retained"}{" "}
        concepts{dist.n_total_features != null && dist.n_total_features !== dist.n_features
          ? ` from ${dist.n_total_features.toLocaleString()} learned features`
          : ""}.
        {group && <> The concept table and opened examples use <b>{group}</b>;
          the cards above still summarize the full dataset.</>}
      </Explain>

      <Card>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Metric label={RowKind} value={dist.n_rows.toLocaleString()} />
          <Metric
            label="Coverage"
            value={pct(dist.coverage)}
            sub="activate ≥1 concept"
          />
          <Metric
            label={`Concepts per ${rowKind}`}
            value={dist.concepts_per_row.mean.toFixed(1)}
            sub={q["0.5"] !== undefined ? `median ${q["0.5"]}, p99 ${q["0.99"]}` : undefined}
          />
          <Metric
            label="Never fire"
            value={`${dist.dead_features.length} / ${dist.n_features}`}
            sub="dead features"
          />
        </div>
        <div className="mt-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500 mb-2">
            Concepts activated per {rowKind}
          </div>
          <CountHistogram histogram={dist.concepts_per_row.histogram} rowKind={rowKind} />
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <Segmented value={sort} onChange={setSort} options={SORTS} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Filter ${conceptKind}…`}
            className="flex-1 min-w-[12rem] rounded-lg border border-edge/70 bg-ink/60 px-2.5 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-accent/50 focus:outline-none"
            aria-label={`Filter ${conceptKind}`}
          />
          <span className="text-xs text-slate-500">{rows.length.toLocaleString()} shown</span>
          {dist.groups.length > 1 && onGroupChange && (
            <label className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              {dist.group_column ?? "group"}
              <select value={group} onChange={(event) => onGroupChange(event.target.value)}
                aria-label={dist.group_column ?? "group"}
                className="rounded-lg border border-edge bg-ink px-2 py-1.5 text-xs font-normal normal-case tracking-normal text-slate-300 outline-none focus:border-accent/60">
                <option value="">All</option>
                {dist.groups.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          )}
        </div>

        {dist.groups.length > 1 && (
          <div className="text-[11px] text-slate-500 mb-2">
            Bars on the right compare fire rate across{" "}
            <span className="font-medium">{dist.group_column}</span>:{" "}
            {dist.groups.join(" · ")}
          </div>
        )}

        <VirtualList
          items={rows}
          rowHeight={44}
          height={520}
          emptyMessage="No concept matches that filter."
          renderRow={(f) => (
            <button
              type="button"
              onClick={() => onSelectConcept?.(f.feature_id)}
              className="w-full h-full flex min-w-0 items-center gap-3 px-2 text-left hover:bg-edge/40 rounded"
              title={conceptLabel(f.feature_id, f.concept)}
            >
              <div className="min-w-0 flex-1 truncate text-sm sm:w-64 sm:flex-none">
                <ConceptLabel id={f.feature_id} name={f.concept} />
              </div>
              <div className="hidden min-w-12 flex-1 h-2 bg-edge/40 rounded overflow-hidden sm:block">
                <div
                  className="h-full bg-accent/80"
                  style={{ width: `${Math.max(1, (rateOf(f) / maxRate) * 100)}%` }}
                />
              </div>
              <div className="w-20 shrink-0 text-right text-sm tabular-nums">
                {pct(rateOf(f))}
              </div>
              <div className="hidden w-24 shrink-0 text-right text-xs text-slate-500 tabular-nums md:block">
                {group
                  ? dist.group_totals?.[group] != null
                    ? `${Math.round(rateOf(f) * dist.group_totals[group]).toLocaleString()} ${rowKind}s`
                    : `${rowKind} subset`
                  : `${f.n_active.toLocaleString()} ${rowKind}s`}
              </div>
              {dist.groups.length > 1 && (
                <div className="hidden w-24 shrink-0 xl:block">
                  <GroupBars rates={f.group_fire_rate} groups={dist.groups} />
                </div>
              )}
            </button>
          )}
        />
      </Card>
    </div>
  );
}
