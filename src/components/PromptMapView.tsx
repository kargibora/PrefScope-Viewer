import { useEffect, useMemo, useRef, useState } from "react";
import type { PromptMapData, PromptMapPoint } from "../types";
import { Card, Explain } from "./ui";
import { extent } from "./VirtualList";

// duplicated from MapView for now (standalone by design — factor a shared
// ScatterCanvas later).
const PALETTE = [
  "#60a5fa", "#f87171", "#34d399", "#fbbf24", "#a78bfa", "#fb923c",
  "#22d3ee", "#f472b6", "#a3e635", "#e879f9", "#2dd4bf", "#facc15",
  "#818cf8", "#fca5a5", "#4ade80", "#fdba74", "#38bdf8", "#c084fc",
  "#fde047", "#5eead4", "#f9a8d4", "#bef264", "#93c5fd", "#fcd34d",
];
const GREY = "#475569";
const HEIGHT = 560;

type Mode = "behavior" | "feature";

export default function PromptMapView(
  { map, onJump, hasLabels = true }: { map: PromptMapData | null; onJump?: (pc: number, cf: number) => void; hasLabels?: boolean }
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<{ pt: PromptMapPoint; x: number; y: number } | null>(null);
  const [picked, setPicked] = useState<PromptMapPoint | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const hasBehaviors = !!map?.behaviors;
  const [mode, setMode] = useState<Mode>(hasBehaviors ? "behavior" : "feature");
  const [minAct, setMinAct] = useState(0);
  const screen = useRef<{ sx: number; sy: number; pt: PromptMapPoint }[]>([]);

  const maxMag = useMemo(
    () => Math.max(1e-6, ...(map?.points.map((p) => p.m ?? 0) ?? [1])),
    [map]
  );
  const featIdx = useMemo(() => {
    const m = new Map<number, number>();
    map?.features.forEach((fid, i) => m.set(fid, i));
    return m;
  }, [map]);

  const groupOf = (p: PromptMapPoint): number => (mode === "behavior" ? p.pc : p.f);
  const colorOfGroup = (g: number): string => {
    if (g < 0) return GREY;
    if (mode === "behavior") return PALETTE[g % PALETTE.length];
    return PALETTE[(featIdx.get(g) ?? 0) % PALETTE.length];
  };

  const legend = useMemo(() => {
    if (!map) return [] as { id: number; label: string; color: string }[];
    if (mode === "behavior" && map.behaviors) {
      const seen = new Set<number>();
      const items: { id: number; label: string; color: string }[] = [];
      for (const p of map.points) {
        if (p.pc < 0 || seen.has(p.pc)) continue;
        seen.add(p.pc);
        items.push({ id: p.pc, label: map.behaviors[String(p.pc)] ?? `behavior ${p.pc}`,
                     color: PALETTE[p.pc % PALETTE.length] });
      }
      return items.sort((a, b) => a.id - b.id);
    }
    return map.features.map((fid, i) => ({ id: fid, label: map.concepts[i], color: PALETTE[i % PALETTE.length] }));
  }, [map, mode]);

  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (wrapRef.current) setWidth(wrapRef.current.clientWidth);
    });
    if (wrapRef.current) {
      setWidth(wrapRef.current.clientWidth);
      ro.observe(wrapRef.current);
    }
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !map || map.points.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = width * dpr;
    cv.height = HEIGHT * dpr;
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);

    const xs = map.points.map((p) => p.x);
    const ys = map.points.map((p) => p.y);
    const [minX, maxX] = extent(xs);
    const [minY, maxY] = extent(ys);
    const pad = 24;
    const sx = (x: number) => pad + ((x - minX) / (maxX - minX || 1)) * (width - 2 * pad);
    const sy = (y: number) => pad + (1 - (y - minY) / (maxY - minY || 1)) * (HEIGHT - 2 * pad);

    const cache: { sx: number; sy: number; pt: PromptMapPoint }[] = [];
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
      if (h) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#e2e8f0";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(h.sx, h.sy, 6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }, [map, width, selected, hover, mode, minAct, maxMag]);

  if (!map)
    return (
      <Card>
        <p className="text-sm text-slate-400">The prompt map isn't available for this dataset.</p>
      </Card>
    );

  const nearest = (e: React.MouseEvent) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let best: { sx: number; sy: number; pt: PromptMapPoint } | null = null;
    let bd = 100;
    for (const c of screen.current) {
      const d = (c.sx - mx) ** 2 + (c.sy - my) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    return { best, mx, my };
  };
  const onMove = (e: React.MouseEvent) => {
    const { best, mx, my } = nearest(e);
    setHover(best ? { pt: best.pt, x: mx, y: my } : null);
  };
  const onClick = (e: React.MouseEvent) => {
    const { best } = nearest(e);
    if (best) setPicked(best.pt);
  };

  const hoverLabel = (p: PromptMapPoint): string => {
    if (mode === "behavior" && p.pc < 0) return "no verified prompt behavior fired";
    if (p.f < 0) return "no verified prompt feature fired";
    return mode === "behavior"
      ? map.behaviors?.[String(p.pc)] ?? `behavior ${p.pc}`
      : map.concepts[featIdx.get(p.f) ?? -1] ?? `feature ${p.f}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <Explain>
        Each dot is one battle, placed by UMAP of its <b>prompt</b> latents — prompts that ask for
        similar things sit together. <b>Colour</b> = the dominant prompt behaviour. <b>Click a dot</b>
        {" "}to read the prompt and see which prompt features fire{hasLabels ? (
          <> and which features the <i>winning</i> response expresses — <span className="text-good">★
          marks the ones that are statistically significant in the Δ relation</span>, so you can
          verify a concept on a real example.</>
        ) : (
          <> and how the two responses differ in feature space (this dataset has no preference
          labels, so there is no winner).</>
        )}
      </Explain>
      <Card>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">Prompt map (UMAP of prompt-lens codes)</h2>
          <span className="text-xs text-slate-500">
            {map.n_sampled.toLocaleString()} of {map.n_total.toLocaleString()} prompts
            {" · "}<span className="text-slate-400">click a point to inspect</span>
          </span>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-4">
          {hasBehaviors && (
            <div className="inline-flex rounded-lg border border-edge p-0.5 text-xs">
              {(["behavior", "feature"] as Mode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => { setMode(m); setSelected(null); }}
                  className={`rounded-md px-2.5 py-1 capitalize transition ${
                    mode === m ? "bg-accent text-white" : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  color by {m}
                </button>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-slate-400">
            min activation
            <input
              type="range" min={0} max={maxMag} step={maxMag / 100} value={minAct}
              onChange={(e) => setMinAct(parseFloat(e.target.value))}
              className="w-40 accent-accent"
            />
            <span className="w-10 font-mono text-slate-500">{minAct.toFixed(2)}</span>
          </label>
          <span className="text-xs text-slate-600">sampling: {map.mode ?? "random"}</span>
        </div>
        <div ref={wrapRef} className="relative w-full">
          <canvas
            ref={canvasRef}
            style={{ width: "100%", height: HEIGHT, cursor: "pointer" }}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            onClick={onClick}
          />
          {hover && (
            <div
              className="pointer-events-none absolute z-10 max-w-md rounded-lg border border-edge bg-panel/95 p-2 text-xs shadow-xl"
              style={{ left: Math.min(hover.x + 12, width - 320), top: Math.max(hover.y - 8, 0) }}
            >
              <div className="mb-1 font-medium" style={{ color: colorOfGroup(groupOf(hover.pt)) }}>
                {hoverLabel(hover.pt)}
              </div>
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
                {hoverLabel(picked)}
              </div>
              <div className="text-xs text-slate-500">
                {picked.ma} <span className="text-slate-600">vs</span> {picked.mb}
                {hasLabels && (
                  <>
                    {" · "}
                    <span className="text-good">winner: {picked.win === "A" ? picked.ma : picked.mb}</span>
                  </>
                )}
              </div>
            </div>
            <button onClick={() => setPicked(null)} className="text-xs text-accent hover:underline">
              close
            </button>
          </div>
          <div className="mb-3 rounded-lg border border-edge bg-ink/60 p-2 text-sm text-slate-300">
            <div className="mb-1 text-xs uppercase tracking-wider text-slate-500">prompt</div>
            <div className="whitespace-pre-wrap">{picked.p || "—"}</div>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-edge bg-ink/60 p-2 text-sm">
              <div className="mb-1 text-xs uppercase tracking-wider text-slate-500">
                prompt features firing
              </div>
              {picked.pf.length === 0 && <div className="text-slate-500">—</div>}
              {picked.pf.map((f) => (
                <div key={f.id} className="flex items-baseline justify-between gap-2 py-0.5">
                  <span className="text-slate-300">{f.concept}</span>
                  <span className="font-mono text-xs text-slate-500">{f.z.toFixed(2)}</span>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-edge bg-ink/60 p-2 text-sm">
              <div className="mb-1 text-xs uppercase tracking-wider text-slate-500">
                {hasLabels ? "completion features (winner vs loser)" : "completion features (A vs B contrast)"}
              </div>
              {picked.cf.length === 0 && <div className="text-slate-500">—</div>}
              {picked.cf.map((f) => {
                const jumpable = f.sig && !!onJump;
                const Row: React.ElementType = jumpable ? "button" : "div";
                const tone = f.z >= 0 ? "text-good" : "text-bad"; // + winner / − loser shows more
                return (
                  <Row
                    key={f.id}
                    {...(jumpable ? { onClick: () => onJump!(picked.pc, f.id),
                                      title: "show this cell in the Δ relation" } : {})}
                    className={`flex w-full items-baseline justify-between gap-2 py-0.5 text-left ${
                      jumpable ? "rounded hover:bg-edge/40" : ""
                    }`}
                  >
                    <span className={`${tone} ${f.sig ? "font-semibold" : "opacity-80"}`}>
                      {f.sig ? "★ " : ""}{f.concept}
                    </span>
                    <span className="font-mono text-xs text-slate-500">
                      {f.z >= 0 ? "+" : ""}{f.z.toFixed(2)}
                      {f.delta != null && <span className={tone}> · Δ{f.delta >= 0 ? "+" : ""}{f.delta.toFixed(2)}</span>}
                    </span>
                  </Row>
                );
              })}
              <div className="mt-1 text-[10px] text-slate-600">
                {hasLabels ? (
                  <>
                    <span className="text-good">+ winner</span> / <span className="text-bad">− loser</span>{" "}
                    shows it more · ★ = significant (click to jump)
                  </>
                ) : (
                  <>+ = A shows it more / − = B shows it more</>
                )}
              </div>
            </div>
          </div>

          {/* response texts — so you can check the feature Δ against the actual A/B answers */}
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            {([["A", picked.ma, picked.ca], ["B", picked.mb, picked.cb]] as const).map(
              ([slot, model, text]) => (
                <div
                  key={slot}
                  className={`rounded-lg border bg-ink/60 p-2 text-sm ${
                    hasLabels && picked.win === slot ? "border-good/60" : "border-edge"
                  }`}
                >
                  <div className="mb-1 text-xs uppercase tracking-wider text-slate-500">
                    {slot} — {model}
                    {hasLabels && picked.win === slot && <span className="text-good"> · winner</span>}
                  </div>
                  <div className="max-h-80 overflow-auto whitespace-pre-wrap text-slate-300">
                    {text || "(no response text)"}
                  </div>
                </div>
              )
            )}
          </div>
        </Card>
      )}

      <Card>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold capitalize text-slate-300">{mode} legend</h3>
          {selected !== null && (
            <button onClick={() => setSelected(null)} className="text-xs text-accent hover:underline">
              clear filter
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {legend.map((it) => (
            <button
              key={it.id}
              onClick={() => setSelected(selected === it.id ? null : it.id)}
              className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition ${
                selected === it.id ? "border-accent bg-accent/10" : "border-edge hover:bg-edge/40"
              }`}
              title={it.label}
            >
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: it.color }} />
              <span className="max-w-[240px] truncate text-slate-300">{it.label}</span>
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}
