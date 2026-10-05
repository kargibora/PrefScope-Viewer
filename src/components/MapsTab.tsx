import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ConceptCoactivation,
  Feature,
  FeatureClusterBundle,
  FeatureMapData,
  MapData,
  PromptFeatures,
  PromptMapData,
  ResponseMapData,
} from "../types";
import { useDataArtifact, useDataClient, useMap } from "../data";
import { Card, Segmented, Skeleton } from "./ui";
import FeatureAtlasView from "./FeatureAtlasView";
import MapView from "./MapView";
import ResponseMapView from "./ResponseMapView";
import PromptMapView from "./PromptMapView";
import ClusterExplorer from "./ClusterExplorer";
import ConceptDetailDrawer from "./ConceptDetailDrawer";
import PromptConceptDetailDrawer from "./PromptConceptDetailDrawer";

type Sub = "features" | "featureClusters" | "promptFeatures" | "promptClusters" | "responses" | "battle" | "prompt";
const SUBS: { id: Sub; label: string; artifact: string }[] = [
  { id: "features", label: "Response feature atlas", artifact: "feature_map.json" },
  { id: "featureClusters", label: "Response communities", artifact: "feature_clusters.json" },
  { id: "promptFeatures", label: "Prompt feature atlas", artifact: "prompt_feature_map.json" },
  { id: "promptClusters", label: "Prompt communities", artifact: "prompt_feature_clusters.json" },
  { id: "responses", label: "Response scatter", artifact: "response_map.json" },
  { id: "battle", label: "Battle scatter", artifact: "map.json" },
  { id: "prompt", label: "Prompt scatter", artifact: "prompt_map.json" },
];

// Map artifacts are fetched only after their sub-view is visited. The feature atlas is
// distinct from response/battle scatters: it contains every decoder axis exactly once.
export default function MapsTab({
  features,
  onJump,
  onOpenFeature,
  onOpenPrompt,
  onOpenCoactivation,
  hasLabels = true,
}: {
  features: Feature[];
  onJump: (pc: number, cf: number) => void;
  onOpenFeature?: (featureId: number) => void;
  onOpenPrompt?: (featureId: number) => void;
  onOpenCoactivation?: (featureId: number) => void;
  hasLabels?: boolean;
}) {
  const client = useDataClient();
  const available = useMemo(
    () => SUBS.filter((item) => client.hasArtifact(item.artifact)),
    [client],
  );
  const [sub, setSub] = useState<Sub>(available[0]?.id ?? "features");
  const [detailFeature, setDetailFeature] = useState<number | null>(null);
  const [detailPrompt, setDetailPrompt] = useState<number | null>(null);
  const visited = useRef<Set<Sub>>(new Set([sub]));

  useEffect(() => {
    if (!available.some((item) => item.id === sub) && available[0]) setSub(available[0].id);
  }, [available, sub]);
  visited.current.add(sub);

  if (available.length === 0)
    return <Card><p className="text-sm text-slate-400">No map artifact is available for this dataset.</p></Card>;

  return <>
    <div className="flex flex-col gap-4">
      {available.length > 1 && (
        <div className="max-w-full overflow-x-auto pb-1">
          <Segmented value={sub} onChange={(value) => setSub(value)}
            options={available.map((item) => ({ value: item.id, label: item.label }))} />
        </div>
      )}

      {visited.current.has("features") && available.some((item) => item.id === "features") && (
        <div hidden={sub !== "features"}>
          <FeatureAtlasPane features={features} onOpenFeature={onOpenFeature}
            onInspectFeature={setDetailFeature} onOpenCoactivation={onOpenCoactivation} />
        </div>
      )}
      {visited.current.has("promptFeatures") && available.some((item) => item.id === "promptFeatures") && (
        <div hidden={sub !== "promptFeatures"}>
          <PromptFeatureAtlasPane onOpenPrompt={onOpenPrompt} onInspectPrompt={setDetailPrompt} />
        </div>
      )}
      {visited.current.has("featureClusters") && available.some((item) => item.id === "featureClusters") && (
        <div hidden={sub !== "featureClusters"}>
          <ResponseClusterPane features={features} onOpenFeature={onOpenFeature}
            onInspectFeature={setDetailFeature} />
        </div>
      )}
      {visited.current.has("promptClusters") && available.some((item) => item.id === "promptClusters") && (
        <div hidden={sub !== "promptClusters"}>
          <PromptClusterPane onOpenPrompt={onOpenPrompt} onInspectPrompt={setDetailPrompt} />
        </div>
      )}
      {visited.current.has("responses") && available.some((item) => item.id === "responses") && (
        <div hidden={sub !== "responses"}><ResponseMapPane /></div>
      )}
      {visited.current.has("battle") && available.some((item) => item.id === "battle") && (
        <div hidden={sub !== "battle"}><BattleMapPane /></div>
      )}
      {visited.current.has("prompt") && available.some((item) => item.id === "prompt") && (
        <div hidden={sub !== "prompt"}>
          <PromptMapPane onJump={onJump} hasLabels={hasLabels} />
        </div>
      )}
    </div>
    {detailFeature != null && (
      <ConceptDetailDrawer
        featureId={detailFeature}
        features={features}
        onClose={() => setDetailFeature(null)}
        onSelectFeature={setDetailFeature}
      />
    )}
    {detailPrompt != null && (
      <PromptDetailDrawerLoader
        featureId={detailPrompt}
        onClose={() => setDetailPrompt(null)}
        onSelectFeature={setDetailPrompt}
      />
    )}
  </>;
}

function ResponseClusterPane({
  features,
  onOpenFeature,
  onInspectFeature,
}: {
  features: Feature[];
  onOpenFeature?: (featureId: number) => void;
  onInspectFeature?: (featureId: number) => void;
}) {
  const clusters = useDataArtifact<FeatureClusterBundle>("feature_clusters.json");
  const map = useMap<FeatureMapData>("feature_map.json");
  if (clusters === undefined || map === undefined) return <Loading what="response communities" />;
  if (!clusters) return <Card><p className="text-sm text-slate-400">No response feature communities were exported.</p></Card>;
  return <ClusterExplorer clusters={clusters} features={features} map={map} kind="response"
    onOpenFeature={onOpenFeature} onInspectFeature={onInspectFeature} />;
}

function PromptClusterPane({
  onOpenPrompt,
  onInspectPrompt,
}: {
  onOpenPrompt?: (featureId: number) => void;
  onInspectPrompt?: (featureId: number) => void;
}) {
  const clusters = useDataArtifact<FeatureClusterBundle>("prompt_feature_clusters.json");
  const promptFeatures = useDataArtifact<PromptFeatures>("prompt_features.json");
  const map = useMap<FeatureMapData>("prompt_feature_map.json");
  if (clusters === undefined || promptFeatures === undefined || map === undefined)
    return <Loading what="prompt communities" />;
  if (!clusters) return <Card><p className="text-sm text-slate-400">No prompt feature communities were exported.</p></Card>;
  const features: Feature[] = (promptFeatures?.features ?? []).map((feature) => ({ ...feature }));
  return <ClusterExplorer clusters={clusters} features={features} map={map} kind="prompt"
    onOpenFeature={onOpenPrompt} onInspectFeature={onInspectPrompt} />;
}

function PromptFeatureAtlasPane({
  onOpenPrompt,
  onInspectPrompt,
}: {
  onOpenPrompt?: (featureId: number) => void;
  onInspectPrompt?: (featureId: number) => void;
}) {
  const map = useMap<FeatureMapData>("prompt_feature_map.json");
  const promptFeatures = useDataArtifact<PromptFeatures>("prompt_features.json");
  const coactivation = useDataArtifact<ConceptCoactivation>("prompt_coactivation.json");
  if (map === undefined || promptFeatures === undefined || coactivation === undefined)
    return <Loading what="prompt feature atlas" />;
  const features: Feature[] = (promptFeatures?.features ?? []).map((feature) => ({ ...feature }));
  return <FeatureAtlasView kind="prompt" map={map} features={features}
    coactivation={coactivation} onOpenFeature={onOpenPrompt}
    onInspectFeature={onInspectPrompt} />;
}

function PromptDetailDrawerLoader({
  featureId,
  onClose,
  onSelectFeature,
}: {
  featureId: number;
  onClose: () => void;
  onSelectFeature: (featureId: number) => void;
}) {
  const promptFeatures = useDataArtifact<PromptFeatures>("prompt_features.json");
  if (!promptFeatures) return null;
  const features: Feature[] = promptFeatures.features.map((feature) => ({ ...feature }));
  return <PromptConceptDetailDrawer featureId={featureId} features={features}
    onClose={onClose} onSelectFeature={onSelectFeature} />;
}

function Loading({ what }: { what: string }) {
  return <Card><p className="mb-2 text-xs text-slate-500">loading {what}…</p><Skeleton className="h-[520px] w-full" /></Card>;
}

function FeatureAtlasPane({
  features,
  onOpenFeature,
  onInspectFeature,
  onOpenCoactivation,
}: {
  features: Feature[];
  onOpenFeature?: (featureId: number) => void;
  onInspectFeature?: (featureId: number) => void;
  onOpenCoactivation?: (featureId: number) => void;
}) {
  const map = useMap<FeatureMapData>("feature_map.json");
  const coactivation = useDataArtifact<ConceptCoactivation>("coactivation.json");
  if (map === undefined) return <Loading what="feature atlas" />;
  return <FeatureAtlasView map={map} features={features} coactivation={coactivation}
    onOpenFeature={onOpenFeature} onInspectFeature={onInspectFeature}
    onOpenCoactivation={onOpenCoactivation} />;
}

function BattleMapPane() {
  const map = useMap<MapData>("map.json");
  if (map === undefined) return <Loading what="battle scatter" />;
  return <MapView map={map} />;
}

function ResponseMapPane() {
  const map = useMap<ResponseMapData>("response_map.json");
  if (map === undefined) return <Loading what="response scatter" />;
  return <ResponseMapView map={map} />;
}

function PromptMapPane({ onJump, hasLabels }: { onJump: (pc: number, cf: number) => void; hasLabels: boolean }) {
  const map = useMap<PromptMapData>("prompt_map.json");
  if (map === undefined) return <Loading what="prompt scatter" />;
  return <PromptMapView map={map} onJump={onJump} hasLabels={hasLabels} />;
}
