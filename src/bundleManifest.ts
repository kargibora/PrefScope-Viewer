import { validateViewerData, type ViewerData } from "./bridgeData";

const SHA256 = /^[0-9a-f]{64}$/;

export interface ViewerBundleFile {
  path: string;
  size_bytes: number;
  sha256: string;
}

export interface ViewerBundleManifest {
  schema: "prefscope.viewer_bundle";
  schema_version: 1;
  producer: { package: "prefscope"; version: string };
  viewer: {
    package: "@prefscope/viewer";
    version: string;
    build: {
      path: "viewer-build.json";
      schema: "prefscope.viewer_build";
      schema_version: 1;
      supported_data_schemas: { schema: string; versions: number[] }[];
    };
    build_sha256: string;
  };
  data: {
    path: "data/viewer-data.json";
    schema: "prefscope.viewer_data";
    schema_version: 1;
  };
  files: ViewerBundleFile[];
}

function fail(path: string, message: string): never {
  throw new Error(`Invalid PrefScope viewer bundle at ${path}: ${message}`);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(path, "expected an object");
  return value as Record<string, unknown>;
}

function exactKeys(object: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  const missing = keys.filter((key) => !(key in object));
  if (missing.length) fail(path, `missing ${missing.join(", ")}`);
  const extra = Object.keys(object).filter((key) => !allowed.has(key));
  if (extra.length) fail(path, `unexpected ${extra.join(", ")}`);
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) fail(path, "expected a non-empty string");
  return value;
}

function sha256(value: unknown, path: string): string {
  const digest = nonEmptyString(value, path);
  if (!SHA256.test(digest)) fail(path, "expected a lowercase SHA-256 digest");
  return digest;
}

/** Validate the outer manifest against the exact Viewer version executing it. */
export function validateViewerBundleManifest(value: unknown, expectedViewerVersion: string): ViewerBundleManifest {
  const manifest = objectAt(value, "$");
  exactKeys(manifest, ["schema", "schema_version", "producer", "viewer", "data", "files"], "$");
  if (manifest.schema !== "prefscope.viewer_bundle") fail("$.schema", 'expected "prefscope.viewer_bundle"');
  if (manifest.schema_version !== 1) fail("$.schema_version", "only version 1 is supported");

  const producer = objectAt(manifest.producer, "$.producer");
  exactKeys(producer, ["package", "version"], "$.producer");
  if (producer.package !== "prefscope") fail("$.producer.package", 'expected "prefscope"');
  nonEmptyString(producer.version, "$.producer.version");

  const viewer = objectAt(manifest.viewer, "$.viewer");
  exactKeys(viewer, ["package", "version", "build", "build_sha256"], "$.viewer");
  if (viewer.package !== "@prefscope/viewer") fail("$.viewer.package", 'expected "@prefscope/viewer"');
  if (viewer.version !== expectedViewerVersion)
    fail("$.viewer.version", `expected the executing Viewer version ${expectedViewerVersion}`);
  sha256(viewer.build_sha256, "$.viewer.build_sha256");

  const build = objectAt(viewer.build, "$.viewer.build");
  exactKeys(build, ["path", "schema", "schema_version", "supported_data_schemas"], "$.viewer.build");
  if (build.path !== "viewer-build.json") fail("$.viewer.build.path", 'expected "viewer-build.json"');
  if (build.schema !== "prefscope.viewer_build") fail("$.viewer.build.schema", 'expected "prefscope.viewer_build"');
  if (build.schema_version !== 1) fail("$.viewer.build.schema_version", "only version 1 is supported");
  if (!Array.isArray(build.supported_data_schemas)) fail("$.viewer.build.supported_data_schemas", "expected an array");
  const supportsData = build.supported_data_schemas.some((raw, index) => {
    const item = objectAt(raw, `$.viewer.build.supported_data_schemas[${index}]`);
    if (typeof item.schema !== "string" || !Array.isArray(item.versions))
      fail(`$.viewer.build.supported_data_schemas[${index}]`, "expected schema and versions");
    return item.schema === "prefscope.viewer_data" && item.versions.includes(1);
  });
  if (!supportsData) fail("$.viewer.build.supported_data_schemas", "must support prefscope.viewer_data v1");

  const data = objectAt(manifest.data, "$.data");
  exactKeys(data, ["path", "schema", "schema_version"], "$.data");
  if (data.path !== "data/viewer-data.json") fail("$.data.path", 'expected "data/viewer-data.json"');
  if (data.schema !== "prefscope.viewer_data") fail("$.data.schema", 'expected "prefscope.viewer_data"');
  if (data.schema_version !== 1) fail("$.data.schema_version", "only version 1 is supported");

  if (!Array.isArray(manifest.files)) fail("$.files", "expected an array");
  const seen = new Set<string>();
  let dataFile: ViewerBundleFile | undefined;
  let hasIndex = false;
  let hasBuild = false;
  manifest.files.forEach((raw, index) => {
    const file = objectAt(raw, `$.files[${index}]`);
    exactKeys(file, ["path", "size_bytes", "sha256"], `$.files[${index}]`);
    const path = nonEmptyString(file.path, `$.files[${index}].path`);
    if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === ".."))
      fail(`$.files[${index}].path`, "expected a normalized relative POSIX path");
    if (seen.has(path)) fail("$.files", `duplicate path ${path}`);
    seen.add(path);
    if (!Number.isSafeInteger(file.size_bytes) || (file.size_bytes as number) < 0)
      fail(`$.files[${index}].size_bytes`, "expected a non-negative safe integer");
    const digest = sha256(file.sha256, `$.files[${index}].sha256`);
    const checked = { path, size_bytes: file.size_bytes as number, sha256: digest };
    if (path === "data/viewer-data.json") dataFile = checked;
    if (path === "index.html") hasIndex = true;
    if (path === "viewer-build.json") hasBuild = true;
  });
  if (seen.has("viewer-bundle.json")) fail("$.files", "must exclude viewer-bundle.json");
  if (!dataFile) fail("$.files", "missing data/viewer-data.json");
  if (!hasIndex) fail("$.files", "missing index.html");
  if (!hasBuild) fail("$.files", "missing viewer-build.json");
  return manifest as unknown as ViewerBundleManifest;
}

/** Verify and decode the exact data bytes declared by a validated outer manifest. */
export async function verifyViewerDataBytes(manifest: ViewerBundleManifest, bytes: ArrayBuffer): Promise<ViewerData> {
  const entry = manifest.files.find((file) => file.path === manifest.data.path);
  if (!entry) fail("$.files", `missing ${manifest.data.path}`);
  if (bytes.byteLength !== entry.size_bytes)
    throw new Error(`PrefScope viewer data size mismatch: expected ${entry.size_bytes}, got ${bytes.byteLength}`);
  if (!globalThis.crypto?.subtle)
    throw new Error("Web Crypto SHA-256 is required to verify PrefScope viewer data");
  const digest = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)))
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
  if (digest !== entry.sha256)
    throw new Error(`PrefScope viewer data checksum mismatch: expected ${entry.sha256}, got ${digest}`);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("failed to parse verified PrefScope viewer data as JSON"); }
  return validateViewerData(parsed);
}
