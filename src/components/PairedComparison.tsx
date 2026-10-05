import { useMemo, useState } from "react";
import type {
  PairedComparison as Comparison,
  PairedConceptShift,
  ResponseScope,
} from "../types";
import {
  Card,
  ConceptLabel,
  Explain,
  Segmented,
  clip,
  fireDivergeColor,
} from "./ui";

const pct = (x: number, digits = 0) => `${(100 * x).toFixed(digits)}%`;
const pp = (x: number) => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(1)} pp`;
const qLabel = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? "q unavailable" : `q=${x < 0.001 ? "<.001" : x.toFixed(3)}`;

const scopes: { value: ResponseScope | "all"; label: string }[] = [
  { value: "all", label: "All shifts" },
  { value: "general_tendency", label: "General tendencies" },
  { value: "context_specific_tendency", label: "Prompt-conditioned" },
  { value: "prompt_content", label: "Content / requested tasks" },
  { value: "unclassified", label: "Insufficient evidence" },
];

function ScopeBadge({ scope }: { scope: ResponseScope }) {
  const label = scopes.find((s) => s.value === scope)?.label ?? scope;
  const color = scope === "general_tendency"
    ? "bg-blue-400/10 text-blue-300"
    : scope === "context_specific_tendency"
      ? "bg-violet-400/10 text-violet-300"
      : scope === "prompt_content"
        ? "bg-slate-600/25 text-slate-400"
        : "bg-amber-400/10 text-amber-300";
  return <span className={`rounded-full px-2 py-0.5 text-[10px] ${color}`}>{label}</span>;
}

function ShiftRow({ row, selected, onClick, a, b }: {
  row: PairedConceptShift;
  selected: boolean;
  onClick: () => void;
  a: string;
  b: string;
}) {
  return (
    <button onClick={onClick} aria-pressed={selected}
      className={`grid w-full grid-cols-[minmax(0,1fr)_92px] gap-3 rounded-xl px-3 py-2.5 text-left transition ${
        selected ? "bg-accent/10 ring-1 ring-inset ring-accent/35" : "hover:bg-edge/25"
      }`}>
      <span className="min-w-0">
        <ConceptLabel id={row.feature_id} name={row.concept} wrap className="text-sm text-slate-200" />
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          <ScopeBadge scope={row.response_scope} />
          <span className="text-[10px] text-slate-600">
            {a} {pct(row.prevalence_a)} · {b} {pct(row.prevalence_b)}
          </span>
        </span>
      </span>
      <span className="text-right">
        <span className="block font-mono text-sm font-semibold"
          style={{ color: fireDivergeColor(row.delta_b_minus_a) }}>
          {pp(row.delta_b_minus_a)}
        </span>
        <span className="block text-[10px] text-slate-600">
          {row.n_discordant} discordant · {qLabel(row.q_value)}
        </span>
      </span>
    </button>
  );
}

export default function PairedComparison({ data }: { data: Comparison | null }) {
  const [scope, setScope] = useState<ResponseScope | "all">("all");
  const [direction, setDirection] = useState<"all" | "a" | "b">("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...(data?.concepts ?? [])]
      .filter((row) => scope === "all" || row.response_scope === scope)
      .filter((row) => direction === "all" || (direction === "a" ? row.delta_b_minus_a < 0 : row.delta_b_minus_a > 0))
      .filter((row) => !q || (row.concept ?? `feature ${row.feature_id}`).toLowerCase().includes(q))
      .sort((x, y) => Math.abs(y.delta_b_minus_a) - Math.abs(x.delta_b_minus_a));
  }, [data, scope, direction, query]);
  const selected = rows.find((row) => row.feature_id === selectedId) ?? rows[0] ?? null;
  const contexts = useMemo(() =>
    (data?.contexts ?? []).filter((row) => row.feature_id === selected?.feature_id)
      .sort((x, y) => Math.abs(y.delta_b_minus_a) - Math.abs(x.delta_b_minus_a)),
  [data, selected]);
  const examples = useMemo(() =>
    (data?.examples ?? []).filter((row) => row.feature_id === selected?.feature_id),
  [data, selected]);

  if (!data) return null;
  const { side_a_name: a, side_b_name: b } = data.meta;

  return (
    <div className="space-y-4">
      <Explain>
        A <b>prompt-matched, label-free comparison</b> of {a} and {b}. A shift says one
        response set has positive activity on a verified concept axis more often on the same
        prompts. This bundle has no calibrated semantic thresholds. A shift does not explain
        or cause a judge-preference result.
      </Explain>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card><div className="text-xs uppercase tracking-wider text-slate-500">Shared prompts</div><div className="mt-1 text-2xl font-semibold text-slate-100">{data.meta.n_pairs.toLocaleString()}</div></Card>
        <Card><div className="text-xs uppercase tracking-wider text-slate-500">Response concepts</div><div className="mt-1 text-2xl font-semibold text-slate-100">{data.meta.n_features.toLocaleString()}</div></Card>
        <Card><div className="text-xs uppercase tracking-wider text-slate-500">Activity rule</div><div className="mt-2 text-sm font-medium text-slate-200">{data.meta.presence_policy.replace(/_/g, " ")}</div><div className="mt-1 text-[11px] text-slate-600">{data.meta.activity_interpretation ?? "preference labels not used"}</div></Card>
      </div>

      <Card className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-100">Response tendency shifts</h2>
            <p className="mt-1 text-xs text-slate-500">Positive means {b} has positive axis activity more often; negative means {a} does.</p>
          </div>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search response concepts"
            className="w-full rounded-lg border border-edge bg-ink/60 px-3 py-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-accent/50 sm:w-64" />
        </div>
        <div className="flex flex-wrap gap-2 overflow-x-auto pb-1">
          <Segmented options={scopes} value={scope} onChange={setScope} size="xs" />
          <Segmented options={[
            { value: "all" as const, label: "Both directions" },
            { value: "a" as const, label: `${a} more active` },
            { value: "b" as const, label: `${b} more active` },
          ]} value={direction} onChange={setDirection} size="xs" />
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(300px,0.9fr)_minmax(420px,1.1fr)]">
          <div className="order-2 max-h-[680px] space-y-1 overflow-y-auto pr-1 lg:order-1">
            {rows.length ? rows.map((row) => (
              <ShiftRow key={row.feature_id} row={row} selected={selected?.feature_id === row.feature_id}
                onClick={() => setSelectedId(row.feature_id)} a={a} b={b} />
            )) : <p className="p-4 text-sm text-slate-500">No concepts match this filter.</p>}
          </div>

          {selected && (
            <div className="order-1 space-y-4 rounded-xl border border-edge/70 bg-ink/25 p-4 lg:order-2">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <ConceptLabel id={selected.feature_id} name={selected.concept} wrap className="text-lg font-semibold text-slate-100" />
                  <ScopeBadge scope={selected.response_scope} />
                </div>
                <p className="mt-2 text-sm text-slate-400">
                  Positive activity occurs on {pct(selected.prevalence_b, 1)} of {b} responses versus {pct(selected.prevalence_a, 1)} of {a} responses: <b className="text-slate-200">{pp(selected.delta_b_minus_a)}</b>.
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  {selected.ci_low != null && selected.ci_high != null
                    ? `${(100 * (data.meta.confidence ?? 0.95)).toFixed(0)}% ${selected.ci_method === "hoeffding" ? "Hoeffding " : ""}interval ${pp(selected.ci_low)} to ${pp(selected.ci_high)} · ` : ""}
                  {selected.n_discordant} discordant pairs · {qLabel(selected.q_value)} · {selected.presence_basis.replace(/_/g, " ")}
                </p>
              </div>

              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Where the shift appears</h3>
                {contexts.length ? <div className="mt-2 space-y-1">
                  {contexts.slice(0, 8).map((row) => (
                    <div key={`${row.region_id}-${row.feature_id}`} className="flex items-center justify-between gap-3 rounded-lg bg-panel/45 px-3 py-2 text-xs">
                      <span className="min-w-0 truncate text-slate-300">{row.region_concept || `${row.region_kind ?? "prompt context"} ${row.region_id}`}</span>
                      <span className="shrink-0 text-right tabular-nums text-slate-400">{pp(row.delta_b_minus_a)} · n={row.n_pairs}</span>
                    </div>
                  ))}
                </div> : <p className="mt-2 text-xs text-slate-600">No prompt region clears the configured support floor.</p>}
              </div>

              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Prompt-matched examples</h3>
                {examples.length ? <div className="mt-2 space-y-3">
                  {examples.slice(0, 6).map((example) => (
                    <div key={`${example.direction}-${example.item_id}`} className="rounded-xl border border-edge/60 bg-panel/35 p-3">
                      <div className="text-xs font-medium text-slate-300">{clip(example.prompt, 220)}</div>
                      <div className="mt-2 grid gap-2 md:grid-cols-2">
                        <div className={`rounded-lg p-2 text-xs leading-relaxed ${example.direction === "a_only" ? "bg-blue-400/10 text-slate-200" : "bg-ink/35 text-slate-500"}`}><b className="mb-1 block text-[10px] uppercase tracking-wider">{a} · activity {example.activation_a.toFixed(3)}</b>{clip(example.response_a, 420)}</div>
                        <div className={`rounded-lg p-2 text-xs leading-relaxed ${example.direction === "b_only" ? "bg-blue-400/10 text-slate-200" : "bg-ink/35 text-slate-500"}`}><b className="mb-1 block text-[10px] uppercase tracking-wider">{b} · activity {example.activation_b.toFixed(3)}</b>{clip(example.response_b, 420)}</div>
                      </div>
                    </div>
                  ))}
                </div> : <p className="mt-2 text-xs text-slate-600">No discordant example was exported for this concept.</p>}
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
