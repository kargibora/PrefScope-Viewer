import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const viewerVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const identity = () => ({ feature_space_id: null, feature_space_status: "unbound" });
const view = (role, orientation, values, activation_polarity = "nonnegative") => ({ role, orientation, values, activation_polarity, code_semantics: "numerical_activity" });

export function genericFixture() {
  return {
    schema: "prefscope.viewer_data", schema_version: 1,
    row_ids: ["synthetic-1", "synthetic-2", "synthetic-3"], feature_ids: [3, 7],
    feature_space: identity(),
    views: { response: view("response", "absolute", [[1, 0], [0, 2], [3, 1]]) },
    row_metadata: { response: ["Synthetic first answer.", "Synthetic second answer.", "Synthetic third answer."], model: ["synthetic/one", "synthetic/two", "synthetic/one"] },
    provenance: { title: "Synthetic generic answers" }, catalog: null, tables: {},
  };
}

export function pairedFixture() {
  const data = genericFixture();
  return { ...data, schema_version: 2,
    views: { z_a: view("response_a", "absolute_a", [[1, 0], [0, 2], [3, 1]]), z_b: view("response_b", "absolute_b", [[0, 4], [2, 0], [0, 1]]) },
    row_metadata: {
      prompt: ["Synthetic prompt one.", "Synthetic prompt two.", "Synthetic prompt three."],
      response_a: ["Synthetic A one.", "Synthetic A two.", "Synthetic A three."],
      response_b: ["Synthetic B one.", "Synthetic B two.", "Synthetic B three."],
      model_a: ["synthetic/one", "synthetic/one", "synthetic/two"], model_b: ["synthetic/two", "synthetic/two", "synthetic/one"],
      preference_probability: [0, null, 1],
    },
    prompt: { ...genericFixture(), feature_ids: [12, 6], row_metadata: {},
      views: { z_prompt: view("prompt", "prompt", [[-1, 0], [2, 1], [-3, 1]], "signed") } },
  };
}

export const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value));
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export function artifacts(data = pairedFixture()) {
  const build = { schema: "prefscope.viewer_build", schema_version: 1, package: "@prefscope/viewer", version: viewerVersion,
    supported_data_schemas: [{ schema: "prefscope.viewer_data", versions: [1, 2] }] };
  const files = new Map([["data/viewer-data.json", jsonBytes(data)], ["viewer-build.json", jsonBytes(build)], ["index.html", new TextEncoder().encode("<!doctype html><title>Synthetic test</title>")]]);
  const bundle = { schema: "prefscope.viewer_bundle", schema_version: 1, producer: { package: "prefscope", version: "0.3.1" },
    viewer: { package: build.package, version: build.version, build: { path: "viewer-build.json", schema: build.schema, schema_version: build.schema_version, supported_data_schemas: build.supported_data_schemas },
      build_sha256: sha256(files.get("viewer-build.json")) },
    data: { path: "data/viewer-data.json", schema: data.schema, schema_version: data.schema_version },
    files: [...files].map(([path, bytes]) => ({ path, size_bytes: bytes.length, sha256: sha256(bytes) })) };
  const fetcher = async path => {
    const bytes = path === "viewer-bundle.json" ? jsonBytes(bundle) : files.get(path);
    return bytes ? { ok: true, arrayBuffer: async () => bytes.slice().buffer }
      : { ok: false, status: 404, statusText: "Not Found" };
  };
  return { data, build, bundle, files, fetcher };
}
