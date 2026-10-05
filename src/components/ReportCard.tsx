import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BehaviorCategory, Diagnosis, Example, ExamplesByModel, Feature, HeadToHead, ModelExample, ReportBattle, ReportBattles } from "../types";
import { Card, Explain, Metric, Segmented, SkeletonList, conceptLabel, divergeColor, fireDivergeColor, WINRATE_REF } from "./ui";
import { pct, useDataClient, useFeatureExamples } from "../data";
import { H2HIndex, bhAdjust, poolContrastP, type H2HCell } from "../h2h";
import GapQuadrant, { type QuadrantPoint } from "./GapQuadrant";

type FireMode = "freq" | "paired" | "model";
type CategoryFilter = "all" | BehaviorCategory;

// One consolidated per-model report: positive feature activity, paired response-set
// differences, and continuous judge-preference summaries by overlapping prompt slice.

const FIRE_COLOR = "rgba(96,165,250,0.85)"; // frequency is neutral → blue, not good/bad
const clip = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

type BarRow = { label: string; full: string; v: number; color: string; tip?: string; fid?: number };
type Bound = number | string | ((n: number) => number);

// greedy word-wrap into up to `maxLines` lines that fit `maxChars`; the last line is
// ellipsized only if the text genuinely overflows. So most concept names render fully
// on two lines with NO hover needed (recharts axis labels can't reflow HTML).
function wrapLabel(text: string, maxChars: number, maxLines = 2): string[] {
  const norm = (text || "").trim().replace(/\s+/g, " "); // collapse so spacing can't fake overflow
  const words = norm.split(" ").filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length) {
    const overflow = lines.join(" ").length < norm.length; // unshown words remain
    const last = lines[lines.length - 1];
    if (overflow || last.length > maxChars) {
      lines[lines.length - 1] =
        (last.length > maxChars - 1 ? last.slice(0, maxChars - 1) : last).replace(/\s+$/, "") + "…";
    }
  }
  return lines.slice(0, maxLines);
}

// y-axis tick: render the FULL label word-wrapped to two lines (most names fit), with
// the complete text in an SVG <title> as a fallback for the rare 3-line name.
const YTick = (props: any) => {
  const { x, y, payload, fulls, width = 250 } = props;
  const full = String(fulls?.[payload?.index] ?? payload?.value ?? "");
  const maxChars = Math.max(8, Math.floor((width - 10) / 6));
  const lines = wrapLabel(full, maxChars, 2);
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={-4} y={0} textAnchor="end" fill="#94a3b8" fontSize={11}>
        <title>{full}</title>
        {lines.map((ln, i) => (
          <tspan key={i} x={-4} dy={i === 0 ? (lines.length === 2 ? -1 : 4) : 12}>
            {ln}
          </tspan>
        ))}
      </text>
    </g>
  );
};

function BarPanel({
  data,
  domain,
  fmtVal,
  zero = false,
  yWidth = 180,
  labels = true,
  axis = false,
  onBarClick,
}: {
  data: BarRow[];
  domain: [Bound, Bound];
  fmtVal: (v: number) => string;
  zero?: boolean;
  yWidth?: number;
  labels?: boolean;
  axis?: boolean;
  onBarClick?: (row: BarRow) => void;
}) {
  if (data.length === 0)
    return <p className="px-1 py-6 text-center text-sm text-slate-500">(nothing to show)</p>;
  return (
    <ResponsiveContainer width="100%" height={Math.max(140, data.length * 40 + (axis ? 32 : 16))}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 52, top: 4, bottom: 4 }}>
        <XAxis type="number" domain={domain} hide={!axis} stroke="#64748b" fontSize={11}
          tickFormatter={fmtVal} />
        <YAxis
          type="category"
          dataKey="label"
          width={yWidth}
          tickLine={false}
          axisLine={false}
          tick={<YTick fulls={data.map((d) => d.full)} width={yWidth} />}
        />
        <Tooltip
          cursor={{ fill: "rgba(148,163,184,0.08)" }}
          contentStyle={{ background: "#0b0f17", border: "1px solid #1f2937", borderRadius: 8 }}
          labelFormatter={(_l: any, p: any) => p?.[0]?.payload?.full ?? ""}
          formatter={(v: any, _n: any, p: any) => [fmtVal(Number(v)), p?.payload?.tip ?? ""]}
        />
        {zero && <ReferenceLine x={0} stroke="#475569" />}
        <Bar
          dataKey="v"
          radius={[0, 4, 4, 0]}
          isAnimationActive={false}
          cursor={onBarClick ? "pointer" : undefined}
          onClick={(entry: any) => {
            if (!onBarClick) return;
            const row = (entry?.payload ?? entry) as BarRow;
            if (row?.fid != null) onBarClick(row);
          }}
          label={labels ? { position: "right", formatter: fmtVal, fill: "#94a3b8", fontSize: 11 } : undefined}
        >
          {data.map((d, i) => (
            <Cell key={i} fill={d.color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function Section({
  title,
  hint,
  empty,
  children,
}: {
  title: string;
  hint?: string;
  empty?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
      {hint && <p className="mb-1 mt-0.5 text-[11px] text-slate-500">{hint}</p>}
      {empty ? (
        <p className="px-1 py-4 text-sm text-slate-500">
          Not available for this dataset.
        </p>
      ) : (
        <div className="mt-2">{children}</div>
      )}
    </Card>
  );
}

type PT = { concept: string; win_rate: number; n: number; feature_id?: number };

// clickable prompt-type row: full name (wraps), inline win bar vs the model's own
// average, win%, and battle count n. Clicking opens the drill-in below.
function PromptTypeRow({
  p,
  modelWin,
  open,
  onClick,
  drillable,
}: {
  p: PT;
  modelWin: number;
  open: boolean;
  onClick: () => void;
  drillable: boolean;
}) {
  const color = divergeColor(p.win_rate - 0.5, WINRATE_REF);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <button
      onClick={onClick}
      disabled={!drillable}
      className={`flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition ${
        drillable ? "hover:bg-edge/40" : "cursor-default"
      } ${open ? "bg-edge/60" : ""}`}
    >
      {drillable ? (
        <Chevron size={14} className="shrink-0 text-slate-500" />
      ) : (
        <span className="w-[14px] shrink-0" />
      )}
      <span className="flex-1 text-sm text-slate-300">{p.concept}</span>
      <span className="relative hidden h-2 w-24 shrink-0 overflow-hidden rounded-full bg-edge/50 sm:block" title={`run mean ${pct(modelWin, 1)} · neutral reference 50%`}>
        <span className="block h-full rounded-full" style={{ width: `${Math.round(p.win_rate * 100)}%`, background: color }} />
        <span className="absolute inset-y-0 left-1/2 w-px bg-slate-100/80" />
      </span>
      <span className="w-10 shrink-0 text-right text-sm tabular-nums text-slate-200">{pct(p.win_rate, 0)}</span>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-slate-500">n={p.n.toLocaleString()}</span>
    </button>
  );
}

export default function ReportCard({
  diagnosis,
  features,
  reportBattles,
  canLoadBattles = false,
  onLoadBattles,
  headToHead,
  allowExamples = true,
  hasCorpusAssociations = true,
  hasLabels = true,
  onJumpFeature,
}: {
  diagnosis: Diagnosis | null;
  features: Feature[];
  reportBattles: ReportBattles | null | undefined;
  canLoadBattles?: boolean;
  onLoadBattles?: () => void;
  headToHead: HeadToHead | null;
  allowExamples?: boolean;
  hasCorpusAssociations?: boolean;
  hasLabels?: boolean;
  onJumpFeature?: (cf: number) => void;
}) {
  const [model, setModel] = useState(diagnosis?.models?.[0] ?? "");
  const dataClient = useDataClient();
  const [openPrompt, setOpenPrompt] = useState<string | null>(null);
  const [fireMode, setFireMode] = useState<FireMode>(headToHead?.pairs?.length ? "model" : "freq");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [compareModel, setCompareModel] = useState<string>("");
  // Show the full prompt-matched ranking by default; q-values remain visible so the
  // exploratory rows are not confused with multiplicity-controlled evidence.
  const [h2hShowAll, setH2hShowAll] = useState(true);
  const [query, setQuery] = useState("");
  const [showQuadrant, setShowQuadrant] = useState(false);
  // a clicked feature bar opens example answers for that feature; `src` keeps the drill-in
  // next to where it was clicked (fire panel vs gap panel).
  const [openFeat, setOpenFeat] = useState<{ fid: number; src: "fire" | "gap" } | null>(null);
  // lazy per-feature examples shard for whichever feature bar is drilled open (cross-model
  // fallback when this model has none of its own answers firing the feature).
  const drillExamples = useFeatureExamples(allowExamples ? openFeat?.fid ?? null : null);
  const [promptQuery, setPromptQuery] = useState("");
  const [showAllPrompts, setShowAllPrompts] = useState(false);
  // per-model example answers — large (tens of MB), fetched lazily when the report tab
  // first mounts. Track loading so the drill-in doesn't silently show OTHER models' answers
  // (the global fallback) while this model's own answers are still streaming in.
  const [exByModel, setExByModel] = useState<ExamplesByModel | null>(null);
  const [exLoading, setExLoading] = useState(false);
  const [exRequested, setExRequested] = useState(false);
  useEffect(() => {
    if (!allowExamples || !openFeat || exRequested) return;
    setExRequested(true);
    setExLoading(true);
    dataClient.fetchOptional<ExamplesByModel>("examples_by_model.json")
      .then(setExByModel).catch(() => {}).finally(() => setExLoading(false));
  }, [allowExamples, dataClient, openFeat, exRequested]);

  // Dataset overlays can replace the diagnosis without remounting this route. Never
  // leave the selector pointing at a model from the previous dataset.
  useEffect(() => {
    const models = diagnosis?.models ?? [];
    if (!models.includes(model)) {
      setModel(models[0] ?? "");
      setOpenPrompt(null);
      setOpenFeat(null);
    }
  }, [diagnosis, model]);

  // model picker options: search filter + weakest-first (gaps are the point), folded in
  // from the old Model-diagnosis tab
  const filteredModels = useMemo(
    () =>
      (diagnosis?.models ?? [])
        .filter((m) => m.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => (hasLabels
          ? (diagnosis?.rows[a]?.win_rate ?? 0) - (diagnosis?.rows[b]?.win_rate ?? 0)
          : a.localeCompare(b))),
    [diagnosis, query, hasLabels]
  );

  const featureById = useMemo(() => {
    const m: Record<number, Feature> = {};
    for (const f of features) m[f.feature_id] = f;
    return m;
  }, [features]);
  // response-concept NAME -> feature id (relations rows carry names, not ids)
  const fidByConcept = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of features) if (f.concept && !m.has(f.concept)) m.set(f.concept, f.feature_id);
    return m;
  }, [features]);

  const row = diagnosis?.rows[model];

  const view = useMemo(() => {
    if (!row || !diagnosis) return [];
    return diagnosis.features.map((fid, i) => {
      const f = featureById[fid];
      return {
        fid,
        idx: i, // position in diagnosis.features (for pool/compare lookups)
        concept: diagnosis.concepts[i] ?? "",
        fire: row.fire_rate?.[i],
        under: row.delta_vs_pool?.[i] ?? row.net_direction?.[i],
        reward: f?.delta_win_rate ?? f?.win_assoc,
        category: row.behavior_category?.[i] ?? f?.behavior_category ?? "unclassified",
      };
    });
  }, [diagnosis, row, featureById]);

  // head-to-head index (paired, prompt-matched contrast between model pairs). Absent in
  // pre-refresh bundles — the "vs model" mode then falls back to a pooled fire-rate diff.
  const h2hIndex = useMemo(() => (headToHead ? new H2HIndex(headToHead) : null), [headToHead]);

  // resolve the 2nd model synchronously (never self-vs-self): the user's pick if valid,
  // else — when head-to-head data exists — the first opponent that shares a stored pair,
  // else the first other model. Avoids a one-frame "More than —" flash / empty pair.
  const cmpModel =
    fireMode === "model"
      ? compareModel && compareModel !== model
        ? compareModel
        : h2hIndex?.opponentsFor(model)[0] ??
          diagnosis?.models.find((m) => m !== model) ??
          null
      : null;
  const compareFire = cmpModel ? diagnosis?.rows[cmpModel]?.fire_rate : undefined;

  // paired head-to-head cells for (model vs cmpModel), oriented so positive = model does
  // it more, with McNemar p + BH q. null when no stored pair (too few shared battles or
  // no head_to_head.json) → the render falls back to the pooled frequency diff.
  const h2hCells = useMemo(() => {
    if (fireMode !== "model" || !h2hIndex || !cmpModel) return null;
    if (!h2hIndex.hasModel(model) || !h2hIndex.hasModel(cmpModel)) return null;
    const cells = h2hIndex.cellsForPair(model, cmpModel);
    return cells.length ? cells : null;
  }, [fireMode, h2hIndex, model, cmpModel]);

  const named = useMemo(() => view.filter((v) => v.concept && v.concept.trim() !== ""), [view]);
  const hasFire = !!row?.fire_rate;

  // Significance for the DEFAULT pool-contrast view: model-vs-pool z-test per feature from
  // the raw counts + BH across features — the same footing the h2h view already has.
  // null when the bundle predates fire_pos/fire_neg (then effects render un-gated, as before).
  const poolQ = useMemo(() => {
    if (!row?.fire_pos || !row?.fire_neg || !diagnosis?.tot_pos || !diagnosis?.tot_neg || !diagnosis?.n_total)
      return null;
    const ps = diagnosis.features.map((_, i) =>
      poolContrastP(row.fire_pos![i], row.fire_neg![i], row.n_battles,
                    diagnosis.tot_pos![i], diagnosis.tot_neg![i], diagnosis.n_total!));
    return bhAdjust(ps);
  }, [row, diagnosis]);
  const poolSigAt = (idx: number): boolean | null => (poolQ ? poolQ[idx] < 0.05 : null);
  // washed-out variant of an rgba() bar color for non-significant effects
  const dimColor = (c: string) => c.replace(/,\s*([0-9.]+)\)$/, ", 0.22)");

  // points for the folded-in Gap quadrant scatter (delta_vs_pool × reward); all features
  const quadrantPoints: QuadrantPoint[] = useMemo(() => {
    const behaviorOf = (i: number) =>
      diagnosis?.clusters && diagnosis?.behaviors
        ? diagnosis.behaviors[String(diagnosis.clusters[i])] ?? ""
        : "";
    return view.map((v) => {
      const f = featureById[v.fid];
      return {
        fid: v.fid,
        concept: conceptLabel(v.fid, v.concept),
        behavior: behaviorOf(v.idx),
        delta: v.under ?? 0,
        win: v.reward ?? 0,
        gap: (v.under ?? 0) < 0 && (v.reward ?? 0) > 0,
        sig: f?.delta_win_significant ?? f?.win_significant ?? false,
      };
    });
  }, [view, diagnosis, featureById]);

  const firedAll = useMemo(() => named.filter((v) => v.fire != null), [named]);
  const hasContextClassification = !!row?.behavior_category ||
    features.some((f) => f.behavior_category != null);
  useEffect(() => {
    if (!hasContextClassification && categoryFilter !== "all" &&
        categoryFilter !== "unclassified") setCategoryFilter("all");
  }, [hasContextClassification, categoryFilter]);
  const categoryOptions: { value: CategoryFilter; label: string; title: string }[] =
    hasContextClassification
      ? [
          { value: "all", label: "All", title: "all named response features" },
          { value: "general", label: "General tendencies", title: "model-specific effects stable across several prompt contexts" },
          { value: "context_specific", label: "Context-specific", title: "model choices that depend on prompt context" },
          { value: "prompt_content", label: "Prompt/content", title: "task or content properties largely determined by what was requested" },
          { value: "unclassified", label: "Unclassified", title: "insufficient calibration or stability evidence" },
        ]
      : [
          { value: "all", label: "All", title: "all named response features" },
          { value: "unclassified", label: "Unclassified", title: "no semantic calibration/context profile is available" },
        ];
  const fired = useMemo(
    () => categoryFilter === "all"
      ? firedAll
      : firedAll.filter((v) => v.category === categoryFilter),
    [firedAll, categoryFilter]);
  // per-feature display value for the current fire mode:
  //  freq   = absolute fire rate (frequency; NOT prompt-controlled)
  //  paired = delta_vs_pool — expresses more/less than other models comparing answers
  //           to the SAME prompt (prompt-controlled; shared behaviours cancel to ~0)
  //  model  = fire-rate difference vs a chosen model (frequency; not prompt-controlled)
  const fireRows = useMemo(
    () =>
      fired.map((v) => {
        const base = fireMode === "model" ? compareFire?.[v.idx] ?? 0 : 0;
        const val =
          fireMode === "freq" ? v.fire ?? 0
          : fireMode === "paired" ? v.under ?? 0
          : (v.fire ?? 0) - base;
        return { ...v, base, val };
      }),
    [fired, fireMode, compareFire]
  );
  // intensity reference for the paired (delta_vs_pool) palette — scaled to the data,
  // since delta_vs_pool is in oriented-code units, not percentage points
  const pairedRef = useMemo(
    () => Math.max(0.01, ...fireRows.map((v) => Math.abs(v.under ?? 0))),
    [fireRows]
  );
  const moreFire = useMemo(
    () => (fireMode === "freq" ? [...fireRows] : fireRows.filter((v) => v.val > 0))
      .sort((a, b) => b.val - a.val).slice(0, 12),
    [fireRows, fireMode]
  );
  const lessFire = useMemo(() => {
    if (fireMode === "freq") return [...fireRows].sort((a, b) => a.val - b.val).slice(0, 12);
    return fireRows.filter((v) => v.val < 0).sort((a, b) => a.val - b.val).slice(0, 12);
  }, [fireRows, fireMode]);
  const rewardedGaps = useMemo(
    () =>
      named
        .filter((v) => {
          const f = featureById[v.fid];
          const significant = f?.delta_win_significant ?? f?.win_significant ?? false;
          return v.under != null && v.under < 0 && v.reward != null && v.reward > 0
            && !!f?.fidelity_pass && significant;
        })
        .sort((a, b) => (b.reward ?? 0) - (a.reward ?? 0))
        .slice(0, 12),
    [named, featureById]
  );

  // named head-to-head rows (X vs cmpModel), reward sign folded in for the outcome overlay
  const h2hNamed = useMemo(() => {
    if (!h2hCells) return [];
    return h2hCells
      .map((c) => {
        const f = featureById[c.fid];
        const i = diagnosis?.features.indexOf(c.fid) ?? -1;
        const category = i >= 0
          ? row?.behavior_category?.[i] ?? f?.behavior_category ?? "unclassified"
          : f?.behavior_category ?? "unclassified";
        return { ...c, concept: f?.concept ?? "", reward: f?.delta_win_rate ?? f?.win_assoc,
                 category };
      })
      .filter((r) => r.concept && r.concept.trim() !== "")
      .filter((r) => categoryFilter === "all" || r.category === categoryFilter);
  }, [h2hCells, featureById, diagnosis, row, categoryFilter]);
  const usingH2H = fireMode === "model" && h2hNamed.length > 0;
  const h2hN = h2hNamed[0]?.n ?? 0;
  const h2hVisible = useMemo(
    () => (h2hShowAll ? h2hNamed : h2hNamed.filter((r) => (r.q ?? 1) < 0.05)),
    [h2hNamed, h2hShowAll]
  );
  const h2hHidden = h2hNamed.length - h2hVisible.length;
  const h2hRef = useMemo(
    () => Math.max(0.02, ...h2hVisible.map((r) => Math.abs(r.diff))),
    [h2hVisible]
  );
  const h2hMore = useMemo(
    () => h2hVisible.filter((r) => r.diff > 0).sort((a, b) => b.diff - a.diff).slice(0, 12),
    [h2hVisible]
  );
  const h2hLess = useMemo(() => {
    return h2hVisible.filter((r) => r.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, 12);
  }, [h2hVisible]);
  // h2h-in-use but the selected pair isn't stored (below the shared-battle floor)
  const h2hPairMissing = fireMode === "model" && !!h2hIndex && !!cmpModel && !h2hCells;

  // "absolute" = fire_rate is P(z_self>0) prevalence (honest "does a lot"); "contrast" =
  // bank disagreement rate (difference lens). Missing field → treat as contrast, since
  // pre-fix bundles stored the disagreement rate under a "does a lot" label (#1).
  const fireAbsolute = diagnosis?.fire_rate_kind === "absolute";

  const wr = row?.win_rate ?? 0.5;
  const promptTypes = row?.prompt_types ?? [];
  // search filter over prompt types
  const promptMatches = useMemo(() => {
    const q = promptQuery.trim().toLowerCase();
    return q ? promptTypes.filter((p) => p.concept.toLowerCase().includes(q)) : promptTypes;
  }, [promptTypes, promptQuery]);
  // Lead with the lowest observed continuous judge-preference slices.
  const expandedPrompts = showAllPrompts || promptQuery.trim() !== "";
  const allPromptsSorted = useMemo(
    () => [...promptMatches].sort((a, b) => a.win_rate - b.win_rate),
    [promptMatches]
  );
  const weakPrompts = useMemo(() => allPromptsSorted.slice(0, 10), [allPromptsSorted]);
  const strongPrompts = useMemo(() => {
    const weak = new Set(weakPrompts.map((p) => String(p.feature_id ?? p.concept)));
    return [...promptMatches]
      .sort((a, b) => b.win_rate - a.win_rate)
      .filter((p) => !weak.has(String(p.feature_id ?? p.concept)))
      .slice(0, 10);
  }, [promptMatches, weakPrompts]);
  const relations = useMemo(
    () =>
      [...(row?.relations ?? [])]
        .sort((a, b) => Math.abs(b.delta_win) - Math.abs(a.delta_win))
        .slice(0, 14),
    [row]
  );

  const comparisonGroup = diagnosis?.models.length === 2 ? "the other model" : "the comparison pool";
  const relMode = fireMode !== "freq";
  const fireBars = (rows: typeof fireRows): BarRow[] =>
    rows.map((v) => {
      if (fireMode === "freq")
        return { label: clip(v.concept), full: v.concept, v: v.fire ?? 0, color: FIRE_COLOR,
                 tip: fireAbsolute ? "positive activity in" : "differs from opponent on", fid: v.fid };
      if (fireMode === "paired") {
        const sig = poolSigAt(v.idx);
        const base = fireDivergeColor(v.val, pairedRef);
        return {
          label: clip(v.concept),
          full: v.concept,
          v: v.val,
          color: sig === false ? dimColor(base) : base,
          tip: `Δ vs ${comparisonGroup}, same prompt (relative activation, not pp) · fires ${pct(v.fire, 0)}` +
            (sig === false ? " · not significant (q≥0.05)" : sig === true ? " · significant (BH q<0.05)" : ""),
          fid: v.fid,
        };
      }
      return {
        label: clip(v.concept),
        full: v.concept,
        v: v.val,
        color: fireDivergeColor(v.val),
        tip: `fires ${pct(v.fire, 0)} · ${cmpModel} ${pct(v.base, 0)}`,
        fid: v.fid,
      };
    });
  const ppFmt = (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v * 100)}pp`;
  const fireFmt =
    fireMode === "freq" ? (v: number) => pct(v, 0)
    : fireMode === "model" ? ppFmt
    : (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`; // paired: delta_vs_pool units
  const fireDomain: [number | string | ((n: number) => number), number | string | ((n: number) => number)] =
    relMode ? [(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)] : [0, 1];
  // freq-mode headings depend on what fire_rate actually is: absolute prevalence vs a
  // contrast disagreement rate. Only "absolute" earns the "Does a lot" prevalence framing.
  const freqMore = fireAbsolute ? "Does a lot" : "Frequently distinguishes from opponents";
  const freqLess = fireAbsolute ? "Does rarely" : "Rarely distinguishes from opponents";
  const freqMoreHint = fireAbsolute
    ? "share of this model's own answers with positive activity on the feature axis"
    : "how often this model differs from its opponent on the behaviour (contrast rate — NOT absolute prevalence; difference lens)";
  const freqLessHint = fireAbsolute
    ? "feature axes with positive activity in the smallest share of this model's answers"
    : "behaviours this model rarely differs from its opponent on (contrast rate, not prevalence)";
  const moreTitle =
    fireMode === "freq" ? freqMore
    : fireMode === "paired" ? `More positive activity (vs ${comparisonGroup})`
    : usingH2H ? `More positive activity than ${cmpModel} · same ${h2hN} prompts`
    : `More positive activity than ${cmpModel ?? "—"} — pooled, NOT prompt-matched`;
  const lessTitle =
    fireMode === "freq" ? freqLess
    : fireMode === "paired" ? `Less positive activity (vs ${comparisonGroup})`
    : usingH2H ? `Less positive activity than ${cmpModel} · same ${h2hN} prompts`
    : `Less positive activity than ${cmpModel ?? "—"} — pooled, NOT prompt-matched`;
  const moreHint =
    fireMode === "freq" ? freqMoreHint
    : fireMode === "paired" ? `has positive activity more often than ${comparisonGroup}, comparing answers to the same prompt`
    : usingH2H ? "prompt-matched positive-activity difference; each row reports its discordant support and multiplicity-adjusted q-value"
    : "fires more often across each model's own battles (pooled — different prompt mixes, not shared-battle)";
  const lessHint =
    fireMode === "freq" ? freqLessHint
    : fireMode === "paired" ? `has positive activity less often than ${comparisonGroup}, on the same prompt`
    : usingH2H ? "prompt-matched positive-activity difference; exploratory rows remain visible with their q-values"
    : "fires less often across each model's own battles (pooled — not shared-battle)";
  const gapBars: BarRow[] = rewardedGaps.map((v) => {
    const f = featureById[v.fid];
    const rsig = f?.delta_win_significant ?? f?.win_significant ?? false;
    const base = divergeColor(v.reward ?? 0, WINRATE_REF);
    const rewardKind = f?.delta_win_rate != null
      ? "length-controlled Δ preference score"
      : "raw mean preference-probability gap";
    return {
      label: clip(v.concept),
      full: v.concept,
      v: v.reward ?? 0,
      color: rsig ? base : dimColor(base),
      tip: `${rewardKind}${rsig ? "" : " — not significant"} · ${(v.under ?? 0).toFixed(2)} vs ${comparisonGroup}`,
      fid: v.fid,
    };
  });
  const relationBars: BarRow[] = relations.map((r) => {
    const full = `${r.prompt_concept} ⇒ ${r.response_concept}`;
    return { label: clip(full, 56), full, v: r.delta_win, color: divergeColor(r.delta_win, WINRATE_REF), tip: `raw preference-probability gap · n=${r.n}` };
  });
  // paired head-to-head bars: v = (X fires − Y fires) rate on the shared battles; the tip
  // reports the discordant split + effective sample + BH q, plus a win-relevance arrow so
  // behaviour and outcome stay visually separate (more ≠ better).
  const h2hBars = (rows: typeof h2hVisible): BarRow[] =>
    rows.map((r) => ({
      label: clip(r.concept),
      full: r.concept,
      v: r.diff,
      color: fireDivergeColor(r.diff, h2hRef),
      tip:
        `${model} ${r.bx} vs ${cmpModel} ${r.cx} discordant of ${r.n} · n_disc=${r.nDisc} · q=${(r.q ?? 1).toFixed(3)}` +
        ((r.reward ?? 0) > 0 ? " · positive preference association" : (r.reward ?? 0) < 0 ? " · negative preference association" : ""),
      fid: r.fid,
    }));

  const promptKey = (prompt: PT) => String(prompt.feature_id ?? prompt.concept);
  const battlesFor = (prompt: PT) => reportBattles?.[model]?.[promptKey(prompt)] ?? [];

  if (!diagnosis || diagnosis.error === "no_bank")
    return (
      <Card>
        <h2 className="text-lg font-semibold text-amber-400">No model report for this dataset</h2>
        <p className="mt-1 text-sm text-slate-300">
          Per-model diagnoses aren't available for this bundle.
        </p>
      </Card>
    );

  const togglePrompt = (c: string) => {
    setOpenPrompt((cur) => (cur === c ? null : c));
    if (reportBattles === undefined && canLoadBattles) onLoadBattles?.();
  };
  const promptList = (rows: PT[]) =>
    rows.map((p) => (
      <div key={promptKey(p)}>
        <PromptTypeRow
          p={p}
          modelWin={wr}
          open={openPrompt === promptKey(p)}
          onClick={() => togglePrompt(promptKey(p))}
          drillable={(reportBattles === undefined && canLoadBattles) || battlesFor(p).length > 0}
        />
        {openPrompt === promptKey(p) && (
          <>
            <PromptTypeWhy
              relations={row?.relations ?? []}
              concept={p.concept}
              fidByConcept={fidByConcept}
              onJumpFeature={onJumpFeature}
            />
            {reportBattles === undefined
              ? <div className="ml-6 py-3 text-xs text-slate-500">Loading lowest-preference prompts…</div>
              : <BattleDrill battles={battlesFor(p)} model={model} />}
          </>
        )}
      </div>
    ));

  return (
    <div className="flex flex-col gap-4">
      <Explain>
        A per-model <b>response profile</b>: which verified feature axes have positive activity
        in its answers, how that differs on matched prompts, and concrete model-owned examples.
        {hasLabels && <> Prompt slices and prompt→answer rows report continuous judge-preference
        associations, not causal effects.</>}{!allowExamples && <> Raw examples are unavailable for
        this dataset overlay.</>}
      </Explain>

      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wider text-slate-400">search</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter models…"
            className="w-56 rounded-lg border border-edge bg-ink px-3 py-2 text-sm placeholder:text-slate-600"
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wider text-slate-400">
            model ({filteredModels.length}{hasLabels ? ", lowest preference first" : ""})
          </span>
          <select
            value={model}
            onChange={(e) => { setModel(e.target.value); setOpenPrompt(null); setOpenFeat(null); }}
            className="w-96 max-w-full rounded-lg border border-edge bg-ink px-3 py-2 text-sm"
          >
            {filteredModels.map((m) => (
              <option key={m} value={m}>
                {m}{hasLabels ? ` · ${pct(diagnosis.rows[m]?.win_rate, 0)}` : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      {!row ? (
        <Card>No diagnosis row for this model.</Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Metric label="model" value={<span className="text-base">{model}</span>} />
            {hasLabels && <Metric label="preference score" value={pct(row.win_rate, 0)} />}
            <Metric label="battles" value={row.n_battles.toLocaleString()} />
          </div>

          <Section
            title={`Lowest judge-preference prompts — ${model} vs ${cmpModel ?? comparisonGroup}`}
            hint={`mean continuous judge-preference probability per overlapping prompt concept · center mark = 50% · this model's run mean = ${pct(row.win_rate, 1)}. Click a row to inspect its lowest-preference prompts and both answers.`}
            empty={!row.prompt_types}
          >
            {promptTypes.length === 0 ? (
              <p className="px-1 py-4 text-sm text-slate-500">
                No prompt concept cleared the support floor for this model.
              </p>
            ) : (
              <>
                <div className="mb-2 flex flex-wrap items-center gap-3">
                  <input
                    value={promptQuery}
                    onChange={(e) => setPromptQuery(e.target.value)}
                    placeholder="filter prompt types…"
                    className="w-60 rounded-lg border border-edge bg-ink px-3 py-1.5 text-sm placeholder:text-slate-600"
                  />
                  <label className="flex items-center gap-1.5 text-xs text-slate-400">
                    <input type="checkbox" checked={showAllPrompts} onChange={(e) => setShowAllPrompts(e.target.checked)} className="accent-accent" />
                    show all {promptMatches.length}
                  </label>
                  {!expandedPrompts && promptMatches.length > 20 && (
                    <span className="text-[11px] text-slate-500">showing top &amp; bottom 10 of {promptMatches.length}</span>
                  )}
                </div>
                {promptMatches.length === 0 ? (
                  <p className="px-1 py-4 text-sm text-slate-500">No prompt type matches “{promptQuery}”.</p>
                ) : expandedPrompts ? (
                  <div>
                    <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Lowest → highest preference ({allPromptsSorted.length})
                    </h4>
                    <div className="flex flex-col">{promptList(allPromptsSorted)}</div>
                  </div>
                ) : (
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div>
                      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-bad">Lowest observed preference</h4>
                      <div className="flex flex-col">{promptList(weakPrompts)}</div>
                    </div>
                    <div>
                      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-good">Highest observed preference</h4>
                      <div className="flex flex-col">{promptList(strongPrompts)}</div>
                    </div>
                  </div>
                )}
              </>
            )}
            {row.prompt_types && row.prompt_types.length > 0 && reportBattles === null && (
              <p className="mt-2 text-[11px] text-slate-500">
                Prompt-level continuous-preference examples are not available in this dataset.
              </p>
            )}
          </Section>
          {hasLabels && !hasFire && (
            <Card>
              <p className="text-sm text-amber-400">
                The behavioural fingerprint isn't available for this dataset — showing dataset-favoured gaps only.
              </p>
            </Card>
          )}

          {hasFire && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <Segmented value={fireMode} onChange={(m) => setFireMode(m)}
                  options={[
                    { value: "freq", label: "Frequency", title: fireAbsolute
                        ? "share of this model's own answers with positive feature activity"
                        : "how often this model differs from its opponent on each behaviour (contrast rate, not prevalence)" },
                    { value: "paired", label: "Distinctive (same prompt)", title: "compares positive feature activity on answers to the same prompt" },
                    { value: "model", label: "vs model", title: "head-to-head vs a chosen model on the battles they fought each other (prompt-matched, McNemar-tested); falls back to a pooled fire-rate diff when no shared-battle data" },
                  ] as { value: FireMode; label: string; title: string }[]} />
                <Segmented value={categoryFilter} onChange={setCategoryFilter}
                  options={categoryOptions} size="xs" />
                {fireMode === "model" && (
                  <select
                    value={cmpModel ?? ""}
                    onChange={(e) => setCompareModel(e.target.value)}
                    className="rounded-lg border border-edge bg-ink px-2 py-1 text-xs"
                  >
                    {diagnosis.models
                      .filter((m) => m !== model)
                      .map((m) => (
                        <option key={m} value={m}>
                          {m}{hasLabels ? ` · ${pct(diagnosis.rows[m]?.win_rate, 0)}` : ""}
                        </option>
                      ))}
                  </select>
                )}
                {usingH2H && (
                  <label className="flex items-center gap-1.5 text-[11px] text-slate-400">
                    <input type="checkbox" checked={h2hShowAll}
                      onChange={(e) => setH2hShowAll(e.target.checked)} className="accent-accent" />
                    show non-significant{h2hHidden > 0 ? ` (${h2hHidden} hidden)` : ""}
                  </label>
                )}
                {relMode && (
                  <span className="text-[11px] text-slate-500">
                    <span style={{ color: "rgb(96,165,250)" }}>blue</span> = more ·{" "}
                    <span style={{ color: "rgb(148,163,184)" }}>grey</span> = less
                    {fireMode === "paired"
                      ? " · same-prompt contrast · significance approximate (pooled z-test treats a battle's two orientations as independent — use “vs model” for a valid paired test)"
                      : usingH2H
                        ? " · prompt-matched · McNemar, BH-FDR q<0.05"
                        : " · pooled frequency, not shared-battle"}
                  </span>
                )}
              </div>
              {!hasContextClassification && (
                <p className="text-[11px] text-amber-400/80">
                  Semantic calibration and cross-context stability are unavailable. These are
                  response concepts, not established general model tendencies; they remain unclassified.
                </p>
              )}
              {h2hPairMissing && h2hIndex && (
                <p className="text-[11px] text-amber-400/80">
                  Too few shared battles between {model} and {cmpModel} (min {h2hIndex.minShared}) —
                  showing the pooled fire-rate difference instead, which mixes different prompts.
                </p>
              )}
              {fireMode === "model" && !h2hIndex && (
                <p className="text-[11px] text-slate-500">
                  Pooled fire-rate difference (mixes each model's own prompt distribution) — the
                  prompt-matched head-to-head isn't available for this dataset.
                </p>
              )}
              <div className="grid gap-4 lg:grid-cols-2">
                <Section title={moreTitle} hint={`${moreHint}${allowExamples ? " · click a bar to see example answers" : ""}`}>
                  <BarPanel data={usingH2H ? h2hBars(h2hMore) : fireBars(moreFire)} domain={fireDomain} fmtVal={fireFmt}
                    zero={relMode} axis={relMode} labels={!relMode}
                    onBarClick={allowExamples ? (r) => r.fid != null && setOpenFeat({ fid: r.fid, src: "fire" }) : undefined} />
                </Section>
                <Section title={lessTitle} hint={`${lessHint}${allowExamples ? " · click a bar to see example answers" : ""}`}>
                  <BarPanel data={usingH2H ? h2hBars(h2hLess) : fireBars(lessFire)} domain={fireDomain} fmtVal={fireFmt}
                    zero={relMode} axis={relMode} labels={!relMode}
                    onBarClick={allowExamples ? (r) => r.fid != null && setOpenFeat({ fid: r.fid, src: "fire" }) : undefined} />
                </Section>
              </div>
              {openFeat?.src === "fire" && (
                <FeatureExamplesDrill
                  concept={conceptLabel(openFeat.fid, featureById[openFeat.fid]?.concept ?? "")}
                  examples={drillExamples}
                  mine={exByModel?.[model]?.[String(openFeat.fid)] ?? null}
                  loading={exLoading || !exRequested}
                  model={model}
                  onClose={() => setOpenFeat(null)}
                />
              )}
            </div>
          )}

          {hasLabels && (<>
          {hasCorpusAssociations && <Section
            title="Dataset-associated response axes with lower positive activity"
            hint={`response axes associated with this dataset's preferences where this model has positive activity less often than ${comparisonGroup}. This is an association — favoured ≠ objectively good, and closing a gap isn't guaranteed to raise the preference score (feature activity ≠ semantic presence or quality). Read as a lead, not a prescription.`}
          >
            {gapBars.length === 0 ? (
              <p className="px-1 py-4 text-sm text-slate-500">
                No dataset-associated response axis has lower positive activity.
              </p>
            ) : (
              <BarPanel data={gapBars} domain={[0, "dataMax"]} fmtVal={(v) => `+${v.toFixed(2)}`}
                onBarClick={allowExamples ? (r) => r.fid != null && setOpenFeat({ fid: r.fid, src: "gap" }) : undefined} />
            )}
            {openFeat?.src === "gap" && (
              <div className="mt-3">
                <FeatureExamplesDrill
                  concept={conceptLabel(openFeat.fid, featureById[openFeat.fid]?.concept ?? "")}
                  examples={drillExamples}
                  mine={exByModel?.[model]?.[String(openFeat.fid)] ?? null}
                  loading={exLoading || !exRequested}
                  model={model}
                  onClose={() => setOpenFeat(null)}
                />
              </div>
            )}
            <button
              onClick={() => setShowQuadrant((s) => !s)}
              className="mt-3 flex w-full items-center gap-2 text-left text-xs font-semibold text-slate-300 hover:text-slate-100"
            >
              {showQuadrant ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Gap quadrant
              <span className="font-normal text-slate-500">
                — delta vs {comparisonGroup} × preference association
              </span>
            </button>
            {showQuadrant && (
              <div className="mt-2">
                <GapQuadrant points={quadrantPoints} />
              </div>
            )}
          </Section>}


          <Section
            title="Preference association by prompt type"
            hint="within a prompt type, the raw difference in mean judge-preference probability when this response concept fires versus when it does not. This is descriptive association, not a causal effect. (Per-model; the 'Prompt → Response' tab is the global, preference-independent view.)"
            empty={!row.relations}
          >
            {relationBars.length === 0 ? (
              <p className="px-1 py-4 text-sm text-slate-500">
                No prompt→response edge clears the support floor for this model.
              </p>
            ) : (
              <BarPanel
                data={relationBars}
                domain={[(min: number) => Math.min(0, min), (max: number) => Math.max(0, max)]}
                fmtVal={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`}
                zero
                axis
                labels={false}
                yWidth={300}
              />
            )}
          </Section>

          <Section
            title={`Positive feature-activity profile vs ${comparisonGroup}`}
            hint={hasCorpusAssociations
              ? `Prompt-matched: how often this model has positive activity on each feature axis versus ${comparisonGroup}. Preference tags describe association with this dataset's preference scores, not objective value. Small, soft effects — feature activity, not answer quality, and not a preference predictor.`
              : "Prompt-matched: how often this model has positive feature activity versus the opponents it faced. This overlay does not contain its own corpus-level preference associations, so no favoured/disfavoured tags are shown."}
          >
            {(() => {
              const rtag = (fid: number) => {
                const f = featureById[fid];
                if (f?.delta_win_significant && f?.delta_win_rate != null)
                  return f.delta_win_rate > 0
                    ? { label: "dataset-favoured", cls: "bg-good/15 text-good" }
                    : { label: "dataset-disfavoured", cls: "bg-bad/15 text-bad" };
                return null;
              };
              const lenFlag = (fid: number) => Math.abs(featureById[fid]?.corr_confound_len ?? 0) >= 0.3;
              const byField = [...fired].filter((v) => v.under != null);
              const maxAbs = Math.max(0.001, ...byField.map((v) => Math.abs(v.under ?? 0)));
              const doesMore = [...byField].filter((v) => (v.under ?? 0) > 0)
                .sort((a, b) => (b.under ?? 0) - (a.under ?? 0)).slice(0, 12);
              const doesLess = [...byField].filter((v) => (v.under ?? 0) < 0)
                .sort((a, b) => (a.under ?? 0) - (b.under ?? 0)).slice(0, 12);
              const rows = (list: typeof doesMore) => (
                <div className="flex flex-col gap-0.5">
                  {list.length === 0 ? <p className="px-1 py-3 text-xs text-slate-500">—</p> :
                    list.map((v) => {
                      const rt = rtag(v.fid);
                      return (
                        <div key={v.fid} className="flex items-center gap-2 py-1 text-xs">
                          <span className="min-w-0 flex-1 truncate text-slate-300" title={v.concept}>{v.concept}</span>
                          {rt && <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${rt.cls}`}>{rt.label}</span>}
                          {lenFlag(v.fid) && <span className="shrink-0 text-[10px] text-amber-400" title="does-more may be does-longer (length-tracking feature)">⚑</span>}
                          <span className="hidden h-2 w-20 shrink-0 overflow-hidden rounded-full bg-edge/40 sm:block">
                            <span className="block h-full rounded-full"
                              style={{ width: `${Math.round(Math.abs(v.under ?? 0) / maxAbs * 100)}%`, background: divergeColor(v.under ?? 0, maxAbs) }} />
                          </span>
                        </div>
                      );
                    })}
                </div>
              );
              return (
                <div className="grid gap-4 md:grid-cols-2">
                  <div><h3 className="mb-1 text-[13px] font-semibold text-slate-200">More positive activity than {comparisonGroup}</h3>{rows(doesMore)}</div>
                  <div><h3 className="mb-1 text-[13px] font-semibold text-slate-200">Less positive activity than {comparisonGroup}</h3>{rows(doesLess)}</div>
                </div>
              );
            })()}
          </Section>
          </>)}
        </>
      )}
    </div>
  );
}

// Drill-in for a clicked feature bar: example answers that EXHIBIT the behaviour. The
// example's z (= z_diff, f(A)−f(B)) sign says which side expresses the feature more, so we
// show that side's completion + the model that produced it. This model's own examples are
// surfaced first; if the sampled top-activating examples include none from this model, we
// fall back to the global strongest (honestly labelled).
function FeatureExamplesDrill({
  concept,
  examples,
  mine,
  loading,
  model,
  onClose,
}: {
  concept: string;
  examples: Example[] | null | undefined; // this feature's shard (cross-model fallback)
  mine: ModelExample[] | null; // this model's OWN answers (examples_by_model), preferred
  loading?: boolean; // per-model examples file still streaming
  model: string;
  onClose: () => void;
}) {
  const clipC = (s: string, n = 1600) => (s.length > n ? s.slice(0, n) + " …[truncated]" : s);
  const tone = (o: string) =>
    o === "win" ? "text-good" : o === "loss" ? "text-bad" : "text-slate-400";

  // prefer the model's OWN answers; fall back to the global cross-model set (labelled).
  const useMine = !!mine && mine.length > 0;
  // while the (large) per-model file streams, DON'T flash the cross-model fallback — it
  // would misattribute another model's text to this one.
  if (!useMine && loading)
    return (
      <div className="mt-3 rounded-xl border border-accent/40 bg-accent/5 p-3">
        <div className="mb-2 flex items-start justify-between gap-2">
          <h4 className="text-sm font-semibold text-slate-200">{model} answers exhibiting “{concept}”</h4>
          <button onClick={onClose} className="text-xs text-slate-500 hover:text-slate-300">close</button>
        </div>
        <SkeletonList n={2} itemClass="h-20" />
      </div>
    );
  const globalItems = (examples ?? [])
    .map((e) => {
      // e.z is a CONTRAST (z_diff = f(A)−f(B)); its sign says which side expresses the
      // concept MORE, not "how much this answer exhibits it". Pick that side and keep the
      // magnitude for display (a signed value here reads as a scary negative).
      const aSide = e.z >= 0;
      return { z: e.z, mag: Math.abs(e.z), prompt: e.prompt,
               exModel: aSide ? e.model_a : e.model_b, vsModel: aSide ? e.model_b : e.model_a,
               completion: aSide ? e.completion_a : e.completion_b };
    })
    .sort((a, b) => b.mag - a.mag);
  const empty = useMine ? false : globalItems.length === 0;

  return (
    <div className="mt-3 rounded-xl border border-accent/40 bg-accent/5 p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-200">
          {useMine ? `${model} answers exhibiting ` : "Pairwise examples with strongest contrast on "}“{concept}”
        </h4>
        <button onClick={onClose} className="text-xs text-slate-500 hover:text-slate-300">close</button>
      </div>
      {empty ? (
        <p className="px-1 py-3 text-xs text-slate-500">
          No example answers for this feature in this dataset.
        </p>
      ) : useMine ? (
        <div className="flex flex-col gap-3">
          {mine!.map((it, i) => (
            <div key={i} className="rounded-lg border border-edge bg-ink/40 p-2 text-xs">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="rounded bg-accent/20 px-1.5 py-0.5 font-medium text-accent">{model}</span>
                {it.preference_probability != null ? (
                  <span className="font-mono text-slate-400">
                    judge preference {pct(it.preference_probability, 1)}
                  </span>
                ) : it.outcome ? (
                  <span className={`font-semibold ${tone(it.outcome)}`}>{it.outcome}</span>
                ) : null}
                <span className="font-mono text-slate-500">positive activity {it.z.toFixed(2)}</span>
              </div>
              <div className="mb-1 text-slate-400">
                <span className="font-semibold text-slate-300">prompt:</span> {clip(it.prompt, 280)}
              </div>
              <div className="whitespace-pre-wrap text-slate-300">{clipC(it.answer)}</div>
            </div>
          ))}
        </div>
      ) : (
        <>
          <p className="mb-2 text-[11px] text-slate-500">
            No positive-pole answers from {model} are in the per-model sample. The fallback
            shows the higher-scoring side of strong pairwise contrasts across models; relative
            contrast alone does not prove positive-pole concept presence.
          </p>
          <div className="flex flex-col gap-3">
            {globalItems.map((it, i) => (
              <div key={i} className="rounded-lg border border-edge bg-ink/40 p-2 text-xs">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="rounded bg-slate-600/25 px-1.5 py-0.5 font-medium text-slate-400">{it.exModel}</span>
                  <span className="font-mono text-slate-500"
                    title={`differential activation vs ${it.vsModel}'s answer to the same prompt — this side expresses the concept more`}>
                    expresses +{it.mag.toFixed(2)} vs {it.vsModel}
                  </span>
                </div>
                <div className="mb-1 text-slate-400">
                  <span className="font-semibold text-slate-300">prompt:</span> {clip(it.prompt, 280)}
                </div>
                <div className="whitespace-pre-wrap text-slate-300">{clipC(it.completion)}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// The missing "why" between a weak prompt type and raw transcripts: this model's
// prompt->response Δwin edges restricted to THAT prompt type — which behaviours pay off
// (or cost) specifically here. Click a row to open the behaviour in the Feature panel.
function PromptTypeWhy({
  relations, concept, fidByConcept, onJumpFeature,
}: {
  relations: { prompt_concept: string; response_concept: string; delta_win: number; n: number }[];
  concept: string;
  fidByConcept: Map<string, number>;
  onJumpFeature?: (cf: number) => void;
}) {
  const rows = relations
    .filter((r) => r.prompt_concept === concept)
    .sort((a, b) => Math.abs(b.delta_win) - Math.abs(a.delta_win))
    .slice(0, 8);
  if (rows.length === 0) return null;
  const maxD = Math.max(0.02, ...rows.map((r) => Math.abs(r.delta_win)));
  return (
    <div className="mb-1 ml-6 mt-1 rounded-lg border border-edge/60 bg-ink/40 p-2">
      <p className="mb-1 text-[11px] text-slate-500">
        Preference association on this prompt type (raw mean judge-preference probability gap when the response concept fires versus not):
      </p>
      {rows.map((r, i) => {
        const fid = fidByConcept.get(r.response_concept);
        const jump = fid != null && onJumpFeature ? () => onJumpFeature(fid) : undefined;
        return (
          <button key={i} onClick={jump} disabled={!jump}
            title={`raw preference-probability gap ${r.delta_win >= 0 ? "+" : ""}${(r.delta_win * 100).toFixed(1)}pp · n=${r.n}${jump ? " · open in Feature panel" : ""}`}
            className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs transition-colors duration-150 ${
              jump ? "hover:bg-edge/30" : "cursor-default"}`}>
            <span className="min-w-0 flex-1 truncate text-slate-300">{r.response_concept}</span>
            <span className="hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-edge/40 sm:block">
              <span className="block h-full rounded-full"
                style={{ width: `${Math.round((Math.abs(r.delta_win) / maxD) * 100)}%`, background: divergeColor(r.delta_win, WINRATE_REF) }} />
            </span>
            <span className="w-12 shrink-0 text-right tabular-nums text-slate-400">
              {r.delta_win >= 0 ? "+" : ""}{Math.round(r.delta_win * 100)}pp
            </span>
          </button>
        );
      })}
    </div>
  );
}

function BattleDrill({ battles, model }: { battles: ReportBattle[]; model: string }) {
  if (battles.length === 0)
    return (
      <p className="px-3 py-2 text-xs text-slate-500">
        No prompt examples were exported for this prompt slice.
      </p>
    );
  const tone = (o?: string) =>
    o === "win" ? "text-good" : o === "loss" ? "text-bad" : "text-slate-400";
  return (
    <div className="mb-2 ml-5 flex flex-col gap-3 border-l border-edge pl-3">
      {battles.map((b, i) => (
        <div key={b.row_id ?? i} className="rounded-lg border border-edge bg-ink/40 p-2 text-xs">
          <div className="mb-1 text-slate-400">
            <span className="font-semibold text-slate-300">prompt:</span> {b.prompt}
          </div>
          {b.preference_probability != null && (
            <div className="mb-2 flex flex-wrap gap-3 font-mono text-slate-400">
              <span>judge preference for {model}: {pct(b.preference_probability, 1)}</span>
              {b.preference_probability_swap_1 != null && b.preference_probability_swap_2 != null && (
                <span>position swaps: {pct(b.preference_probability_swap_1, 1)} / {pct(b.preference_probability_swap_2, 1)}</span>
              )}
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <div className={`mb-0.5 font-semibold ${tone(b.outcome)}`}>
                {model}{b.outcome ? ` (${b.outcome})` : ""}
              </div>
              <div className="whitespace-pre-wrap text-slate-300">{b.self}</div>
            </div>
            <div>
              <div className="mb-0.5 font-semibold text-slate-500">{b.other_model ?? "the other model"}</div>
              <div className="whitespace-pre-wrap text-slate-400">{b.other}</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
