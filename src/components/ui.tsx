import React from "react";
import { CircleDashed, Info, ShieldAlert, ShieldCheck } from "lucide-react";

// plain-language "how to read this" callout
export function Explain({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-xl border border-accent/30 bg-accent/5 p-3 text-sm leading-relaxed text-slate-300">
      <Info size={16} className="mt-0.5 shrink-0 text-accent" />
      <div>{children}</div>
    </div>
  );
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 rounded-2xl border border-edge bg-panel/70 p-4 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

export function Metric({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <Card className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wider text-slate-400">{label}</span>
      <span className="text-2xl font-semibold tabular-nums text-slate-100">{value}</span>
      {sub && <span className="text-xs text-slate-500">{sub}</span>}
    </Card>
  );
}

export function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        ok ? "bg-good/15 text-good" : "bg-slate-600/20 text-slate-400"
      }`}
    >
      {children}
    </span>
  );
}

// red (negative) → slate (zero) → green (positive), magnitude-scaled.
// `ref` is the saturation reference: pass a FIXED value (not the dataset max) so a
// ±0.03 effect renders pale, not full-saturation — tiny effects must look tiny.
export function divergeColor(v: number, ref: number): string {
  const t = Math.max(-1, Math.min(1, ref ? v / ref : 0));
  if (t >= 0) {
    const a = 0.18 + 0.82 * t;
    return `rgba(52, 211, 153, ${a.toFixed(2)})`;
  }
  const a = 0.18 + 0.82 * -t;
  return `rgba(248, 113, 113, ${a.toFixed(2)})`;
}

// fixed saturation reference for win-rate effects: a Δwin-rate of ±0.20 is "strong".
export const WINRATE_REF = 0.2;

// Frequency (fire-rate) is NOT good/bad, so it gets its own NEUTRAL diverging pair —
// blue (more) ↔ slate (less) — kept distinct from the green/red valence palette so the
// two never collide on one page. Amber is deliberately NOT used here: it's reserved for
// caution states (failed verification, confound flags), and "does this less" is not a
// warning. A ±0.25 fire-rate difference saturates.
export const FIRE_REF = 0.25;
export function fireDivergeColor(v: number, ref: number = FIRE_REF): string {
  const t = Math.max(-1, Math.min(1, ref ? v / ref : 0));
  const a = 0.18 + 0.82 * Math.abs(t);
  return t >= 0 ? `rgba(96, 165, 250, ${a.toFixed(2)})` : `rgba(148, 163, 184, ${a.toFixed(2)})`;
}

// unnamed features carry a null concept (only the top-N are annotated). Render their
// id as a de-emphasized placeholder rather than a bare number. Also treat the legacy
// string "nan"/"NaN"/"" as unnamed, so bundles exported before the null fix still work.
export const isUnnamed = (name: string | null | undefined) =>
  name == null || name === "nan" || name === "NaN" || name.trim() === "";
export const conceptLabel = (id: number, name: string | null | undefined) =>
  isUnnamed(name) ? `feature ${id}` : (name as string);

// Truncated concept label that reveals its FULL text on hover OR keyboard-focus OR tap
// (focusable), via a pure-CSS popover — the consistent full-text affordance across the
// app's HTML labels (recharts axis labels use two-line wrap instead). Unnamed concepts
// render de-emphasized and teach how to fix them.
export function ConceptLabel({
  id,
  name,
  className = "",
  wrap = false,
}: {
  id: number;
  name: string | null | undefined;
  className?: string;
  // `wrap`: render the FULL text, wrapping over multiple lines, with no truncation
  // and no hover popover. Use in drill-in / detail views where there is room and the
  // user explicitly wants to read the whole concept (the truncate+popover form is for
  // dense tables where space is tight).
  wrap?: boolean;
}) {
  const unnamed = isUnnamed(name);
  const text = conceptLabel(id, name);
  const full = unnamed ? `feature ${id} — unnamed` : (name as string);
  if (wrap)
    return (
      <span className={`break-words ${unnamed ? "italic text-slate-500" : ""} ${className}`}>
        {text}
      </span>
    );
  return (
    <span
      tabIndex={0}
      className={`group relative inline-block max-w-full truncate align-bottom outline-none ${
        unnamed ? "italic text-slate-500" : ""
      } ${className}`}
    >
      {text}
      <span className="pointer-events-none absolute left-0 top-full z-50 mt-1 hidden w-max max-w-md whitespace-normal rounded-lg border border-edge bg-ink px-2 py-1 text-xs font-normal not-italic text-slate-200 shadow-lg group-hover:block group-focus:block">
        {full}
      </span>
    </span>
  );
}

// Small label-check badge. Keep the wording plain because this appears throughout the app.
// `n` (held-out examples) shown when present so n=14 doesn't masquerade as n=200.
// Three states, not two: a label that FAILED its held-out check is materially worse
// than one that was never tested — don't let both read "unverified".
export function VerifiedBadge({ pass, n }: { pass?: boolean | null; n?: number | null }) {
  if (pass === undefined || pass === null)
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-slate-700/50 bg-slate-800/25 px-2 py-1 text-[10px] font-medium text-slate-500"
        title="this name has not been checked on held-out examples">
        <CircleDashed size={11} />Not checked
      </span>
    );
  const Icon = pass ? ShieldCheck : ShieldAlert;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium ${
        pass ? "border-good/20 bg-good/[0.07] text-good" : "border-amber-500/20 bg-amber-500/[0.07] text-amber-300"
      }`}
      title={pass ? "an LLM checker reproduced this name on held-out examples" : "an LLM checker could not reliably reproduce this name on held-out examples"}
    >
      <Icon size={11} />{pass ? "Label checked" : "Label uncertain"}
      {n != null && <span className="ml-0.5 opacity-70">n={n}</span>}
    </span>
  );
}

// muted "this is an LLM-assigned label, association not causation" footnote
export function Caveat({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 max-w-prose text-xs leading-snug text-slate-400/90">{children}</p>;
}

// clip long text to n chars with an ellipsis (shared across the browse hubs)
export const clip = (s: string, n = 200) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// One horizontal concept bar-row: a (wrapping) concept label, a fixed-width magnitude bar,
// and a right-aligned value. Clickable when `onClick` is given (renders a button). The
// single shared row for both hubs' Elicits / Activated-by / Reward / Wins-here lists.
export function ConceptBarRow({
  id, name, value, detail, title, width, color, onClick, dim, selected,
}: {
  id: number;
  name: string | null | undefined;
  value: string;
  detail?: string;
  title?: string;
  width: number; // 0..1 of the bar track
  color: string;
  onClick?: () => void;
  dim?: boolean; // e.g. non-significant rows
  selected?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      aria-pressed={onClick ? selected : undefined}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors duration-150 ${
        onClick ? "hover:bg-edge/30" : "cursor-default"
      } ${selected ? "bg-accent/10 ring-1 ring-inset ring-accent/40" : ""} ${dim ? "opacity-70" : ""}`}
    >
      <span className="min-w-0 flex-1">
        <ConceptLabel id={id} name={name} wrap className="text-slate-300" />
        {detail && <span className="mt-0.5 block text-[10px] tabular-nums text-slate-600">{detail}</span>}
      </span>
      <span className="hidden h-2 w-28 shrink-0 overflow-hidden rounded-full bg-edge/40 sm:block">
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.round(Math.max(0, Math.min(1, width)) * 100)}%`, background: color }}
        />
      </span>
      <span className="w-16 shrink-0 text-right tabular-nums text-slate-300" title={title}>
        {value}
      </span>
    </button>
  );
}

// pulsing placeholder while lazy data streams in — used instead of "Loading…" strings.
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-edge/40 ${className}`} />;
}

// N stacked card-shaped skeletons (the shape examples/battle lists load into).
export function SkeletonList({ n = 3, itemClass = "h-24" }: { n?: number; itemClass?: string }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} className={itemClass} />
      ))}
    </div>
  );
}

// THE segmented control — one shell, one active state, two sizes. Replaces the five
// hand-rolled pill-group recipes that had drifted across tabs.
export function Segmented<T extends string>({
  options, value, onChange, size = "sm",
}: {
  options: readonly { value: T; label: string; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "xs";
}) {
  const pad = size === "sm" ? "px-2.5 py-1 text-xs" : "px-1.5 py-0.5 text-[11px]";
  return (
    <div role="group" className="inline-flex w-fit rounded-lg border border-edge bg-ink/40 p-0.5">
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          title={o.title}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md transition-colors duration-150 ${pad} ${
            value === o.value ? "bg-accent text-white shadow-sm" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
