import { createContext, useContext, useEffect, useState } from "react";
import type {
  Bundle,
  BundleManifest,
  ConditionalBundle,
  ConditionalData,
  Example,
  FeatureMapData,
  MapData,
  PromptMapData,
  PromptExample,
  ResponseMapData,
} from "./types";
import { BUNDLE_SCHEMA_VERSION } from "./types";

function wrapKeyspace<T>(d: unknown): { raw: T | null; clustered: T | null } | null {
  if (d == null || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  if ("raw" in o || "clustered" in o)
    return { raw: (o.raw as T) ?? null, clustered: (o.clustered as T) ?? null };
  return { raw: d as T, clustered: null };
}

const DEFAULT_DATA = `${import.meta.env.BASE_URL}data/`;

function normalizeRoot(root: string): string {
  const trimmed = root.trim();
  if (!trimmed) return DEFAULT_DATA;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export interface DatasetInfo { id: string; label: string; overlay: string }

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} has an invalid shape (expected an object)`);
  return value as Record<string, unknown>;
}

function validateManifest(value: unknown): BundleManifest | null {
  if (value == null) return null;
  const m = requireObject(value, "bundle_manifest.json");
  if (typeof m.schema_version !== "number" || !Array.isArray(m.files) || !m.files.every((x) => typeof x === "string"))
    throw new Error("bundle_manifest.json is missing schema_version or files[]");
  if (m.schema_version !== BUNDLE_SCHEMA_VERSION)
    throw new Error(`Unsupported bundle schema v${m.schema_version}; this viewer requires v${BUNDLE_SCHEMA_VERSION}`);
  return value as BundleManifest;
}

function validateMeta(value: unknown): Bundle["meta"] {
  const m = requireObject(value, "meta.json");
  for (const key of ["lens", "m_total", "k", "n_battles"] as const)
    if (m[key] == null) throw new Error(`meta.json is missing required field ${key}`);
  if (typeof m.lens !== "string" || typeof m.m_total !== "number" || typeof m.k !== "number" || typeof m.n_battles !== "number")
    throw new Error("meta.json has invalid core field types");
  return value as Bundle["meta"];
}

function validateFeatures(value: unknown): Bundle["features"] {
  if (!Array.isArray(value) || !value.every((f) =>
    f != null && typeof f === "object" && Number.isInteger((f as Record<string, unknown>).feature_id)))
    throw new Error("features.json must be an array with an integer feature_id on every row");
  return value as Bundle["features"];
}

type CacheState<T> = { hit: boolean; value: T | null | undefined };

/**
 * One isolated exported-bundle client. Each mounted viewer owns its own instance, manifest,
 * cache, and in-flight requests, so two viewers cannot overwrite one another's data source.
 */
export class PrefScopeDataClient {
  readonly root: string;
  private manifest: BundleManifest | null = null;
  private readonly cache = new Map<string, unknown>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(root = DEFAULT_DATA) {
    this.root = normalizeRoot(root);
  }

  private async getJSON<T>(name: string, optional = false): Promise<T | null> {
    const path = `${this.root}${name.replace(/^\/+/, "")}`;
    const res = await fetch(path);
    if (!res.ok) {
      if (optional) return null;
      throw new Error(`failed to load ${path} (${res.status})`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      // Vite/other SPA hosts may answer a missing optional JSON path with index.html.
      // Treat that specific fallback as absent; malformed JSON is corruption and throws.
      if (optional && /^\s*<!doctype\s+html/i.test(text)) return null;
      throw new Error(`failed to parse ${path} as JSON (got ${res.headers.get("content-type")})`);
    }
  }

  hasArtifact(name: string): boolean {
    if (!this.manifest) return true;
    const files = this.manifest.files ?? [];
    // Sharded artifact directories are represented once in the manifest (for example
    // ``examples/`` or ``joint_examples/``), while callers request an individual shard.
    const slash = name.indexOf("/");
    if (slash >= 0 && files.includes(name.slice(0, slash + 1))) return true;
    return files.includes(name);
  }

  isLegacyBundle(): boolean { return this.manifest == null; }

  async loadDatasets(): Promise<DatasetInfo[]> {
    const raw = await this.getJSON<unknown>("datasets.json", true);
    if (!Array.isArray(raw) || raw.length === 0)
      return [{ id: "default", label: "Dataset", overlay: "" }];
    const rows = raw.filter((d): d is DatasetInfo => {
      if (d == null || typeof d !== "object") return false;
      const x = d as Record<string, unknown>;
      if (typeof x.id !== "string" || typeof x.label !== "string" || typeof x.overlay !== "string") return false;
      return !x.overlay.includes("..") && !/^(?:[a-z]+:|\/)/i.test(x.overlay);
    }).map((d) => ({ ...d, overlay: d.overlay && !d.overlay.endsWith("/") ? `${d.overlay}/` : d.overlay }));
    return rows.length ? rows : [{ id: "default", label: "Dataset", overlay: "" }];
  }

  async loadBundle(overlay = ""): Promise<Bundle> {
    this.manifest = validateManifest(await this.getJSON<unknown>("bundle_manifest.json", true));
    const [metaRaw, featuresRaw] = await Promise.all([
      this.getJSON<unknown>(overlay ? `${overlay}meta.json` : "meta.json"),
      this.getJSON<unknown>("features.json"),
    ]);
    const meta = validateMeta(metaRaw);
    const features = validateFeatures(featuresRaw);
    return {
      meta,
      manifest: this.manifest,
      features,
      validation: [],
      diagnosis: null,
      examples: null,
      bias: null,
      promptFeatures: null,
      conditional: null,
      elicitation: null,
      reportBattles: null,
      headToHead: null,
      modelCompare: null,
      coactivation: null,
    };
  }

  cached<T>(name: string, manifestAware = true): CacheState<T> {
    const key = `${manifestAware ? "listed" : "direct"}:${name}`;
    return { hit: this.cache.has(key), value: this.cache.get(key) as T | null | undefined };
  }

  async artifact<T>(name: string, manifestAware = true): Promise<T | null> {
    if (manifestAware && !this.hasArtifact(name)) return null;
    const key = `${manifestAware ? "listed" : "direct"}:${name}`;
    if (this.cache.has(key)) return this.cache.get(key) as T | null;
    if (!this.inflight.has(key)) {
      this.inflight.set(key, this.getJSON<T>(name, true).then((d) => {
        this.cache.set(key, d);
        this.inflight.delete(key);
        return d;
      }).catch((e) => {
        this.inflight.delete(key);
        throw e;
      }));
    }
    return this.inflight.get(key) as Promise<T | null>;
  }

  async fetchOptional<T>(name: string): Promise<T | null> {
    return this.artifact<T>(name, true);
  }
}

export const DataClientContext = createContext<PrefScopeDataClient | null>(null);
const defaultClient = new PrefScopeDataClient();

export function useDataClient(): PrefScopeDataClient {
  return useContext(DataClientContext) ?? defaultClient;
}

// Back-compatible low-level helpers for non-React consumers. Embedded viewers use their
// own PrefScopeDataClient through context and do not share this default instance.
let configuredClient = defaultClient;
export function configureDataSource(root?: string): void {
  configuredClient = new PrefScopeDataClient(root ?? DEFAULT_DATA);
}
export function currentDataSource(): string { return configuredClient.root; }
export function loadDatasets(): Promise<DatasetInfo[]> { return configuredClient.loadDatasets(); }
export function loadBundle(overlay = ""): Promise<Bundle> { return configuredClient.loadBundle(overlay); }

export function normalizeConditional(d: unknown): ConditionalBundle | null {
  return wrapKeyspace<ConditionalData>(d) as ConditionalBundle | null;
}

export function useDataArtifact<T>(
  name: string | null,
  manifestAware = true
): T | null | undefined {
  const client = useDataClient();
  const [data, setData] = useState<T | null | undefined>(() => {
    if (name == null) return undefined;
    const cached = client.cached<T>(name, manifestAware);
    return cached.hit ? cached.value : undefined;
  });

  useEffect(() => {
    if (name == null) { setData(undefined); return; }
    if (manifestAware && !client.hasArtifact(name)) { setData(null); return; }
    const cached = client.cached<T>(name, manifestAware);
    if (cached.hit) { setData(cached.value); return; }
    let live = true;
    setData(undefined);
    client.artifact<T>(name, manifestAware)
      .then((d) => { if (live) setData(d); })
      .catch((error) => {
        console.error(`PrefScope artifact failed: ${name}`, error);
        if (live) setData(null);
      });
    return () => { live = false; };
  }, [client, name, manifestAware]);
  return data;
}

// Per-feature example shards: request only the selected feature and cache it in this
// viewer's client. Legacy bundles without manifests may still use examples.json.
export function useFeatureExamples(fid: number | null | undefined): Example[] | null | undefined {
  const client = useDataClient();
  const name = fid == null ? null : `examples/${fid}.json`;
  const shard = useDataArtifact<Example[]>(name);
  const [legacy, setLegacy] = useState<Example[] | null | undefined>(undefined);
  useEffect(() => {
    if (fid == null || shard !== null) { setLegacy(undefined); return; }
    if (!client.isLegacyBundle()) { setLegacy(null); return; }
    let live = true;
    client.artifact<Record<string, Example[]>>("examples.json", false)
      .then((all) => { if (live) setLegacy(all?.[String(fid)] ?? null); })
      .catch(() => { if (live) setLegacy(null); });
    return () => { live = false; };
  }, [client, fid, shard]);
  return shard === null ? legacy : shard;
}

export function usePromptExamples(fid: number | null | undefined): PromptExample[] | null | undefined {
  const name = fid == null ? null : `prompt_examples/${fid}.json`;
  return useDataArtifact<PromptExample[]>(name);
}

export function useMap<T = FeatureMapData | MapData | PromptMapData | ResponseMapData>(name: string): T | null | undefined {
  return useDataArtifact<T>(name);
}

export const fmt = (x: number | null | undefined, d = 3) =>
  x === null || x === undefined || Number.isNaN(x) ? "—" : x.toFixed(d);

export const pct = (x: number | null | undefined, d = 1) =>
  x === null || x === undefined || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(d)}%`;
