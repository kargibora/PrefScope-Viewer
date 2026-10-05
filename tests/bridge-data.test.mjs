import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BridgeViewer,
  decodeSplitTable,
  validateViewerBundleManifest,
  validateViewerData,
  verifyViewerDataBytes,
} from "../lib/index.js";

function split(columns, data, index = data.map((_, i) => i)) {
  return { index, index_names: [null], columns, column_names: [null], data };
}

function fixture() {
  return {
    schema: "prefscope.viewer_data",
    schema_version: 1,
    row_ids: ["row-a", "row-b"],
    feature_ids: [3, 7],
    feature_space: { feature_space_id: null, feature_space_status: "unbound" },
    views: {
      response: {
        role: "response",
        orientation: "absolute",
        activation_polarity: "nonnegative",
        code_semantics: "numerical_activity",
        values: [[1, 0], [0, 2]],
      },
    },
    row_metadata: { language: ["en", "de"] },
    provenance: { lens: { feature_space_status: "unbound" } },
    catalog: {
      table: split(["feature_id", "name", "description"], [[3, "Alpha", "First concept"], [7, "Beta", null]]),
      feature_space: { feature_space_id: null, feature_space_status: "unbound" },
      provenance: { feature_space_status: "unbound" },
      column_sources: {},
    },
    tables: {
      coactivation_pairs: split(
        ["feature_a", "feature_b", "count_both", "jaccard", "p_value"],
        [[3, 7, 12, 0.123456789012345, 0.00000123456789]],
        ["pair-1"],
      ),
    },
  };
}

test("bundle build declares exact compatibility and contains no stale public data", () => {
  const manifest = JSON.parse(readFileSync(new URL("../dist/viewer-build.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest, {
    schema: "prefscope.viewer_build",
    schema_version: 1,
    package: "@prefscope/viewer",
    version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
    supported_data_schemas: [{ schema: "prefscope.viewer_data", versions: [1, 2] }],
  });
  assert.equal(existsSync(new URL("../dist/data", import.meta.url)), false);
  const dist = new URL("../dist/", import.meta.url);
  const stack = [dist];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      if (entry.isDirectory()) stack.push(url);
      else assert.doesNotMatch(readFileSync(url, "utf8"), /evil\.invalid/);
    }
  }
});

test("bundle manifest pins the executing Viewer and verifies exact data bytes", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(fixture()));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const placeholder = "0".repeat(64);
  const raw = {
    schema: "prefscope.viewer_bundle",
    schema_version: 1,
    producer: { package: "prefscope", version: "0.2.0" },
    viewer: {
      package: "@prefscope/viewer",
      version: "0.1.0",
      build: {
        path: "viewer-build.json",
        schema: "prefscope.viewer_build",
        schema_version: 1,
        supported_data_schemas: [{ schema: "prefscope.viewer_data", versions: [1] }],
      },
      build_sha256: placeholder,
    },
    data: {
      path: "data/viewer-data.json",
      schema: "prefscope.viewer_data",
      schema_version: 1,
    },
    files: [
      { path: "index.html", size_bytes: 1, sha256: placeholder },
      { path: "viewer-build.json", size_bytes: 1, sha256: placeholder },
      { path: "data/viewer-data.json", size_bytes: bytes.byteLength, sha256: digest },
    ],
  };
  const manifest = validateViewerBundleManifest(raw, "0.1.0");
  const data = await verifyViewerDataBytes(manifest, bytes.buffer);
  assert.deepEqual(data.row_ids, ["row-a", "row-b"]);
  assert.throws(
    () => validateViewerBundleManifest(raw, "0.1.1"),
    /expected the executing Viewer version 0.1.1/,
  );
  const corrupted = bytes.slice();
  corrupted[0] ^= 1;
  await assert.rejects(
    verifyViewerDataBytes(manifest, corrupted.buffer),
    /checksum mismatch/,
  );
});

test("built library validates and decodes an export.py payload", () => {
  const data = validateViewerData(fixture());
  const table = decodeSplitTable(data.tables.coactivation_pairs);
  assert.deepEqual(table.columns, ["feature_a", "feature_b", "count_both", "jaccard", "p_value"]);
  assert.deepEqual(table.rows[0], {
    index: "pair-1",
    values: [3, 7, 12, 0.123456789012345, 0.00000123456789],
  });
});

test("split decoder preserves multi-level column labels and axis names", () => {
  const table = {
    index: [3],
    index_names: ["feature_left"],
    columns: [["left", 1], ["right", 2]],
    column_names: ["side", "feature_id"],
    data: [[4, 9]],
  };
  const decoded = decodeSplitTable(table);
  assert.deepEqual(decoded.columnNames, ["side", "feature_id"]);
  assert.deepEqual(decoded.columns, [["left", 1], ["right", 2]]);

  const tupleIndex = decodeSplitTable({
    index: [["group", 3]],
    index_names: [null],
    columns: ["value"],
    column_names: [null],
    data: [[1]],
  });
  assert.deepEqual(tupleIndex.rows[0].index, ["group", 3]);

  const intervalIndex = decodeSplitTable({
    index: [{ closed: "right", closed_right: true, left: 0, right: 1 }],
    index_names: [null],
    columns: ["value"],
    column_names: [null],
    data: [[1]],
  });
  assert.deepEqual(intervalIndex.rows[0].index, { closed: "right", closed_right: true, left: 0, right: 1 });
});

test("validator rejects feature identifiers that JSON cannot preserve", () => {
  const value = fixture();
  value.feature_ids[0] = 2 ** 60;
  assert.throws(() => validateViewerData(value), /expected a safe integer/);
});

test("validator rejects a matrix that is not aligned to IDs", () => {
  const value = fixture();
  value.views.response.values[0] = [1];
  assert.throws(() => validateViewerData(value), /expected 2 feature value/);
});

test("validator rejects corrupted catalog identities and column sources", () => {
  const duplicate = fixture();
  duplicate.catalog.table.data[1][0] = 3;
  assert.throws(() => validateViewerData(duplicate), /duplicate feature_id 3/);

  const outside = fixture();
  outside.catalog.table.data[1][0] = 99;
  assert.throws(() => validateViewerData(outside), /outside the exported feature_ids/);

  const mismatchedSpace = fixture();
  mismatchedSpace.feature_space = {
    feature_space_id: "sha256:batch",
    feature_space_status: "exact_weights",
  };
  mismatchedSpace.catalog.feature_space = {
    feature_space_id: "sha256:catalog",
    feature_space_status: "exact_weights",
  };
  assert.throws(() => validateViewerData(mismatchedSpace), /does not match the exported feature space/);

  const badSource = fixture();
  badSource.catalog.column_sources.feature_id = { kind: "invalid" };
  assert.throws(() => validateViewerData(badSource), /must name an annotation column/);
});

test("validator rejects unknown fields rather than guessing a schema", () => {
  const value = { ...fixture(), schema_version: 2, extra: true };
  assert.throws(() => validateViewerData(value), /unexpected extra/);
});

test("built BridgeViewer server-renders catalog and coactivation navigation", () => {
  const html = renderToStaticMarkup(React.createElement(BridgeViewer, { data: validateViewerData(fixture()) }));
  assert.match(html, /Viewer data bridge/);
  assert.match(html, /Feature catalog/);
  assert.match(html, /Coactivation Pairs/);
  assert.match(html, /2 rows/);
});
