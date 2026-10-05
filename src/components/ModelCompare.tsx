import { useMemo, useState } from "react";
import type { ModelCompare as MC, MCContrastRow, MCPowerRow } from "../types";
import { Card, Explain, Caveat, ConceptBarRow, Segmented, divergeColor } from "./ui";

// short display name for a fully-qualified model id (OpenRouter/qwen/qwen3.5-9b → qwen3.5-9b)
const short = (m: string) => m.split("/").slice(-1)[0];

// A deliberately-thin comparison surface for BRING-YOUR-OWN datasets (e.g. a JudgeArena
// run) that don't have a bank / enough battles for the full report card. It shows MARGINAL
// per-concept fire rates + head-to-head contrast — NOT prompt-conditioned. The dataset
// segmented control is the dataset switcher; disconnected battle graphs are separate tabs.
export default function ModelCompare({ data }: { data: MC | null }) {
  const [dsIdx, setDsIdx] = useState(0);
  const [a, setA] = useState<string | null>(null);
  const [b, setB] = useState<string | null>(null);

  const ds = data?.datasets[Math.min(dsIdx, (data?.datasets.length ?? 1) - 1)] ?? null;
  const cname = useMemo(() => {
    const m = new Map<number, string>();
    data?.concepts.forEach((c) => m.set(c.f, c.concept));
    return m;
  }, [data]);

  const models = ds?.models ?? [];
  const effA = a && models.some((m) => m.name === a) ? a : models[0]?.name ?? null;
  const effOpp = useMemo(() => {
    if (!ds || !effA) return [] as string[];
    const opp = new Set<string>();
    ds.pairs.forEach((p) => {
      if (p.a === effA) opp.add(p.b);
      if (p.b === effA) opp.add(p.a);
    });
    return [...opp].sort();
  }, [ds, effA]);
  const realB = b && effOpp.includes(b) ? b : effOpp[0] ?? null;

  if (!data || !ds)
    return (
      <Card>
        <p className="text-sm text-slate-400">
          No <code className="text-slate-200">model_compare.json</code> in this bundle. Generate it
          with{" "}
          <code className="text-slate-200">python scripts/export_model_compare.py …</code>.
        </p>
      </Card>
    );

  const pair = effA && realB ? ds.pairs.find(
    (p) => (p.a === effA && p.b === realB) || (p.a === realB && p.b === effA)) : null;
  const key = effA && realB ? [effA, realB].sort().join("|") : "";
  const storedA = key.split("|")[0];
  const flip = storedA === effA ? 1 : -1;
  const rows = (ds.pair_contrast[key] ?? []).map((r: MCContrastRow) => ({
    f: r.f,
    c: (r.contrast ?? 0) * flip,
    fa: (flip === 1 ? r.fa : r.fb) ?? 0,
    fb: (flip === 1 ? r.fb : r.fa) ?? 0,
  }));
  const maxAbs = Math.max(1e-9, ...rows.map((r) => Math.abs(r.c)));
  const aMore = [...rows].filter((r) => r.c > 0).sort((x, y) => y.c - x.c).slice(0, 12);
  const bMore = [...rows].filter((r) => r.c < 0).sort((x, y) => x.c - y.c).slice(0, 12);

  const powerRows = (m: string | null): MCPowerRow[] =>
    (m ? ds.model_power[m] ?? [] : []).filter((r) => (r.fire ?? 0) > 0)
      .sort((x, y) => (y.fire ?? 0) - (x.fire ?? 0)).slice(0, 12);

  return (
    <div className="flex flex-col gap-4">
      <Explain>
        A <b>bring-your-own smoke comparison</b> for datasets without a full report card (no
        bank / too few battles). <b>Contrast</b> = how much more one model expresses a concept
        than the other over their head-to-head battles; <b>individual powers</b> = each model's
        fire rate across all its answers. This is a <b>marginal</b> view — <i>not</i>
        prompt-conditioned. Only battled pairs compare (B lists just the models that fought A);
        disconnected datasets are separate tabs.
      </Explain>

      {data.datasets.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-slate-500">Dataset</span>
          <Segmented
            options={data.datasets.map((d, i) => ({
              value: String(i), label: `${d.source} · ${d.n_battles}`,
            }))}
            value={String(Math.min(dsIdx, data.datasets.length - 1))}
            onChange={(v) => { setDsIdx(Number(v)); setA(null); setB(null); }}
          />
        </div>
      )}

      <Card className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Model A
          <select value={effA ?? ""} onChange={(e) => { setA(e.target.value); setB(null); }}
            className="rounded-lg border border-edge bg-ink/60 px-2 py-1.5 text-sm text-slate-200">
            {models.map((m) => (
              <option key={m.name} value={m.name}>{short(m.name)} · {m.n} battles</option>
            ))}
          </select>
        </label>
        <span className="pb-2 text-slate-500">vs</span>
        <label className="flex flex-col gap-1 text-xs text-slate-400">
          Model B <span className="text-slate-600">(fought A)</span>
          <select value={realB ?? ""} onChange={(e) => setB(e.target.value)} disabled={effOpp.length === 0}
            className="rounded-lg border border-edge bg-ink/60 px-2 py-1.5 text-sm text-slate-200 disabled:opacity-50">
            {effOpp.length === 0 && <option value="">— no opponents —</option>}
            {effOpp.map((m) => <option key={m} value={m}>{short(m)}</option>)}
          </select>
        </label>
        {pair && (
          <span className="pb-2 text-xs text-slate-400">{pair.n} battles · {pair.n_decisive} decisive</span>
        )}
      </Card>

      {!realB ? (
        <Card><p className="text-sm text-slate-400">{short(effA ?? "")} has no head-to-head opponent in this dataset.</p></Card>
      ) : (
        <>
          {pair && pair.n < 30 && (
            <Caveat>
              Only {pair.n} head-to-head battles — the <i>ranking</i> of concepts is illustrative
              but the magnitudes are noise. This is a pipeline/sanity view; a larger run + the
              report card give the real, prompt-conditioned picture.
            </Caveat>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <h3 className="mb-2 text-sm font-semibold text-slate-200">{short(effA!)} expresses more</h3>
              {aMore.length === 0 ? <p className="text-xs text-slate-500">—</p> :
                aMore.map((r) => (
                  <ConceptBarRow key={r.f} id={r.f} name={cname.get(r.f)} value={r.c.toFixed(3)}
                    title={`fire: ${short(effA!)} ${(r.fa * 100).toFixed(0)}% · ${short(realB)} ${(r.fb * 100).toFixed(0)}%`}
                    width={Math.abs(r.c) / maxAbs} color={divergeColor(r.c, maxAbs)} />
                ))}
            </Card>
            <Card>
              <h3 className="mb-2 text-sm font-semibold text-slate-200">{short(realB)} expresses more</h3>
              {bMore.length === 0 ? <p className="text-xs text-slate-500">—</p> :
                bMore.map((r) => (
                  <ConceptBarRow key={r.f} id={r.f} name={cname.get(r.f)} value={r.c.toFixed(3)}
                    title={`fire: ${short(effA!)} ${(r.fa * 100).toFixed(0)}% · ${short(realB)} ${(r.fb * 100).toFixed(0)}%`}
                    width={Math.abs(r.c) / maxAbs} color={divergeColor(r.c, maxAbs)} />
                ))}
            </Card>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {[effA!, realB].map((m) => {
              const pr = powerRows(m);
              const mx = Math.max(1e-9, ...pr.map((r) => r.fire ?? 0));
              return (
                <Card key={m}>
                  <h3 className="mb-2 text-sm font-semibold text-slate-200">{short(m)} — most-expressed concepts</h3>
                  <p className="mb-2 text-[11px] text-slate-500">fire rate across its answers in this dataset</p>
                  {pr.length === 0 ? <p className="text-xs text-slate-500">—</p> :
                    pr.map((r) => (
                      <ConceptBarRow key={r.f} id={r.f} name={cname.get(r.f)}
                        value={`${((r.fire ?? 0) * 100).toFixed(0)}%`} width={(r.fire ?? 0) / mx}
                        color={`rgba(96,165,250,${(0.3 + 0.6 * (r.fire ?? 0)).toFixed(2)})`} />
                    ))}
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
