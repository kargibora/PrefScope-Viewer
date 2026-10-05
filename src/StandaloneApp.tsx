import { useEffect, useState } from "react";
import App from "./App";
import BridgeViewer from "./BridgeViewer";
import { validateViewerData, type ViewerData } from "./bridgeData";
import { validateViewerBundleManifest, verifyViewerDataBytes } from "./bundleManifest";

interface BridgeState {
  status: "loading" | "legacy" | "ready" | "error";
  data?: ViewerData;
  error?: string;
}

interface StandaloneAppProps {
  dataBaseUrl?: string;
  bundleMode?: boolean;
  viewerVersion?: string;
}

function withSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function dataRoot(configured?: string): string {
  return withSlash(configured?.trim() || `${import.meta.env.BASE_URL}data/`);
}

function bundleRoot(): string {
  return withSlash(import.meta.env.BASE_URL || "./");
}

async function detectBridge(url: string, signal: AbortSignal): Promise<BridgeState> {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (response.status === 404 || response.status === 410) return { status: "legacy" };
  if (!response.ok) throw new Error(`failed to load ${url} (${response.status})`);
  const text = await response.text();
  // Static SPA hosts often return index.html for a missing asset.
  if (/^\s*<!doctype\s+html/i.test(text)) return { status: "legacy" };
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`failed to parse ${url} as JSON`); }
  return { status: "ready", data: validateViewerData(parsed) };
}

async function loadPackagedBridge(root: string, viewerVersion: string, signal: AbortSignal): Promise<BridgeState> {
  const manifestUrl = `${root}viewer-bundle.json`;
  const manifestResponse = await fetch(manifestUrl, { signal, cache: "no-store" });
  if (!manifestResponse.ok)
    throw new Error(`failed to load ${manifestUrl} (${manifestResponse.status})`);
  let rawManifest: unknown;
  try { rawManifest = JSON.parse(await manifestResponse.text()); }
  catch { throw new Error(`failed to parse ${manifestUrl} as JSON`); }
  const manifest = validateViewerBundleManifest(rawManifest, viewerVersion);

  const dataUrl = `${root}${manifest.data.path}`;
  const dataResponse = await fetch(dataUrl, { signal, cache: "no-store" });
  if (!dataResponse.ok)
    throw new Error(`failed to load ${dataUrl} (${dataResponse.status})`);
  const data = await verifyViewerDataBytes(manifest, await dataResponse.arrayBuffer());
  return { status: "ready", data };
}

export default function StandaloneApp({
  dataBaseUrl,
  bundleMode = false,
  viewerVersion = "",
}: StandaloneAppProps) {
  const [state, setState] = useState<BridgeState>({ status: "loading" });
  const bridgeUrl = `${dataRoot(dataBaseUrl)}viewer-data.json`;
  const root = bundleRoot();
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    const loading = bundleMode
      ? loadPackagedBridge(root, viewerVersion, controller.signal)
      : detectBridge(bridgeUrl, controller.signal);
    loading
      .then(setState)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({ status: "error", error: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [bridgeUrl, bundleMode, root, viewerVersion]);

  if (state.status === "legacy" && !bundleMode)
    return <App dataBaseUrl={dataBaseUrl} syncUrl layout="standalone" />;
  if (state.status === "ready" && state.data)
    return <BridgeViewer data={state.data} layout="standalone" />;
  const checkedPath = bundleMode ? "viewer-bundle.json" : "data/viewer-data.json";
  return <div className="prefscope-viewer min-h-screen"><main className="mx-auto max-w-3xl p-6 sm:p-12"><div className="rounded-2xl border border-edge bg-panel/70 p-6"><h1 className="text-lg font-semibold text-slate-100">{state.status === "error" ? "Viewer data could not be opened" : "Loading PrefScope data"}</h1>{state.status === "error" ? <><p className="mt-3 text-sm leading-relaxed text-red-300">{state.error}</p><p className="mt-3 text-xs text-slate-500">{bundleMode ? "This self-contained bundle will not fall back to unrelated data." : "The bridge file exists or could not be checked, so the viewer will not silently load a different legacy dataset."}</p></> : <p className="mt-2 text-sm text-slate-400">Checking <code className="text-slate-300">{checkedPath}</code>…</p>}</div></main></div>;
}
