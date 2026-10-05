import { useEffect, useMemo, useRef, useState } from "react";
import type { ResponseMapData, ResponseMapPoint } from "../types";
import { Card, Explain } from "./ui";
import { extent } from "./VirtualList";

const PALETTE = [
  "#60a5fa", "#f87171", "#34d399", "#fbbf24", "#a78bfa", "#fb923c",
  "#22d3ee", "#f472b6", "#a3e635", "#e879f9", "#2dd4bf", "#facc15",
  "#818cf8", "#fca5a5", "#4ade80", "#fdba74", "#38bdf8", "#c084fc",
  "#fde047", "#5eead4", "#f9a8d4", "#bef264", "#93c5fd", "#fcd34d",
];
const GREY = "#475569";
const HEIGHT = 560;
type Mode = "behavior" | "feature";

export default function ResponseMapView({ map }: { map: ResponseMapData | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<{ pt: ResponseMapPoint; x: number; y: number } | null>(null);
  const [picked, setPicked] = useState<ResponseMapPoint | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const hasBehaviors = !!(map?.behaviors && map?.clusters);
  const [mode, setMode] = useState<Mode>(hasBehaviors ? "behavior" : "feature");
  const [minAct, setMinAct] = useState(0);
  const screen = useRef<{ sx: number; sy: number; pt: ResponseMapPoint }[]>([]);

  const maxMag = useMemo(() => Math.max(1e-6, ...(map?.points.map((p) => p.m ?? 0) ?? [1])), [map]);
  const featIdx = useMemo(() => {
    const m = new Map<number, number>();
    map?.features.forEach((fid, i) => m.set(fid, i));
    return m;
  }, [map]);

  const groupOf = (p: ResponseMapPoint): number => {
    if (mode === "feature") return p.f;
    if (p.f < 0 || !map?.clusters) return -1;
    return map.clusters[featIdx.get(p.f) ?? -1] ?? -1;
  };
  const colorOfGroup = (g: number): string => {
    if (g < 0) return GREY;
    if (mode === "behavior") return PALETTE[g % PALETTE.length];
    return PALETTE[(featIdx.get(g) ?? 0) % PALETTE.length];
  };
  const conceptOf = (p: ResponseMapPoint): string =>
    p.f < 0 ? "no verified feature fired" : map?.concepts[featIdx.get(p.f) ?? 0] ?? `feature ${p.f}`;

  const legend = useMemo(() => {
    if (!map) return [] as { id: number; label: string; color: string }[];
    if (mode === "behavior" && map.behaviors && map.clusters) {
      const seen = new Set<number>();
      const items: { id: number; label: string; color: string }[] = [];
      for (const c of map.clusters) {
        if (c < 0 || seen.has(c)) continue;
        seen.add(c);
        items.push({ id: c, label: map.behaviors[String(c)] ?? `behavior ${c}`, color: PALETTE[c % PALETTE.length] });
      }
      return items.sort((a, b) => a.id - b.id);
    }
    return map.features.map((fid, i) => ({ id: fid, label: map.concepts[i], color: PALETTE[i % PALETTE.length] }));
  }, [map, mode]);

  useEffect(() => {
    const ro = new ResizeObserver(() => { if (wrapRef.current) setWidth(wrapRef.current.clientWidth); });
    if (wrapRef.current) { setWidth(wrapRef.current.clientWidth); ro.observe(wrapRef.current); }
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !map || map.points.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = width * dpr; cv.height = HEIGHT * dpr;
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);
    const xs = map.points.map((p) => p.x), ys = map.points.map((p) => p.y);
    const [minX, maxX] = extent(xs);
    const [minY, maxY] = extent(ys);
    const pad = 24;
    const sx = (x: number) => pad + ((x - minX) / (maxX - minX || 1)) * (width - 2 * pad);
    const sy = (y: number) => pad + (1 - (y - minY) / (maxY - minY || 1)) * (HEIGHT - 2 * pad);
    const cache: { sx: number; sy: number; pt: ResponseMapPoint }[] = [];
    for (const p of map.points) {
      if ((p.m ?? 0) < minAct) continue;
      const px = sx(p.x), py = sy(p.y);
      cache.push({ sx: px, sy: py, pt: p });
      const g = groupOf(p);
      const dim = selected !== null && g !== selected;
      const t = Math.min(1, (p.m ?? 0) / maxMag);
      const r = 1.3 + 2.4 * t;
      ctx.globalAlpha = dim ? 0.05 : 0.35 + 0.55 * t;
      ctx.fillStyle = colorOfGroup(g);
      ctx.fillRect(px - r, py - r, 2 * r, 2 * r);
    }
    screen.current = cache;
    if (hover) {
      const h = cache.find((c) => c.pt === hover.pt);
      if (h) { ctx.globalAlpha = 1; ctx.strokeStyle = "#e2e8f0"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(h.sx, h.sy, 6, 0, Math.PI * 2); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
  }, [map, width, selected, hover, mode, minAct, maxMag]);

  if (!map)
    return (
      <Card>
        <p className="text-sm text-slate-400">The response map isn't available for this dataset.</p>
      </Card>
    );

  const nearest = (e: React.MouseEvent) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let best: { sx: number; sy: number; pt: ResponseMapPoint } | null = null;
    let bd = 100;
    for (const c of screen.current) {
      const d = (c.sx - mx) ** 2 + (c.sy - my) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    return { best, mx, my };
  };
  const onMove = (e: React.MouseEvent) => { const { best, mx, my } = nearest(e); setHover(best ? { pt: best.pt, x: mx, y: my } : null); };
  const onClick = (e: React.MouseEvent) => { const { best } = nearest(e); if (best) setPicked(best.pt); };

  return (
    <div className="flex flex-col gap-4">
      <Explain>
        Each dot is a <b>single response</b> (one side of a battle), placed by UMAP of its individual
        SAE code and coloured by the feature with its strongest positive activity. <b>Click a dot</b>
        to read <i>that one response</i> and inspect that feature — there is no A/B contrast ambiguity.
      </Explain>
      <Card>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">Response scatter</h2>
          <span className="text-xs text-slate-500">
            {map.n_sampled.toLocaleString()} of {map.n_total.toLocaleString()} responses
            {" · "}<span className="text-slate-400">click a point to inspect one response</span>
          </span>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-4">
          {hasBehaviors && (
            <div className="inline-flex rounded-lg border border-edge p-0.5 text-xs">
              {(["behavior", "feature"] as Mode[]).map((m) => (
                <button key={m} onClick={() => { setMode(m); setSelected(null); }}
                  className={`rounded-md px-2.5 py-1 capitalize transition ${
                    mode === m ? "bg-accent text-white" : "text-slate-400 hover:text-slate-200"}`}>
                  color by {m}
                </button>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-slate-400">
            min activation
            <input type="range" min={0} max={maxMag} step={maxMag / 100} value={minAct}
              onChange={(e) => setMinAct(parseFloat(e.target.value))} className="w-40 accent-accent" />
            <span className="w-10 font-mono text-slate-500">{minAct.toFixed(2)}</span>
          </label>
          <span className="text-xs text-slate-600">sampling: {map.mode ?? "random"}</span>
        </div>
        <div ref={wrapRef} className="relative w-full">
          <canvas ref={canvasRef} style={{ width: "100%", height: HEIGHT, cursor: "pointer" }}
            onMouseMove={onMove} onMouseLeave={() => setHover(null)} onClick={onClick} />
          {hover && (
            <div className="pointer-events-none absolute z-10 max-w-md rounded-lg border border-edge bg-panel/95 p-2 text-xs shadow-xl"
              style={{ left: Math.min(hover.x + 12, width - 320), top: Math.max(hover.y - 8, 0) }}>
              <div className="mb-1 font-medium" style={{ color: colorOfGroup(groupOf(hover.pt)) }}>
                {conceptOf(hover.pt)}
              </div>
              <div className="text-slate-400">response {hover.pt.side} · {hover.pt.model}</div>
              {hover.pt.p && <div className="mt-1 text-slate-300">{hover.pt.p}</div>}
            </div>
          )}
        </div>
      </Card>

      {picked && (
        <Card>
          <div className="mb-2 flex items-start justify-between gap-2">
            <div>
              <div className="text-sm font-medium" style={{ color: colorOfGroup(groupOf(picked)) }}>
                {conceptOf(picked)}
              </div>
              <div className="text-xs text-slate-500">
                response <span className="text-slate-300">{picked.side}</span> · {picked.model}
                {picked.m != null && <span> · activation {picked.m.toFixed(2)}</span>}
              </div>
            </div>
            <button onClick={() => setPicked(null)} className="text-xs text-accent hover:underline">close</button>
          </div>
          <div className="mb-3 rounded-lg border border-edge bg-ink/60 p-2 text-sm text-slate-300">
            <div className="mb-1 text-xs uppercase tracking-wider text-slate-500">prompt</div>
            <div className="whitespace-pre-wrap">{picked.p || "—"}</div>
          </div>
          <div className="rounded-lg border border-good/40 bg-ink/60 p-2 text-sm">
            <div className="mb-1 text-xs uppercase tracking-wider text-slate-500">
              response {picked.side} — {picked.model}
            </div>
            <div className="max-h-96 overflow-auto whitespace-pre-wrap text-slate-300">{picked.r || "—"}</div>
          </div>
        </Card>
      )}

      <Card>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold capitalize text-slate-300">{mode} legend</h3>
          {selected !== null && (
            <button onClick={() => setSelected(null)} className="text-xs text-accent hover:underline">clear filter</button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {legend.map((it) => (
            <button key={it.id} onClick={() => setSelected(selected === it.id ? null : it.id)}
              className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition ${
                selected === it.id ? "border-accent bg-accent/10" : "border-edge hover:bg-edge/40"}`}
              title={it.label}>
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: it.color }} />
              <span className="max-w-[240px] truncate text-slate-300">{it.label}</span>
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}
