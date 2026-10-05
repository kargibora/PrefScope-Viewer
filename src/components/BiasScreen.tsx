import { useMemo } from "react";
import {
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { BiasRow } from "../types";
import { Card, ConceptBarRow, Explain } from "./ui";

const CONFOUND = "#f59e0b";
const ACCENT = "#6366f1";

function PointTip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload as BiasRow;
  return (
    <div className="rounded-lg border border-edge bg-ink/95 p-2 text-xs text-slate-200">
      <div className="mb-1 font-medium">{d.concept ?? `feature ${d.feature_id}`}</div>
      <div>raw reward correlation: {d.correlation?.toFixed(3) ?? "—"}</div>
      <div>length covariance: {d.corr_confound_len?.toFixed(3) ?? "—"}</div>
      <div>partial reward correlation: {d.correlation_resid_len?.toFixed(3) ?? "—"}</div>
      <div className="mt-1 text-slate-400">
        {d.confound_entangled ? "length/style-entangled candidate" : "reward survives length control"}
        {d.fidelity_pass ? " · verified" : " · unverified"}
      </div>
    </div>
  );
}

export default function BiasScreen({ bias }: { bias: BiasRow[] | null }) {
  const data = useMemo(
    () =>
      (bias ?? []).filter(
        (b) => b.correlation != null && b.correlation_resid_len != null && b.corr_confound_len != null
      ),
    [bias]
  );

  const screened = useMemo(
    () => [...data].sort((a, b) => Math.abs(b.correlation ?? 0) - Math.abs(a.correlation ?? 0)).slice(0, 12),
    [data]
  );

  if (!bias)
    return (
      <Card>
        <h2 className="text-lg font-semibold">Bias screen</h2>
        <p className="mt-2 text-sm text-slate-400">The length-confound screen isn't available for this dataset.</p>
      </Card>
    );

  const nFlag = data.filter((d) => d.confound_entangled).length;
  return (
    <Card>
      <h2 className="text-lg font-semibold">Length-confound screen</h2>
      <div className="my-3">
        <Explain>
          For each feature, does its preference correlation <b>survive</b> once we control for
          answer length, or is it <b>length-entangled</b>? A feature whose association largely
          collapses when length is partialled out is a candidate for skepticism — you can’t
          separate quality from verbosity. {nFlag} of {data.length} screened features look
          length-entangled. (This is a screening flag, not proof the feature is fake.)
        </Explain>
      </div>

      {screened.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-1 text-sm font-semibold text-slate-200">Raw correlation → partial correlation</h3>
          <div className="flex flex-col">
            {screened.map((d) => {
              const maxW = Math.max(0.02, ...screened.map((r) => Math.abs(r.correlation ?? 0)));
              return (
                <div key={d.feature_id} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <ConceptBarRow id={d.feature_id} name={d.concept}
                      value={`${d.correlation?.toFixed(2) ?? "—"} → ${d.correlation_resid_len?.toFixed(2) ?? "—"}`}
                      title={`raw reward correlation ${d.correlation?.toFixed(3) ?? "—"} → partial correlation after length control ${d.correlation_resid_len?.toFixed(3) ?? "—"}`}
                      width={Math.abs(d.correlation ?? 0) / maxW}
                      color={d.confound_entangled ? "rgba(251,191,36,0.8)" : "rgba(52,211,153,0.8)"}
                      dim={!d.fidelity_pass} />
                  </div>
                  <span className={`w-24 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-medium ${
                    d.confound_entangled ? "bg-amber-500/15 text-amber-400" : "bg-good/15 text-good"}`}>
                    {d.confound_entangled ? "length-driven" : "survives"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <ResponsiveContainer width="100%" height={460}>
        <ScatterChart margin={{ left: 8, right: 24, top: 8, bottom: 24 }}>
          <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" vertical={false} />
          <XAxis
            type="number"
            dataKey="correlation"
            name="raw reward correlation"
            stroke="#64748b"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            label={{ value: "raw preference correlation →", position: "bottom", fill: "#64748b", fontSize: 12 }}
          />
          <YAxis
            type="number"
            dataKey="correlation_resid_len"
            name="partial reward correlation"
            stroke="#64748b"
            fontSize={12}
            tickLine={false}
            axisLine={false}
            label={{
              value: "after controlling length →",
              angle: -90,
              position: "insideLeft",
              fill: "#64748b",
              fontSize: 12,
            }}
          />
          <ZAxis range={[40, 40]} />
          <ReferenceLine x={0} stroke="#475569" />
          <ReferenceLine y={0} stroke="#475569" />
          <Tooltip content={<PointTip />} />
          <Scatter data={data}>
            {data.map((d) => (
              <Cell
                key={d.feature_id}
                fill={d.confound_entangled ? CONFOUND : ACCENT}
                fillOpacity={d.fidelity_pass ? 0.95 : 0.4}
                stroke={d.confound_entangled ? CONFOUND : ACCENT}
              />
            ))}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </Card>
  );
}
