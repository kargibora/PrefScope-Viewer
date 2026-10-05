import { Bot, ChevronLeft, ChevronRight, MessageSquareText } from "lucide-react";
import type { ReactNode } from "react";

const finite = (value: number | null | undefined): value is number =>
  value != null && Number.isFinite(value);

export function activationDomain(
  values: number[],
  maxHint?: number | null,
): { min: number; max: number } {
  const valid = values.filter(Number.isFinite);
  const observedMin = valid.length ? Math.min(...valid) : 0;
  const observedMax = valid.length ? Math.max(...valid) : 0;
  const min = Math.min(0, observedMin);
  const max = Math.max(0, observedMax, finite(maxHint) ? maxHint : 0);
  return min === max ? { min: 0, max: max || 1 } : { min, max };
}

const format = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
const topShare = (percentile: number) => {
  const share = Math.max(0, 100 - percentile);
  if (share < 0.1) return "top <0.1%";
  if (share < 1) return `top ${share.toFixed(1)}%`;
  return `top ${share.toFixed(0)}%`;
};

export function ActivationMeter({
  value,
  min,
  max,
  label = "Activation",
  compact = false,
  percentile,
  threshold,
}: {
  value: number;
  min: number;
  max: number;
  label?: string;
  compact?: boolean;
  percentile?: number;
  threshold?: number | null;
}) {
  const lo = Math.min(min, value, 0);
  const hi = Math.max(max, value, 0);
  const span = Math.max(hi - lo, 1e-12);
  const position = (point: number) => Math.max(0, Math.min(100, ((point - lo) / span) * 100));
  const zero = position(0);
  const active = position(value);
  const left = Math.min(zero, active);
  const width = Math.max(1.5, Math.abs(active - zero));
  const positive = value >= 0;
  const thresholdPosition = finite(threshold) && threshold >= lo && threshold <= hi
    ? position(threshold)
    : null;

  return (
    <div
      className="min-w-0"
      role="img"
      aria-label={`${label} ${format(value)}${finite(percentile) ? `, stronger than ${percentile.toFixed(1)} percent of active examples` : ""}. Shown range ${lo.toFixed(3)} to ${hi.toFixed(3)}`}
    >
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</span>
        <span className="font-mono text-[11px] font-medium text-slate-200">
          {format(value)}{finite(percentile) && <span className="ml-2 text-accent-soft">{topShare(percentile)}</span>}
        </span>
      </div>
      <div className={`${compact ? "h-1.5" : "h-2"} relative overflow-hidden rounded-full bg-edge/55`}>
        {lo < 0 && hi > 0 && (
          <span className="absolute inset-y-0 w-px bg-slate-400/60" style={{ left: `${zero}%` }} />
        )}
        <span
          className={`absolute inset-y-0 rounded-full ${positive
            ? "bg-gradient-to-r from-accent/55 to-accent"
            : "bg-gradient-to-l from-amber-400/55 to-amber-400"}`}
          style={{ left: `${left}%`, width: `${width}%` }}
        />
        {thresholdPosition != null && (
          <span className="absolute inset-y-[-2px] w-px bg-amber-300/90"
            style={{ left: `${thresholdPosition}%` }} title={`label cutoff ${threshold?.toFixed(3)}`} />
        )}
        <span
          className={`absolute top-1/2 h-2.5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full ${positive ? "bg-accent-soft" : "bg-amber-300"}`}
          style={{ left: `${active}%` }}
        />
      </div>
      {!compact && (
        <div className="mt-1 flex justify-between font-mono text-[9px] text-slate-600">
          <span>min {lo.toFixed(3)}</span>
          {thresholdPosition != null && <span className="text-amber-300/70">label cutoff {threshold?.toFixed(3)}</span>}
          <span>max {hi.toFixed(3)}</span>
        </div>
      )}
    </div>
  );
}

export function EvidenceText({
  kind,
  children,
  preview = false,
}: {
  kind: "prompt" | "response";
  children: ReactNode;
  preview?: boolean;
}) {
  const prompt = kind === "prompt";
  const Icon = prompt ? MessageSquareText : Bot;
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${prompt
      ? "border-sky-400/15 bg-sky-400/[0.045]"
      : "border-emerald-400/15 bg-emerald-400/[0.04]"}`}>
      <div className={`mb-1 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.16em] ${prompt
        ? "text-sky-300/70"
        : "text-emerald-300/70"}`}>
        <Icon size={11} />{prompt ? "Prompt" : "Response"}
      </div>
      <div className={`${preview ? "line-clamp-3" : "max-h-80 overflow-auto whitespace-pre-wrap"} text-sm leading-relaxed text-slate-300`}>
        {children || "—"}
      </div>
    </div>
  );
}

export function ActivationEvidenceCard({
  prompt,
  response,
  value,
  min,
  max,
  label,
  model,
  percentile,
  threshold,
  selectionKind,
}: {
  prompt: string;
  response?: string;
  value: number;
  min: number;
  max: number;
  label?: string;
  model?: string;
  percentile?: number;
  threshold?: number | null;
  selectionKind?: string;
}) {
  return (
    <details className="group rounded-xl border border-edge/70 bg-ink/40 p-3 open:border-accent/20">
      <summary className="cursor-pointer list-none">
        <ActivationMeter value={value} min={min} max={max} label={label}
          percentile={percentile} threshold={threshold} />
        <div className="mt-3 space-y-2 group-open:hidden">
          <EvidenceText kind="prompt" preview>{prompt}</EvidenceText>
          {response !== undefined && <EvidenceText kind="response" preview>{response}</EvidenceText>}
        </div>
        <span className="mt-2 block text-[10px] text-slate-600 group-open:hidden">
          Open full {response === undefined ? "prompt" : "prompt and response"}
        </span>
      </summary>
      <div className="mt-3 space-y-2 border-t border-edge/60 pt-3">
        {(model || selectionKind) && <div className="flex flex-wrap gap-x-3 text-[10px] font-medium uppercase tracking-wider text-slate-500">
          {model && <span>Model · {model}</span>}
          {selectionKind && <span>Sample · {selectionKind.replace(/_/g, " ")}</span>}
        </div>}
        <EvidenceText kind="prompt">{prompt}</EvidenceText>
        {response !== undefined && <EvidenceText kind="response">{response}</EvidenceText>}
      </div>
    </details>
  );
}

export type EvidenceMode = "strongest" | "random" | "boundary";

export function evidenceMode(selectionKind?: string): EvidenceMode {
  if (selectionKind?.startsWith("random")) return "random";
  if (selectionKind?.startsWith("near_")) return "boundary";
  return "strongest";
}

export function evidenceModes(rows: { selection_kind?: string }[]): EvidenceMode[] {
  const present = new Set(rows.map((row) => evidenceMode(row.selection_kind)));
  return (["strongest", "random", "boundary"] as EvidenceMode[]).filter((mode) => present.has(mode));
}

export function EvidenceModeSelect({
  modes,
  value,
  onChange,
}: {
  modes: EvidenceMode[];
  value: EvidenceMode;
  onChange: (value: EvidenceMode) => void;
}) {
  if (modes.length < 2) return null;
  const labels: Record<EvidenceMode, string> = {
    strongest: "Strongest",
    random: "Typical active",
    boundary: "Near cutoff",
  };
  return (
    <label className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
      Sample
      <select value={value} onChange={(event) => onChange(event.target.value as EvidenceMode)}
        aria-label="Evidence sample"
        className="rounded-lg border border-edge bg-ink px-2 py-1 text-xs font-normal normal-case tracking-normal text-slate-300 outline-none focus:border-accent/60">
        {modes.map((mode) => <option key={mode} value={mode}>{labels[mode]}</option>)}
      </select>
    </label>
  );
}

export function EvidencePager({
  index,
  count,
  onChange,
  label = "Example",
}: {
  index: number;
  count: number;
  onChange: (index: number) => void;
  label?: string;
}) {
  if (count < 1) return null;
  const move = (step: number) => onChange((index + step + count) % count);
  return (
    <div className="flex items-center gap-1.5" aria-label={`${label} navigation`}>
      <button type="button" onClick={() => move(-1)} disabled={count < 2}
        className="icon-button grid h-8 w-8 disabled:cursor-default disabled:opacity-30"
        aria-label={`Previous ${label.toLowerCase()}`}>
        <ChevronLeft size={15} />
      </button>
      <span className="min-w-[64px] text-center text-xs tabular-nums text-slate-400" aria-live="polite">
        {index + 1} of {count}
      </span>
      <button type="button" onClick={() => move(1)} disabled={count < 2}
        className="icon-button grid h-8 w-8 disabled:cursor-default disabled:opacity-30"
        aria-label={`Next ${label.toLowerCase()}`}>
        <ChevronRight size={15} />
      </button>
    </div>
  );
}

export function ExampleGroupSelect({
  groups,
  value,
  onChange,
  column = "language",
}: {
  groups: string[];
  value: string;
  onChange: (value: string) => void;
  column?: string;
}) {
  if (groups.length < 2) return null;
  return (
    <label className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
      {column}
      <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={column}
        className="rounded-lg border border-edge bg-ink px-2 py-1 text-xs font-normal normal-case tracking-normal text-slate-300 outline-none focus:border-accent/60">
        <option value="">All</option>
        {groups.map((group) => <option key={group} value={group}>{group}</option>)}
      </select>
    </label>
  );
}
