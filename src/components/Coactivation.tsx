import { useEffect, useMemo, useState } from "react";
import type { CoactivationPair, ConceptCoactivation, Feature } from "../types";
import { Card, ConceptLabel, Explain, Metric, Segmented, conceptLabel } from "./ui";
import { VirtualList } from "./VirtualList";
import CoactivationPairEvidence from "./CoactivationPairEvidence";
import { answerTypeOf, useAnalysisFilters } from "../analysisFilters";

type Scope = "all" | "selected";

const nameOf = (p: CoactivationPair, side: "a" | "b") =>
  conceptLabel(side === "a" ? p.a : p.b, side === "a" ? p.a_concept : p.b_concept);

export default function Coactivation({
  coact,
  features,
  selected,
  onSelectConcept,
}: {
  coact: ConceptCoactivation;
  features: Feature[];
  /** Optional concept to centre the view on. */
  selected?: number | null;
  onSelectConcept?: (featureId: number) => void;
}) {
  const [scope, setScope] = useState<Scope>(selected == null ? "all" : "selected");
  const [query, setQuery] = useState("");
  const [openPair, setOpenPair] = useState<string | null>(null);
  const { filters } = useAnalysisFilters();
  const featureById = useMemo(() => new Map(features.map((feature) => [feature.feature_id, feature])), [features]);

  useEffect(() => {
    if (selected != null) setScope("selected");
  }, [selected]);

  const pairs = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = coact.pairs;
    if (scope === "selected" && selected != null) {
      rows = rows.filter((p) => p.a === selected || p.b === selected);
    }
    if (filters.answerType !== "all") {
      rows = rows.filter((pair) =>
        answerTypeOf(featureById.get(pair.a)) === filters.answerType
        && answerTypeOf(featureById.get(pair.b)) === filters.answerType);
    }
    if (q) {
      rows = rows.filter(
        (p) =>
          nameOf(p, "a").toLowerCase().includes(q) || nameOf(p, "b").toLowerCase().includes(q),
      );
    }
    return rows;
  }, [coact.pairs, scope, selected, query, filters.answerType, featureById]);

  const maxLift = useMemo(
    () => pairs.reduce((m, p) => (p.lift > m ? p.lift : m), 0) || 1,
    [pairs],
  );
  const selectedName = useMemo(() => {
    if (selected == null) return null;
    for (const pair of coact.pairs) {
      if (pair.a === selected) return nameOf(pair, "a");
      if (pair.b === selected) return nameOf(pair, "b");
    }
    return conceptLabel(selected, null);
  }, [coact.pairs, selected]);

  return (
    <div className="space-y-4">
      <Explain>
        Each row has two feature activations that are positive together more often than expected.
        A value of 2× means this happens twice as often as usual. Open an example to inspect
        the answer. Co-activation is not validated semantic presence and does not show that one caused the other.
      </Explain>

      <Card>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <Metric label="Pairs" value={coact.pairs.length.toLocaleString()} />
          <Metric label="Responses" value={coact.n_rows.toLocaleString()} />
          <Metric
            label="Minimum co-occurrence"
            value={coact.min_pair_count}
            sub={coact.truncated ? "list truncated at the export cap" : undefined}
          />
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <Segmented
            value={scope}
            onChange={setScope}
            options={[
              { value: "all" as Scope, label: "All pairs" },
              ...(selected != null
                ? [{ value: "selected" as Scope, label: `Pairs with #${selected}`, title: selectedName ?? undefined }]
                : []),
            ]}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by concept name…"
            className="flex-1 min-w-[12rem] rounded-lg border border-edge/70 bg-ink/60 px-2.5 py-1.5 text-sm text-slate-200 placeholder:text-slate-600 focus:border-accent/50 focus:outline-none"
            aria-label="Filter co-activation pairs"
          />
          <span className="text-xs text-slate-500">{pairs.length.toLocaleString()} shown</span>
        </div>

        {scope === "selected" && selected != null && (
          <div className="mb-3 rounded-lg border border-accent/20 bg-accent/5 px-3 py-2 text-xs text-slate-400">
            Showing pairs that include <span className="font-medium text-slate-200">{selectedName}</span>{" "}
            <span className="font-mono text-slate-500">#{selected}</span>.
          </div>
        )}

        {openPair && coact.examples && (() => {
          const pair = pairs.find((p) => `${p.a}-${p.b}` === openPair);
          if (!pair) return null;
          return (
            <div className="relative mb-4">
              <button type="button" onClick={() => setOpenPair(null)}
                className="absolute right-3 top-3 z-10 shrink-0 rounded border border-edge/70 bg-ink/80 px-2 py-1 text-xs text-slate-400 hover:bg-edge/60">
                Close
              </button>
              <CoactivationPairEvidence pair={pair} coactivation={coact} limit={6} />
            </div>
          );
        })()}

        <VirtualList
          items={pairs}
          rowHeight={64}
          height={520}
          emptyMessage="No co-activating pair matches that filter."
          renderRow={(p) => {
            const key = `${p.a}-${p.b}`;
            const isOpen = openPair === key;
            return (
              <div className="h-full flex min-w-0 items-center gap-2 px-2 hover:bg-edge/40 rounded sm:gap-3">
                <div className="flex flex-1 min-w-0 flex-col justify-center gap-0.5 text-sm sm:flex-row sm:items-center sm:gap-2">
                  <button
                    type="button"
                    className="min-w-0 truncate text-left hover:underline sm:max-w-[45%]"
                    onClick={() => onSelectConcept?.(p.a)}
                    title={nameOf(p, "a")}
                  >
                    <ConceptLabel id={p.a} name={p.a_concept ?? null} />
                  </button>
                  <div className="flex min-w-0 items-center gap-2 sm:contents">
                    <span className="shrink-0 text-slate-400">+</span>
                    <button
                      type="button"
                      className="min-w-0 truncate text-left hover:underline sm:max-w-[45%]"
                      onClick={() => onSelectConcept?.(p.b)}
                      title={nameOf(p, "b")}
                    >
                      <ConceptLabel id={p.b} name={p.b_concept ?? null} />
                    </button>
                  </div>
                </div>
                <div className="hidden w-28 shrink-0 h-2 bg-edge/40 rounded overflow-hidden lg:block">
                  <div
                    className="h-full bg-good/80"
                    style={{ width: `${Math.max(2, (p.lift / maxLift) * 100)}%` }}
                  />
                </div>
                <div className="w-16 shrink-0 text-right text-sm tabular-nums" title="lift">
                  {p.lift.toFixed(1)}×
                </div>
                <div className="hidden w-20 shrink-0 text-right text-xs text-slate-500 tabular-nums md:block">
                  {p.count.toLocaleString()}
                </div>
                {p.rows.length > 0 && coact.examples && (
                  <button
                    type="button"
                    className="w-8 shrink-0 overflow-hidden whitespace-nowrap rounded border border-edge/70 px-1.5 py-1 text-xs text-slate-300 hover:bg-edge/40 sm:w-auto sm:px-2"
                    onClick={() => setOpenPair(isOpen ? null : key)}
                    aria-expanded={isOpen}
                    aria-label={isOpen ? "Hide examples" : `Show ${p.rows.length} examples`}
                  >
                    <span aria-hidden>{isOpen ? "−" : "+"}</span><span className="hidden sm:inline"> {isOpen ? "Hide" : `${p.rows.length} examples`}</span>
                  </button>
                )}
              </div>
            );
          }}
        />


      </Card>
    </div>
  );
}
