import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Network, Search } from "lucide-react";

import type {
  Feature,
  FeatureCluster,
  FeatureClusterBundle,
  FeatureMapData,
  FeatureMapPoint,
} from "../types";
import { fmt, pct } from "../data";
import {
  Card,
  ConceptLabel,
  Explain,
  VerifiedBadge,
  conceptLabel,
  isUnnamed,
} from "./ui";
import { AtlasExamples, PromptAtlasExamples } from "./FeatureAtlasView";

const WIDTH = 900;
const HEIGHT = 430;
const PAD = 24;

function communityName(cluster: FeatureCluster) {
  return cluster.label || `Community ${cluster.cluster_id}`;
}

function representativePreview(cluster: FeatureCluster, limit = 4) {
  const concepts = cluster.representative_concepts
    .split(" | ")
    .map((concept) => concept.trim())
    .filter(Boolean);
  if (concepts.length <= limit) return concepts.join(" · ");
  return `${concepts.slice(0, limit).join(" · ")} · +${concepts.length - limit} more`;
}

function clusterColor(clusterId: number, lightness = 64) {
  // A stable categorical hue. Selection/opacity carries most of the visual signal;
  // color is an identifier, not a semantic category.
  const hue = ((clusterId * 137.508) % 360 + 360) % 360;
  return `hsl(${hue.toFixed(1)} 68% ${lightness}%)`;
}

function project(points: FeatureMapPoint[]) {
  if (!points.length) return [] as (FeatureMapPoint & { px: number; py: number })[];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  return points.map((point) => ({
    ...point,
    px: PAD + ((point.x - minX) / spanX) * (WIDTH - PAD * 2),
    py: PAD + (1 - (point.y - minY) / spanY) * (HEIGHT - PAD * 2),
  }));
}

function diagnosticNumber(
  diagnostics: FeatureClusterBundle["diagnostics"],
  key: string,
) {
  const value = diagnostics?.[key];
  return typeof value === "number" ? value : null;
}

export default function ClusterExplorer({
  clusters,
  features,
  map,
  kind,
  onOpenFeature,
  onInspectFeature,
}: {
  clusters: FeatureClusterBundle;
  features: Feature[];
  map: FeatureMapData | null;
  kind: "response" | "prompt";
  onOpenFeature?: (featureId: number) => void;
  onInspectFeature?: (featureId: number) => void;
}) {
  const [clusterQuery, setClusterQuery] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [selectedClusterId, setSelectedClusterId] = useState<number | null>(
    clusters.clusters[0]?.cluster_id ?? null,
  );
  const [selectedFeatureId, setSelectedFeatureId] = useState<number | null>(null);
  const [armedFeatureId, setArmedFeatureId] = useState<number | null>(null);

  const featureById = useMemo(() => {
    const result = new Map<number, Feature>();
    features.forEach((feature) => result.set(feature.feature_id, feature));
    clusters.clusters.forEach((cluster) => cluster.members.forEach((member) => {
      const prior = result.get(member.feature_id);
      result.set(member.feature_id, { ...member, ...prior, feature_id: member.feature_id });
    }));
    return result;
  }, [clusters, features]);
  const clusterById = useMemo(
    () => new Map(clusters.clusters.map((cluster) => [cluster.cluster_id, cluster])),
    [clusters],
  );
  const clusterOfFeature = useMemo(() => {
    const result = new Map<number, number>();
    clusters.clusters.forEach((cluster) => cluster.feature_ids.forEach(
      (featureId) => result.set(featureId, cluster.cluster_id),
    ));
    return result;
  }, [clusters]);
  const projected = useMemo(() => project(map?.points ?? []), [map]);

  const selectedCluster = selectedClusterId == null
    ? undefined
    : clusterById.get(selectedClusterId);
  useEffect(() => {
    if (selectedClusterId != null && clusterById.has(selectedClusterId)) return;
    setSelectedClusterId(clusters.clusters[0]?.cluster_id ?? null);
  }, [clusterById, clusters.clusters, selectedClusterId]);
  useEffect(() => {
    if (!selectedCluster) { setSelectedFeatureId(null); return; }
    if (selectedFeatureId != null && selectedCluster.feature_ids.includes(selectedFeatureId))
      return;
    const representative = selectedCluster.representative_feature_ids.find(
      (featureId) => selectedCluster.feature_ids.includes(featureId),
    );
    setSelectedFeatureId(representative ?? selectedCluster.feature_ids[0] ?? null);
  }, [selectedCluster, selectedFeatureId]);

  const q = clusterQuery.trim().toLowerCase();
  const visibleClusters = useMemo(() => clusters.clusters.filter((cluster) => {
    if (!q) return true;
    if (String(cluster.cluster_id) === q || communityName(cluster).toLowerCase().includes(q))
      return true;
    if (cluster.representative_concepts.toLowerCase().includes(q)) return true;
    return cluster.members.some((member) =>
      (member.concept ?? "").toLowerCase().includes(q)
      || String(member.feature_id) === q,
    );
  }), [clusters.clusters, q]);

  const mq = memberQuery.trim().toLowerCase();
  const members = useMemo(() => {
    if (!selectedCluster) return [] as Feature[];
    const representativeRank = new Map(
      selectedCluster.representative_feature_ids.map((featureId, index) => [featureId, index]),
    );
    return selectedCluster.feature_ids
      .map((featureId) => featureById.get(featureId) ?? { feature_id: featureId })
      .filter((feature) => !mq
        || String(feature.feature_id) === mq
        || (feature.concept ?? "").toLowerCase().includes(mq)
        || (feature.feature_summary ?? "").toLowerCase().includes(mq))
      .sort((a, b) => {
        const ar = representativeRank.get(a.feature_id) ?? 10_000;
        const br = representativeRank.get(b.feature_id) ?? 10_000;
        if (ar !== br) return ar - br;
        if (Boolean(a.fidelity_pass) !== Boolean(b.fidelity_pass))
          return Number(Boolean(b.fidelity_pass)) - Number(Boolean(a.fidelity_pass));
        if (isUnnamed(a.concept) !== isUnnamed(b.concept)) return isUnnamed(a.concept) ? 1 : -1;
        return a.feature_id - b.feature_id;
      });
  }, [featureById, mq, selectedCluster]);
  const selectedFeature = selectedFeatureId == null
    ? undefined
    : featureById.get(selectedFeatureId);

  const selectPoint = (featureId: number) => {
    const clusterId = clusterOfFeature.get(featureId);
    if (clusterId == null) return;
    if (selectedFeatureId === featureId && armedFeatureId === featureId) {
      onInspectFeature?.(featureId);
      return;
    }
    setSelectedClusterId(clusterId);
    setSelectedFeatureId(featureId);
    setArmedFeatureId(featureId);
    setMemberQuery("");
  };

  const stability = diagnosticNumber(clusters.diagnostics, "seed_ari_mean");
  const resolution = diagnosticNumber(clusters.diagnostics, "resolution");

  return (
    <div className="space-y-4">
      <Explain>
        Communities use the partition declared by this bundle. They are useful for
        navigation and finding related or duplicated labels, but they do not merge feature
        meanings: language, topic, format, and response policy can co-occur in one community.
        Open individual members and their examples before assigning an umbrella interpretation.
      </Explain>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-accent-soft">
              <Network size={14} /> {kind === "prompt" ? "Prompt" : "Response"} communities
            </div>
            <h2 className="mt-1 text-xl font-semibold text-slate-50">
              {clusters.n_clusters.toLocaleString()} statistical communities
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {clusters.n_clustered_features.toLocaleString()} of {clusters.n_total_features.toLocaleString()} axes assigned
              {clusters.method ? ` · ${clusters.method}` : ""}
              {resolution != null ? ` · resolution ${resolution}` : ""}
              {stability != null ? ` · seed ARI ${stability.toFixed(3)}` : ""}
            </p>
          </div>
          <dl className="grid grid-cols-3 gap-x-6 gap-y-1 text-right text-xs">
            <div><dt className="text-slate-600">Largest</dt><dd className="mt-1 font-mono text-slate-200">{Math.max(0, ...clusters.clusters.map((cluster) => cluster.n_features))}</dd></div>
            <div><dt className="text-slate-600">Singletons</dt><dd className="mt-1 font-mono text-slate-200">{clusters.clusters.filter((cluster) => cluster.n_features === 1).length}</dd></div>
            <div><dt className="text-slate-600">Unassigned</dt><dd className="mt-1 font-mono text-slate-200">{clusters.n_unclustered_features}</dd></div>
          </dl>
        </div>
      </Card>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[330px_minmax(0,1fr)]">
        <Card className="min-w-0">
          <label className="relative block">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-2.5 text-slate-500" />
            <input
              value={clusterQuery}
              onChange={(event) => setClusterQuery(event.target.value)}
              placeholder="Search community or member…"
              aria-label="Search feature communities"
              className="w-full rounded-lg border border-edge bg-ink py-2 pl-8 pr-2 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-accent/60"
            />
          </label>
          <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
            <span>{visibleClusters.length} communities</span>
            <span>ordered by size</span>
          </div>
          <div className="mt-2 max-h-[650px] space-y-1 overflow-auto pr-1">
            {visibleClusters.map((cluster) => (
              <button
                key={cluster.cluster_id}
                type="button"
                onClick={() => { setSelectedClusterId(cluster.cluster_id); setMemberQuery(""); }}
                className={`w-full rounded-xl px-3 py-2.5 text-left transition ${
                  cluster.cluster_id === selectedClusterId
                    ? "bg-accent/15 ring-1 ring-inset ring-accent/35"
                    : "hover:bg-edge/35"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: clusterColor(cluster.cluster_id) }} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-200">{communityName(cluster)}</span>
                  <span className="shrink-0 font-mono text-[10px] text-slate-500">{cluster.n_features} axes</span>
                </div>
                <p className="mt-1 line-clamp-2 pl-[18px] text-[11px] leading-relaxed text-slate-500">
                  {cluster.representative_concepts || "No interpreted representative yet"}
                </p>
              </button>
            ))}
          </div>
        </Card>

        <div className="min-w-0 space-y-4">
          {selectedCluster && (
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Statistical community {selectedCluster.cluster_id}
                  </div>
                  <h3 className="mt-1 text-lg font-semibold text-slate-50">{communityName(selectedCluster)}</h3>
                  {selectedCluster.representative_concepts && (
                    <p className="mt-2 max-w-4xl text-sm leading-relaxed text-slate-400">
                      Representative member labels: {representativePreview(selectedCluster)}
                    </p>
                  )}
                </div>
                <dl className="grid grid-cols-3 gap-x-5 text-right text-xs">
                  <div><dt className="text-slate-600">Members</dt><dd className="mt-1 font-mono text-slate-200">{selectedCluster.n_features}</dd></div>
                  <div><dt className="text-slate-600">Named</dt><dd className="mt-1 font-mono text-slate-200">{selectedCluster.n_named}</dd></div>
                  <div><dt className="text-slate-600">Verified</dt><dd className="mt-1 font-mono text-slate-200">{selectedCluster.n_verified}</dd></div>
                </dl>
              </div>
              {(selectedCluster.within_affinity_mean != null || selectedCluster.affinity_separation != null) && (
                <p className="mt-3 text-xs text-slate-500">
                  Mean internal affinity {fmt(selectedCluster.within_affinity_mean)}
                  {selectedCluster.affinity_separation != null
                    ? ` · internal-minus-external ${fmt(selectedCluster.affinity_separation)}`
                    : ""}
                </p>
              )}

              {projected.length > 0 && (
                <div className="mt-4 overflow-hidden rounded-xl border border-edge/80 bg-[#080b12]">
                  <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="block h-auto min-h-[300px] w-full" role="img" aria-label={`Feature geometry highlighting community ${selectedCluster.cluster_id}`}>
                    <rect width={WIDTH} height={HEIGHT} fill="#080b12" />
                    {projected.map((point) => {
                      const pointCluster = clusterOfFeature.get(point.feature_id);
                      const inSelected = pointCluster === selectedCluster.cluster_id;
                      const chosen = point.feature_id === selectedFeatureId;
                      return (
                        <circle
                          key={point.feature_id}
                          cx={point.px}
                          cy={point.py}
                          r={chosen ? 6 : inSelected ? 4.2 : 2.1}
                          fill={pointCluster == null ? "#334155" : clusterColor(pointCluster, inSelected ? 66 : 48)}
                          fillOpacity={chosen ? 1 : inSelected ? 0.92 : 0.16}
                          stroke={chosen ? "#f8fafc" : "transparent"}
                          strokeWidth={chosen ? 2 : 0}
                          className={pointCluster == null ? "" : "cursor-pointer"}
                          onClick={() => selectPoint(point.feature_id)}
                        >
                          <title>{conceptLabel(point.feature_id, featureById.get(point.feature_id)?.concept)} · community {pointCluster ?? "unassigned"} · click again for evidence</title>
                        </circle>
                      );
                    })}
                  </svg>
                  <div className="border-t border-edge/70 px-3 py-2 text-[11px] text-slate-500">
                    Bright points are this community. Click a point to select its feature; click it again to open the evidence drawer.
                  </div>
                </div>
              )}

              <div className="mt-5 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold text-slate-100">All member features</h4>
                  <p className="mt-0.5 text-xs text-slate-500">Feature identity is preserved; repeated names remain separate axes.</p>
                </div>
                <label className="relative block w-full sm:w-72">
                  <Search size={13} className="pointer-events-none absolute left-2.5 top-2.5 text-slate-500" />
                  <input
                    value={memberQuery}
                    onChange={(event) => setMemberQuery(event.target.value)}
                    placeholder="Filter members…"
                    aria-label="Filter community members"
                    className="w-full rounded-lg border border-edge bg-ink py-2 pl-8 pr-2 text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-accent/60"
                  />
                </label>
              </div>
              <div className="mt-3 max-h-[420px] space-y-1 overflow-auto pr-1">
                {members.map((feature) => (
                  <button
                    key={feature.feature_id}
                    type="button"
                    onClick={() => { setSelectedFeatureId(feature.feature_id); setArmedFeatureId(feature.feature_id); }}
                    className={`flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left ${
                      feature.feature_id === selectedFeatureId
                        ? "bg-accent/15 ring-1 ring-inset ring-accent/30"
                        : "hover:bg-edge/35"
                    }`}
                  >
                    <span className="w-10 shrink-0 font-mono text-[10px] text-slate-600">#{feature.feature_id}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-300">{conceptLabel(feature.feature_id, feature.concept)}</span>
                    <VerifiedBadge pass={feature.fidelity_pass} n={feature.fidelity_n} />
                    {feature.generality != null && <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-slate-600">{pct(feature.generality)}</span>}
                  </button>
                ))}
                {members.length === 0 && <p className="py-6 text-center text-xs text-slate-500">No member matches this filter.</p>}
              </div>
            </Card>
          )}

          {selectedFeatureId != null && selectedFeature && (
            <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
              <Card className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  {kind === "prompt" ? "Prompt" : "Response"} feature {selectedFeatureId}
                </div>
                <h3 className="mt-1 text-lg font-semibold leading-snug text-slate-50">
                  <ConceptLabel id={selectedFeatureId} name={selectedFeature.concept} wrap />
                </h3>
                {selectedFeature.feature_summary && <p className="mt-3 text-sm leading-relaxed text-slate-400">{selectedFeature.feature_summary}</p>}
                <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
                  <div><dt className="text-slate-600">Verification</dt><dd className="mt-1 text-slate-200">{selectedFeature.fidelity_pass === true ? "passed" : selectedFeature.fidelity_pass === false ? "did not pass" : "not tested"}</dd></div>
                  <div><dt className="text-slate-600">Community</dt><dd className="mt-1 text-slate-200">{selectedCluster ? communityName(selectedCluster) : "—"}</dd></div>
                  {kind === "response" && <>
                    <div><dt className="text-slate-600">Semantic family</dt><dd className="mt-1 text-slate-200">{selectedFeature.semantic_family?.replace(/_/g, " ") ?? "unclassified"}</dd></div>
                    <div><dt className="text-slate-600">Response prevalence</dt><dd className="mt-1 text-slate-200">{pct(selectedFeature.semantic_presence_rate ?? selectedFeature.generality ?? selectedFeature.fire_rate)}</dd></div>
                  </>}
                </dl>
                {onOpenFeature && (
                  <button type="button" onClick={() => onOpenFeature(selectedFeatureId)} className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent/90">
                    <ExternalLink size={13} /> Open full feature report
                  </button>
                )}
              </Card>
              {kind === "prompt"
                ? <PromptAtlasExamples fid={selectedFeatureId} concept={conceptLabel(selectedFeatureId, selectedFeature.concept)} />
                : <AtlasExamples fid={selectedFeatureId} concept={conceptLabel(selectedFeatureId, selectedFeature.concept)} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
