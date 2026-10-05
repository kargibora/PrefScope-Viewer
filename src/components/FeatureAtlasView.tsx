import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Maximize2, Search, Share2, ZoomIn, ZoomOut } from "lucide-react";
import type {
  CoactivationPair,
  ConceptCoactivation,
  Example,
  Feature,
  FeatureMapData,
  FeatureMapPoint,
  PromptExample,
} from "../types";
import { pct, useFeatureExamples, usePromptExamples } from "../data";
import {
  Card,
  ConceptLabel,
  Explain,
  SkeletonList,
  VerifiedBadge,
  conceptLabel,
  isUnnamed,
} from "./ui";
import {
  ActivationEvidenceCard,
  EvidenceModeSelect,
  EvidencePager,
  ExampleGroupSelect,
  activationDomain,
  evidenceMode,
  evidenceModes,
  type EvidenceMode,
} from "./ActivationEvidence";
import { answerTypeOf, useAnalysisFilters, type AnswerTypeFilter } from "../analysisFilters";

type StatusFilter = "all" | "verified" | "named" | "failed" | "unnamed";
type ColorMode = "family" | "verification";

const WIDTH = 1000;
const HEIGHT = 620;
const PAD = 34;

const FAMILY_COLORS: Record<string, string> = {
  behavioral: "#34d399",
  prompt_specific: "#60a5fa",
  mixed_or_unclear: "#fbbf24",
  unclassified: "#64748b",
};

const STATUS_COLORS = {
  verified: "#34d399",
  failed: "#f59e0b",
  untested: "#64748b",
  unnamed: "#334155",
};

const featureFamily = (feature: Feature | undefined) => answerTypeOf(feature);

const statusOf = (feature: Feature | undefined) => {
  if (!feature || isUnnamed(feature.concept)) return "unnamed" as const;
  if (feature.fidelity_pass === true) return "verified" as const;
  if (feature.fidelity_pass === false) return "failed" as const;
  return "untested" as const;
};

export function AtlasExamples({ fid, concept, initialGroup = "" }: { fid: number; concept: string; initialGroup?: string }) {
  const raw = useFeatureExamples(fid);
  const { filters, setGroup } = useAnalysisFilters();
  const group = initialGroup || filters.group;
  const [mode, setMode] = useState<EvidenceMode>("strongest");
  const [exampleIndex, setExampleIndex] = useState(0);
  useEffect(() => { setMode("strongest"); setExampleIndex(0); }, [fid]);
  useEffect(() => { setExampleIndex(0); }, [group, mode]);
  const paired = useMemo(() => (raw ?? []).some((row) => Boolean(row.completion_b)), [raw]);
  const allExamples = useMemo(() => (raw ?? []).map((row: Example) => {
    const aSide = row.z >= 0;
    return {
      z: row.z,
      prompt: row.prompt,
      model: paired ? (aSide ? row.model_a : row.model_b) : row.model_a,
      response: paired ? (aSide ? row.completion_a : row.completion_b) : row.completion_a,
      group: row.group,
      groupColumn: row.group_column,
      activationPercentile: row.activation_percentile,
      selectionKind: row.selection_kind,
    };
  }).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)), [raw, paired]);
  const groups = useMemo(() => [...new Set(allExamples.map((row) => row.group).filter((value): value is string => Boolean(value)))].sort(), [allExamples]);
  const modes = useMemo(() => evidenceModes(allExamples.map((row) => ({ selection_kind: row.selectionKind }))), [allExamples]);
  const effectiveMode = modes.includes(mode) ? mode : modes[0] ?? "strongest";
  const examples = useMemo(() => allExamples.filter((row) =>
    (!group || row.group === group) && evidenceMode(row.selectionKind) === effectiveMode,
  ).slice(0, 6), [allExamples, group, effectiveMode]);
  const domain = useMemo(() => activationDomain(allExamples.map((row) => row.z)), [allExamples]);
  const groupColumn = allExamples.find((row) => row.groupColumn)?.groupColumn ?? "language";
  const missingGroupMetadata = Boolean(group && raw && groups.length === 0);

  if (raw === undefined)
    return <Card><SkeletonList n={3} itemClass="h-24" /></Card>;

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-100">Answer examples</h3>
        <div className="flex flex-wrap items-center gap-3"><EvidenceModeSelect modes={modes} value={effectiveMode} onChange={setMode} /><ExampleGroupSelect groups={groups} value={group} onChange={(value) => setGroup(value, groupColumn)} column={groupColumn} /><EvidencePager index={Math.min(exampleIndex, Math.max(0, examples.length - 1))} count={examples.length} onChange={setExampleIndex} /></div>
      </div>
      {examples.length === 0 ? (
        <p className="text-sm text-slate-500">
          {missingGroupMetadata
            ? `This older example shard has no ${groupColumn} metadata. Re-export it to filter evidence.`
            : group
              ? `No retained ${groupColumn}=${group} example for ${concept}.`
              : <>No text example was exported for {concept}. Re-export with <code>--corpus</code>.</>}
        </p>
      ) : (
        <div>{(() => { const example = examples[exampleIndex] ?? examples[0]; return (
          <ActivationEvidenceCard prompt={example.prompt} response={example.response}
            value={example.z} min={domain.min} max={domain.max}
            label={paired ? "A−B contrast" : "Activation"} model={example.model}
            percentile={example.activationPercentile} selectionKind={example.selectionKind} />
        ); })()}</div>
      )}
    </Card>
  );
}

export function PromptAtlasExamples({ fid, concept, initialGroup = "" }: { fid: number; concept: string; initialGroup?: string }) {
  const raw = usePromptExamples(fid);
  const { filters, setGroup } = useAnalysisFilters();
  const group = initialGroup || filters.group;
  const [mode, setMode] = useState<EvidenceMode>("strongest");
  const [exampleIndex, setExampleIndex] = useState(0);
  useEffect(() => { setMode("strongest"); setExampleIndex(0); }, [fid]);
  useEffect(() => { setExampleIndex(0); }, [group, mode]);
  const allExamples = useMemo(
    () => (raw ?? []).slice().sort((a: PromptExample, b: PromptExample) => b.z - a.z),
    [raw],
  );
  const groups = useMemo(() => [...new Set(allExamples.map((row) => row.group).filter((value): value is string => Boolean(value)))].sort(), [allExamples]);
  const modes = useMemo(() => evidenceModes(allExamples), [allExamples]);
  const effectiveMode = modes.includes(mode) ? mode : modes[0] ?? "strongest";
  const examples = useMemo(() => allExamples.filter((row) =>
    (!group || row.group === group) && evidenceMode(row.selection_kind) === effectiveMode,
  ).slice(0, 8), [allExamples, group, effectiveMode]);
  const domain = useMemo(() => activationDomain(allExamples.map((row) => row.z)), [allExamples]);
  const groupColumn = allExamples.find((row) => row.group_column)?.group_column ?? "language";
  const missingGroupMetadata = Boolean(group && raw && groups.length === 0);
  if (raw === undefined)
    return <Card><SkeletonList n={3} itemClass="h-20" /></Card>;
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-100">Strongest prompt examples</h3>
        <div className="flex flex-wrap items-center gap-3"><EvidenceModeSelect modes={modes} value={effectiveMode} onChange={setMode} /><ExampleGroupSelect groups={groups} value={group} onChange={(value) => setGroup(value, groupColumn)} column={groupColumn} /><EvidencePager index={Math.min(exampleIndex, Math.max(0, examples.length - 1))} count={examples.length} onChange={setExampleIndex} /></div>
      </div>
      {raw === null ? (
        <p className="text-sm text-slate-500">No prompt examples were exported for {concept}.</p>
      ) : examples.length === 0 ? (
        <p className="text-sm text-slate-500">
          {missingGroupMetadata
            ? `This older example shard has no ${groupColumn} metadata. Re-export it to filter evidence.`
            : group
              ? `No saved ${groupColumn}=${group} prompt for this concept.`
              : "No matching prompt example was saved for this concept."}
        </p>
      ) : (
        <div>{(() => { const example = examples[exampleIndex] ?? examples[0]; return (
          <ActivationEvidenceCard prompt={example.prompt} value={example.z}
            min={domain.min} max={domain.max} percentile={example.activation_percentile}
            selectionKind={example.selection_kind} />
        ); })()}</div>
      )}
    </Card>
  );
}

function metricRate(feature: Feature | undefined) {
  return feature?.semantic_presence_rate ?? feature?.generality ?? feature?.fire_rate;
}

export default function FeatureAtlasView({
  map,
  features,
  coactivation,
  kind = "response",
  onOpenFeature,
  onInspectFeature,
  onOpenCoactivation,
}: {
  map: FeatureMapData | null;
  features: Feature[];
  coactivation: ConceptCoactivation | null | undefined;
  kind?: "response" | "prompt";
  onOpenFeature?: (featureId: number) => void;
  onInspectFeature?: (featureId: number) => void;
  onOpenCoactivation?: (featureId: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    x: number;
    y: number;
  } | null>(null);
  const byId = useMemo(() => new Map(features.map((feature) => [feature.feature_id, feature])), [features]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [armedId, setArmedId] = useState<number | null>(null);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const { filters, setAnswerType } = useAnalysisFilters();
  const family = filters.answerType;
  const [colorMode, setColorMode] = useState<ColorMode>(kind === "prompt" ? "verification" : "family");
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });

  const projected = useMemo(() => {
    if (!map?.points.length) return [] as (FeatureMapPoint & { px: number; py: number })[];
    const xs = map.points.map((point) => point.x);
    const ys = map.points.map((point) => point.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    return map.points.map((point) => ({
      ...point,
      px: PAD + ((point.x - minX) / spanX) * (WIDTH - 2 * PAD),
      py: PAD + (1 - (point.y - minY) / spanY) * (HEIGHT - 2 * PAD),
    }));
  }, [map]);
  const pointById = useMemo(() => new Map(projected.map((point) => [point.feature_id, point])), [projected]);

  const q = query.trim().toLowerCase();
  const passesFilter = (point: FeatureMapPoint) => {
    const feature = byId.get(point.feature_id);
    const featureStatus = statusOf(feature);
    if (status === "verified" && featureStatus !== "verified") return false;
    if (status === "named" && featureStatus === "unnamed") return false;
    if (status === "failed" && featureStatus !== "failed") return false;
    if (status === "unnamed" && featureStatus !== "unnamed") return false;
    if (kind === "response" && family !== "all" && featureFamily(feature) !== family) return false;
    return true;
  };
  const queryMatch = (point: FeatureMapPoint) => {
    if (!q) return true;
    const feature = byId.get(point.feature_id);
    return String(point.feature_id) === q
      || `feature ${point.feature_id}`.includes(q)
      || (feature?.concept ?? "").toLowerCase().includes(q)
      || (feature?.feature_summary ?? "").toLowerCase().includes(q);
  };
  const filtered = useMemo(() => projected.filter(passesFilter), [projected, byId, status, family]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (selectedId != null && filtered.some((point) => point.feature_id === selectedId)) return;
    const first = filtered.find((point) => byId.get(point.feature_id)?.fidelity_pass)
      ?? filtered.find((point) => !isUnnamed(byId.get(point.feature_id)?.concept))
      ?? filtered[0];
    setSelectedId(first?.feature_id ?? null);
  }, [byId, filtered, selectedId]);
  const listed = useMemo(() => filtered.filter(queryMatch).sort((a, b) => {
    if (String(a.feature_id) === q) return -1;
    if (String(b.feature_id) === q) return 1;
    return conceptLabel(a.feature_id, byId.get(a.feature_id)?.concept)
      .localeCompare(conceptLabel(b.feature_id, byId.get(b.feature_id)?.concept));
  }), [filtered, q, byId]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = selectedId == null ? undefined : byId.get(selectedId);
  const selectedPoint = selectedId == null ? undefined : pointById.get(selectedId);
  const pairs = useMemo(() => {
    if (selectedId == null || !coactivation) return [] as CoactivationPair[];
    return coactivation.pairs
      .filter((pair) => pair.a === selectedId || pair.b === selectedId)
      .filter((pair) => family === "all"
        || (featureFamily(byId.get(pair.a)) === family && featureFamily(byId.get(pair.b)) === family))
      .sort((a, b) => b.lift - a.lift || b.count - a.count)
      .slice(0, 16);
  }, [coactivation, selectedId, family, byId]);
  const edgeIds = useMemo(() => new Set(pairs.flatMap((pair) => [pair.a, pair.b])), [pairs]);

  const colorOf = (point: FeatureMapPoint) => {
    const feature = byId.get(point.feature_id);
    if (colorMode === "verification") return STATUS_COLORS[statusOf(feature)];
    return FAMILY_COLORS[featureFamily(feature)];
  };
  const radiusOf = (point: FeatureMapPoint) => {
    const rate = metricRate(byId.get(point.feature_id));
    return rate == null ? 3.5 : 2.8 + Math.min(5.2, Math.sqrt(Math.max(0, rate)) * 8);
  };

  const selectAndCentre = (featureId: number) => {
    setSelectedId(featureId);
    const point = pointById.get(featureId);
    if (!point) return;
    setTransform((current) => ({
      ...current,
      x: WIDTH / 2 - point.px * current.k,
      y: HEIGHT / 2 - point.py * current.k,
    }));
  };
  const focusAndArm = (featureId: number) => {
    selectAndCentre(featureId);
    setArmedId(featureId);
  };
  const activateFeature = (featureId: number) => {
    if (selectedId === featureId && armedId === featureId) {
      onInspectFeature?.(featureId);
      return;
    }
    focusAndArm(featureId);
  };
  const reset = () => setTransform({ x: 0, y: 0, k: 1 });
  const zoomBy = (factor: number) => setTransform((current) => {
    const k = Math.max(0.75, Math.min(8, current.k * factor));
    const wx = (WIDTH / 2 - current.x) / current.k;
    const wy = (HEIGHT / 2 - current.y) / current.k;
    return { k, x: WIDTH / 2 - wx * k, y: HEIGHT / 2 - wy * k };
  });
  const onWheel = (event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const mx = ((event.clientX - rect.left) / rect.width) * WIDTH;
    const my = ((event.clientY - rect.top) / rect.height) * HEIGHT;
    setTransform((current) => {
      const k = Math.max(0.75, Math.min(8, current.k * Math.exp(-event.deltaY * 0.0015)));
      const wx = (mx - current.x) / current.k;
      const wy = (my - current.y) / current.k;
      return { k, x: mx - wx * k, y: my - wy * k };
    });
  };

  if (!map)
    return <Card><p className="text-sm text-slate-400">This bundle has no feature atlas.</p></Card>;

  const selectedName = selectedId == null ? "" : conceptLabel(selectedId, selected?.concept);

  return (
    <div className="space-y-4">
      <Explain>
        Every dot is one learned {kind === "prompt" ? "prompt" : "answer"} feature. Nearby dots
        have similar learned directions; the names do not set their positions. Click once to
        focus a feature and see its links. Click it again to open its examples. A line means
        two feature axes often have positive activity together, not that one causes the other.
      </Explain>

      <Card>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-50">{kind === "prompt" ? "Prompt concept map" : "Answer concept map"}</h2>
            <p className="mt-1 text-xs text-slate-500">
              {map.n_total.toLocaleString()} features plotted · {map.n_named.toLocaleString()} named · {map.n_verified.toLocaleString()} labels checked · {map.projection.toUpperCase()} layout
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" className="icon-button grid" onClick={() => zoomBy(1.35)} aria-label="Zoom in"><ZoomIn size={16} /></button>
            <button type="button" className="icon-button grid" onClick={() => zoomBy(1 / 1.35)} aria-label="Zoom out"><ZoomOut size={16} /></button>
            <button type="button" className="icon-button grid" onClick={reset} aria-label="Reset atlas view"><Maximize2 size={16} /></button>
          </div>
        </div>

        <div className="grid min-w-0 gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
          <div className="min-w-0 rounded-xl border border-edge/70 bg-ink/40 p-3">
            <label className="relative block">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-slate-500" />
              <input value={query} onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name or feature ID…" aria-label="Search feature atlas"
                className="w-full rounded-lg border border-edge bg-ink py-2 pl-8 pr-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-accent/60" />
            </label>
            <div className={`mt-2 grid gap-2 ${kind === "response" ? "grid-cols-2" : "grid-cols-1"}`}>
              <select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}
                aria-label="Filter map by label status"
                className="min-w-0 rounded-lg border border-edge bg-ink px-2 py-2 text-xs text-slate-300 outline-none">
                <option value="all">All statuses</option>
                <option value="verified">Label checked</option>
                <option value="named">Named</option>
                <option value="failed">Failed check</option>
                <option value="unnamed">Unnamed</option>
              </select>
              {kind === "response" && <select value={family} onChange={(event) => setAnswerType(event.target.value as AnswerTypeFilter)}
                aria-label="Filter map by answer type"
                className="min-w-0 rounded-lg border border-edge bg-ink px-2 py-2 text-xs text-slate-300 outline-none">
                <option value="all">All answer types</option>
                <option value="behavioral">Behavior or style</option>
                <option value="prompt_specific">Prompt or topic</option>
                <option value="mixed_or_unclear">Mixed or unclear</option>
                <option value="unclassified">Not classified</option>
              </select>}
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
              <span>{listed.length.toLocaleString()} matches</span>
              <span>{filtered.length.toLocaleString()} visible</span>
            </div>
            <div className="mt-2 max-h-[460px] space-y-1 overflow-auto pr-1">
              {listed.length === 0 ? <p className="py-6 text-center text-xs text-slate-500">No matching feature.</p> : listed.map((point) => {
                const feature = byId.get(point.feature_id);
                return (
                  <button key={point.feature_id} type="button" onClick={() => activateFeature(point.feature_id)}
                    className={`flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left transition ${selectedId === point.feature_id ? "bg-accent/15 ring-1 ring-inset ring-accent/35" : "hover:bg-edge/40"}`}>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colorOf(point) }} />
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{conceptLabel(point.feature_id, feature?.concept)}</span>
                    <span className="shrink-0 font-mono text-[10px] text-slate-600">#{point.feature_id}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
              {kind === "response" && <div className="flex items-center gap-2">
                <span className="text-slate-500">Color by</span>
                <select value={colorMode} onChange={(event) => setColorMode(event.target.value as ColorMode)}
                  className="rounded-lg border border-edge bg-ink px-2 py-1.5 text-xs text-slate-300 outline-none">
                  <option value="family">Answer type</option>
                  <option value="verification">Label check</option>
                </select>
              </div>}
              <span className="text-slate-600">wheel to zoom · drag to pan · click to focus · click again for evidence</span>
            </div>
            <div className="relative overflow-hidden rounded-xl border border-edge/80 bg-[#080b12]">
              <svg ref={svgRef} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img"
                aria-label={`Interactive map of ${map.n_total} SAE features`}
                className="block h-auto min-h-[430px] w-full touch-none select-none"
                onWheel={onWheel}
                onPointerDown={(event) => {
                  if ((event.target as Element).tagName === "circle") return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  dragRef.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: transform.x, y: transform.y };
                }}
                onPointerMove={(event) => {
                  const drag = dragRef.current;
                  if (!drag || drag.pointerId !== event.pointerId) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  setTransform((current) => ({ ...current,
                    x: drag.x + (event.clientX - drag.clientX) * WIDTH / rect.width,
                    y: drag.y + (event.clientY - drag.clientY) * HEIGHT / rect.height,
                  }));
                }}
                onPointerUp={() => { dragRef.current = null; }}
                onPointerCancel={() => { dragRef.current = null; }}>
                <defs>
                  <radialGradient id="atlas-bg" cx="50%" cy="45%" r="75%">
                    <stop offset="0%" stopColor="#121b2c" />
                    <stop offset="100%" stopColor="#080b12" />
                  </radialGradient>
                </defs>
                <rect width={WIDTH} height={HEIGHT} fill="url(#atlas-bg)" />
                <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
                  {pairs.map((pair) => {
                    const a = pointById.get(pair.a), b = pointById.get(pair.b);
                    if (!a || !b) return null;
                    return <line key={`${pair.a}-${pair.b}`} x1={a.px} y1={a.py} x2={b.px} y2={b.py}
                      stroke="#a5b4fc" strokeWidth={(0.5 + Math.min(2.5, Math.log1p(pair.lift))) / transform.k}
                      strokeOpacity={0.36} vectorEffect="non-scaling-stroke" />;
                  })}
                  {projected.map((point) => {
                    const visible = passesFilter(point);
                    const matches = queryMatch(point);
                    const chosen = point.feature_id === selectedId;
                    const neighbor = edgeIds.has(point.feature_id);
                    const dimmed = !visible || (q !== "" && !matches) || (selectedId != null && pairs.length > 0 && !neighbor);
                    return (
                      <circle key={point.feature_id} cx={point.px} cy={point.py}
                        r={(chosen ? radiusOf(point) + 3 : radiusOf(point)) / Math.sqrt(transform.k)}
                        fill={colorOf(point)} fillOpacity={dimmed ? 0.08 : chosen ? 1 : 0.72}
                        stroke={chosen ? "#f8fafc" : neighbor ? "#c7d2fe" : "transparent"}
                        strokeWidth={(chosen ? 2.2 : 1.2) / transform.k}
                        className="cursor-pointer outline-none"
                        tabIndex={point.feature_id === selectedId ? 0 : -1}
                        onMouseEnter={() => setHoveredId(point.feature_id)}
                        onMouseLeave={() => setHoveredId(null)}
                        onClick={(event) => { event.stopPropagation(); activateFeature(point.feature_id); }}
                        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activateFeature(point.feature_id); } }}>
                        <title>{conceptLabel(point.feature_id, byId.get(point.feature_id)?.concept)} · feature {point.feature_id} · click again for evidence</title>
                      </circle>
                    );
                  })}
                </g>
              </svg>
              {(hoveredId != null || selectedId != null) && (() => {
                const fid = hoveredId ?? selectedId!;
                const feature = byId.get(fid);
                return <div className="pointer-events-none absolute left-3 top-3 max-w-[min(75%,32rem)] rounded-lg border border-edge bg-ink/90 px-3 py-2 text-xs shadow-xl">
                  <div className="font-medium text-slate-100">{conceptLabel(fid, feature?.concept)}</div>
                  <div className="mt-0.5 text-slate-500">feature {fid} · {featureFamily(feature).replace(/_/g, " ")}</div>
                  {fid === selectedId && fid === armedId && (
                    <div className="mt-1 font-medium text-accent-soft">selected · click again to open evidence</div>
                  )}
                </div>;
              })()}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
              {(kind === "prompt" || colorMode === "verification" ? [
                ["label checked", STATUS_COLORS.verified], ["label uncertain", STATUS_COLORS.failed],
                ["not checked", STATUS_COLORS.untested], ["unnamed", STATUS_COLORS.unnamed],
              ] : [
                ["behavioral", FAMILY_COLORS.behavioral], ["prompt-specific", FAMILY_COLORS.prompt_specific],
                ["mixed", FAMILY_COLORS.mixed_or_unclear], ["unclassified", FAMILY_COLORS.unclassified],
              ]).map(([label, color]) => <span key={label} className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: color }} />{label}</span>)}
            </div>
          </div>
        </div>
      </Card>

      {selectedId != null && selectedPoint && (
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="min-w-0 space-y-4">
            <Card>
              <div className="min-w-0">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{kind === "prompt" ? "Prompt concept" : "Answer concept"} {selectedId}</div>
                <h3 className="text-lg font-semibold leading-snug text-slate-50"><ConceptLabel id={selectedId} name={selected?.concept} wrap /></h3>
                <div className="mt-2"><VerifiedBadge pass={selected?.fidelity_pass} n={selected?.fidelity_n} /></div>
              </div>
              {selected?.feature_summary && <p className="mt-3 break-words text-sm leading-relaxed text-slate-400">{selected.feature_summary}</p>}
              <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                {kind === "response" && <><div><dt className="text-slate-500">Answer role</dt><dd className="mt-1 text-slate-200">{selected?.semantic_role?.replace(/_/g, " ") ?? "not classified"}</dd></div>
                <div><dt className="text-slate-500">Answer type</dt><dd className="mt-1 text-slate-200">{featureFamily(selected).replace(/_/g, " ")}</dd></div>
                <div><dt className="text-slate-500">Answer share</dt><dd className="mt-1 text-slate-200">{pct(metricRate(selected), 2)}</dd></div></>}
                <div><dt className="text-slate-500">Decoder norm</dt><dd className="mt-1 font-mono text-slate-200">{selectedPoint.decoder_norm.toFixed(3)}</dd></div>
              </dl>
              {selectedPoint.zero_decoder && <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-2 text-xs text-amber-300">This decoder column has zero norm, so its atlas position is only a visibility placeholder.</p>}
              <div className="mt-4 flex flex-wrap gap-2">
                {onOpenFeature && <button type="button" onClick={() => onOpenFeature(selectedId)} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent/90"><ExternalLink size={13} />Open {kind === "prompt" ? "prompt context" : "concept report"}</button>}
                {onOpenCoactivation && <button type="button" onClick={() => onOpenCoactivation(selectedId)} className="inline-flex items-center gap-1.5 rounded-lg border border-edge px-3 py-2 text-xs text-slate-300 hover:bg-edge/40"><Share2 size={13} />All links</button>}
              </div>
            </Card>

            <Card>
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-slate-100">Often has positive activity with</h3>
                <span className="text-xs text-slate-500">{pairs.length} retained</span>
              </div>
              {coactivation === undefined ? <SkeletonList n={3} itemClass="h-10" /> : pairs.length === 0 ? (
                <p className="text-sm text-slate-500">No saved concept pair for this feature.</p>
              ) : (
                <div className="space-y-1">
                  {pairs.slice(0, 10).map((pair) => {
                    const other = pair.a === selectedId ? pair.b : pair.a;
                    const feature = byId.get(other);
                    return <button key={`${pair.a}-${pair.b}`} type="button" onClick={() => focusAndArm(other)}
                      className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-edge/40">
                      <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{conceptLabel(other, feature?.concept)}</span>
                      <span className="shrink-0 font-mono text-[10px] text-slate-600">#{other}</span>
                      <span className="shrink-0 text-xs tabular-nums text-accent-soft">{pair.lift.toFixed(1)}×</span>
                      <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-slate-600">n={pair.count}</span>
                    </button>;
                  })}
                </div>
              )}
            </Card>
          </div>
          {kind === "prompt"
            ? <PromptAtlasExamples fid={selectedId} concept={selectedName} />
            : <AtlasExamples fid={selectedId} concept={selectedName} />}
        </div>
      )}
    </div>
  );
}
