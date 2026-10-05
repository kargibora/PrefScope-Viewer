import { Activity, ArrowRight, BarChart3, Bot, ShieldCheck, Workflow } from "lucide-react";
import type { Bundle, Feature } from "../types";
import { Card, Caveat, Explain, Metric, VerifiedBadge } from "./ui";
import { fmt } from "../data";

// Prefer a controlled preference estimate when present; otherwise use the raw descriptive association.
const eff = (f: Feature) => f.delta_win_rate ?? f.win_assoc ?? 0;
const sig = (f: Feature) => f.delta_win_significant ?? f.win_significant ?? false;
const pp = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}pp`;

export default function Overview({
  bundle,
  onNavigate,
  onJumpFeature,
}: {
  bundle: Bundle;
  onNavigate?: (view: "distribution" | "behaviors" | "relationships" | "models" | "reliability") => void;
  onJumpFeature?: (cf: number) => void;
}) {
  const m = bundle.meta;
  const hasLabels = m.has_preference ?? true;
  const single = m.dataset_mode === "single";
  const files = new Set(bundle.manifest?.files ?? []);
  const legacy = bundle.manifest == null;
  const hasModelView = legacy || ["diagnosis.json", "model_compare.json", "head_to_head.json"]
    .some((name) => files.has(name));
  const hasRelationships = legacy || files.has("elicitation.json");
  // honest fit reporting: r2/is_loo are authoritative; loo_r2 alone (older bundles)
  // implies LOO. NEVER label an in-sample fit "held-out".
  const r2 = m.r2 ?? m.loo_r2;
  const isLoo = m.is_loo ?? (m.loo_r2 != null);
  const hasValidation = r2 != null && m.n_models != null;
  // describe the ACTUAL lens (individual vs difference), not a hardcoded story.
  const isDiff = m.input_rep === "difference";
  const lensKind = isDiff ? "difference" : "completion";
  const howBuilt = isDiff
    ? "we embed each answer and learn a small set of concepts that differ between the two answers"
    : single
      ? "we embed each answer and learn a set of candidate answer concepts"
      : "we embed each answer, learn candidate answer concepts, and compare answers to the same prompt";

  const significant = bundle.features.filter(sig);
  const trustworthy = significant.filter((f) => f.fidelity_pass);
  const descriptive = bundle.features.filter(
    (f) => f.fidelity_pass && (f.delta_win_rate ?? f.win_assoc) != null,
  );
  const pool = trustworthy.length ? trustworthy : significant.length ? significant : descriptive;
  const verifiedBasis = trustworthy.length > 0;
  const descriptiveOnly = significant.length === 0 && descriptive.length > 0;
  const controlledEffects = bundle.features.some((f) => f.delta_win_rate != null);
  const rewarded = [...pool].filter((f) => eff(f) > 0).sort((a, b) => eff(b) - eff(a)).slice(0, 3);
  const penalized = [...pool].filter((f) => eff(f) < 0).sort((a, b) => eff(a) - eff(b)).slice(0, 3);
  const namedDenom = m.n_named ?? bundle.features.length;
  const startCards = [
    ...((legacy || files.has("concept_distribution.json") || files.has("prompt_concept_distribution.json")) ? [{
      view: "distribution" as const,
      icon: BarChart3,
      title: "Understand the dataset",
      body: "Which requests and answer concepts are common, rare, or language-specific?",
    }] : []),
    ...(hasRelationships ? [{
      view: "relationships" as const,
      icon: Workflow,
      title: "Trace prompt → answer",
      body: hasLabels
        ? "What answers appear for each request type, and what is associated with higher preference there?"
        : "What answer concepts appear for each request type, with matched evidence?",
    }] : []),
    {
      view: "behaviors" as const,
      icon: Activity,
      title: "Inspect an answer concept",
      body: "Where does it appear, what elicits it, and how well does the label fit?",
    },
    ...(hasModelView ? [{
      view: "models" as const,
      icon: Bot,
      title: "Start with a model",
      body: "Find lowest-preference prompts, more or less positive feature activity, and matched evidence.",
    }] : []),
    {
      view: "reliability" as const,
      icon: ShieldCheck,
      title: "Check the data",
      body: "Find missing labels, repeated names, low coverage, and other warnings.",
    },
  ];

  // each driver row jumps to its feature in the Feature panel — the best entry point
  // into the app shouldn't be a dead display.
  const Row = ({ f, tone }: { f: Feature; tone: "good" | "bad" }) => (
    <li>
      <button
        onClick={onJumpFeature ? () => onJumpFeature(f.feature_id) : undefined}
        disabled={!onJumpFeature}
        className={`flex w-full items-baseline justify-between gap-2 rounded px-1 py-0.5 text-left transition-colors duration-150 ${
          onJumpFeature ? "hover:bg-edge/30" : "cursor-default"}`}
        title={onJumpFeature ? "open in Feature panel" : undefined}
      >
        <span className="min-w-0 truncate text-slate-300">
          <span className={`${tone === "good" ? "text-good" : "text-bad"} font-mono`}>{pp(eff(f))}</span>
          {" · "}{f.concept}
        </span>
        <VerifiedBadge pass={f.fidelity_pass} n={f.fidelity_n} />
      </button>
    </li>
  );

  return (
    <div className="flex flex-col gap-6">
      <section className="overflow-hidden rounded-3xl border border-edge bg-hero px-5 py-6 shadow-2xl sm:px-7 sm:py-8">
        <div className="max-w-3xl">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-[11px] font-medium text-accent-soft">
            {m.input_rep === "difference" ? "Difference-SAE analysis" : "Response concept analysis"}
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-50 sm:text-3xl">
            {single
              ? "See what this instruction dataset asks for—and what its answers contain."
              : "Find what models do, when they do it, and how reliably we know."}
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-400 sm:text-base">
            {single
              ? "See what the prompts ask for, what the answers contain, and concrete examples in each language."
              : "Start from a prompt, answer concept, or model. Then check examples and the evidence behind each result."}
          </p>
        </div>
        <div className={`mt-6 grid gap-3 ${startCards.length >= 3 ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
          {startCards.map(({ view, icon: Icon, title, body }) => (
            <button
              key={view}
              onClick={() => onNavigate?.(view)}
              disabled={!onNavigate}
              className="group rounded-2xl border border-edge/80 bg-ink/45 p-4 text-left transition hover:-translate-y-0.5 hover:border-accent/40 hover:bg-panel/80"
            >
              <div className="flex items-center justify-between">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent/10 text-accent-soft"><Icon size={17} /></span>
                <ArrowRight size={16} className="text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-accent-soft" />
              </div>
              <h3 className="mt-3 text-sm font-semibold text-slate-100">{title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">{body}</p>
            </button>
          ))}
        </div>
      </section>

      <div className={`grid grid-cols-2 gap-4 md:grid-cols-3 ${hasValidation ? "lg:grid-cols-6" : "lg:grid-cols-4"}`}>
        <Metric label="Reconstruction" value={fmt(m.ev, 3)} sub={`${lensKind} lens EV`} />
        <Metric label="Verified features" value={`${m.n_verified ?? "—"} / ${namedDenom}`} sub="of named" />
        {hasValidation && (
          <>
            <Metric label="Predicts preference score" value={r2 != null ? `${(r2 * 100).toFixed(0)}%` : "—"}
              sub={isLoo ? "R², held-out (LOO)" : "R², in-sample fit"} />
            <Metric label="Models" value={m.n_models ?? "—"} sub="in validation" />
          </>
        )}
        <Metric label={single ? "Examples" : "Battles"} value={(m.n_battles ?? 0).toLocaleString()} />
        <Metric label="M / K" value={`${m.m_total} / ${m.k}`} sub={`dim ${m.input_dim}`} />
      </div>

      <Explain>
        <b>How this works.</b> {howBuilt}. <b>Reconstruction</b> shows how much information the
        learned features keep. <b>Verified features</b> are names that an LLM checker reproduced on
        held-out examples (of the {namedDenom} named).{hasValidation && (
          <> <b>Predicts preference score</b> shows how well those concepts predict each model’s observed preference score
          {isLoo
            ? ", with every model held out of its own prediction — higher means the diagnosis genuinely generalises."
            : " — an in-sample fit (no held-out predictions in this bundle), so treat it optimistically."}</>
        )}
      </Explain>

      <Card>
        <h2 className="mb-2 text-lg font-semibold">What this lens found</h2>
        <p className="text-sm leading-relaxed text-slate-300">
          A {lensKind} SAE over <span className="text-slate-100">{m.embed_model_id ?? "the embedding model"}</span>{" "}
          response embeddings, applied here to {(m.n_battles ?? 0).toLocaleString()} {single ? "instruction–response examples" : "paired response comparisons"}. It found{" "}
          <span className="text-slate-100">{m.n_verified ?? "—"}</span> response-concept labels that passed
          an LLM verification step on held-out examples.
          {r2 != null && m.n_models != null && (
            <> A predictor built only from those features (weighted by their preference association)
              explains <span className="text-good">{(r2 * 100).toFixed(0)}%</span> of the variance
              in observed preference score across {m.n_models} models
              {isLoo ? " — held out leave-one-model-out." : " — fit in-sample (not held out)."}</>
          )}
        </p>
        {hasLabels && (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-good">Associated with higher judge-preference probability</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {rewarded.length === 0 && <li className="text-slate-500">—</li>}
                {rewarded.map((f) => <Row key={f.feature_id} f={f} tone="good" />)}
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-bad">Associated with lower judge-preference probability</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {penalized.length === 0 && <li className="text-slate-500">—</li>}
                {penalized.map((f) => <Row key={f.feature_id} f={f} tone="bad" />)}
              </ul>
            </div>
          </div>
        )}
        <Caveat>
          {hasLabels ? (
            controlledEffects
              ? <>Values are the <b>length-controlled</b> Δ preference score in percentage points.{" "}</>
              : <>Values are the raw difference in mean preference probability between positive and negative feature contrasts.{" "}</>
          ) : (
            <>This dataset has <b>no preference labels</b>, so there's no preference analysis — the
            viewer shows concept structure only (what concepts exist and how prompts and responses
            relate).{" "}</>
          )}
          Concept names are written by an LLM; “Label checked” marks names that an LLM checker reproduced on
          held-out {single ? "examples" : "pairs"}. {hasLabels && (descriptiveOnly
            ? "No inferential test is claimed here; showing the strongest checked descriptive associations. "
            : verifiedBasis
              ? "Showing checked, statistically clear concepts only. "
              : "No checked concepts yet — treat these names as suggestions. ")}
          Association, not causation.
        </Caveat>
      </Card>
    </div>
  );
}
