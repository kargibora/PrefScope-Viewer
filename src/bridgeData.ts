export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type AxisValue = JsonValue;

export interface ViewerSplitTable {
  index: AxisValue[];
  index_names: AxisValue[];
  columns: AxisValue[];
  column_names: AxisValue[];
  data: JsonValue[][];
}

export interface ViewerFeatureView {
  role: string;
  orientation: string;
  activation_polarity: string;
  code_semantics: string;
  values: (number | boolean)[][];
}

export interface ViewerFeatureSpace {
  feature_space_id: string | null;
  feature_space_status: "exact_weights" | "declared_pinned_coordinate" | "declared_unpinned" | "unbound";
}

export interface ViewerCatalog {
  table: ViewerSplitTable;
  feature_space: ViewerFeatureSpace;
  provenance: Record<string, JsonValue>;
  column_sources: Record<string, Record<string, JsonValue>>;
}

export interface ViewerData {
  schema: "prefscope.viewer_data";
  schema_version: 1;
  row_ids: string[];
  feature_ids: number[];
  feature_space: ViewerFeatureSpace;
  views: Record<string, ViewerFeatureView>;
  row_metadata: Record<string, JsonValue[]>;
  provenance: Record<string, JsonValue>;
  catalog: ViewerCatalog | null;
  tables: Record<string, ViewerSplitTable>;
}

export interface DecodedTableRow {
  index: AxisValue;
  values: JsonValue[];
}

export interface DecodedSplitTable {
  columns: AxisValue[];
  columnNames: AxisValue[];
  indexNames: AxisValue[];
  rows: DecodedTableRow[];
}

const TOP_LEVEL_KEYS = [
  "schema", "schema_version", "row_ids", "feature_ids", "feature_space", "views",
  "row_metadata", "provenance", "catalog", "tables",
] as const;
const VIEW_KEYS = [
  "role", "orientation", "activation_polarity", "code_semantics", "values",
] as const;
const TABLE_KEYS = ["index", "index_names", "columns", "column_names", "data"] as const;
const CATALOG_KEYS = ["table", "feature_space", "provenance", "column_sources"] as const;
const FEATURE_SPACE_KEYS = ["feature_space_id", "feature_space_status"] as const;
const CATALOG_COLUMNS = new Set([
  "feature_id", "name", "description", "source", "source_ref", "evidence_layer",
  "retrieval_status", "content_sha256",
]);

function fail(path: string, message: string): never {
  throw new Error(`Invalid PrefScope viewer data at ${path}: ${message}`);
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
  if (typeof value !== "string" || value.length === 0) fail(path, "expected a non-empty string");
  return value;
}

function nonBlankString(value: unknown, path: string): string {
  const checked = nonEmptyString(value, path);
  if (!checked.trim()) fail(path, "expected a non-blank string");
  return checked;
}

function jsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "numbers must be finite");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => jsonValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) =>
      jsonValue(item, `${path}.${key}`));
    return;
  }
  fail(path, "expected a JSON value");
}

function jsonObject(value: unknown, path: string): Record<string, JsonValue> {
  const object = objectAt(value, path);
  Object.entries(object).forEach(([key, item]) => jsonValue(item, `${path}.${key}`));
  return object as Record<string, JsonValue>;
}

function featureSpaceAt(value: unknown, path: string): ViewerFeatureSpace {
  const space = objectAt(value, path);
  exactKeys(space, FEATURE_SPACE_KEYS, path);
  const id = space.feature_space_id;
  const status = space.feature_space_status;
  const statuses = new Set([
    "exact_weights", "declared_pinned_coordinate", "declared_unpinned", "unbound",
  ]);
  if (id !== null && (typeof id !== "string" || !id.trim()))
    fail(`${path}.feature_space_id`, "expected a non-empty string or null");
  if (typeof status !== "string" || !statuses.has(status))
    fail(`${path}.feature_space_status`, "unknown feature-space status");
  if ((id === null) !== (status === "unbound"))
    fail(path, "unbound status and null identity must occur together");
  return space as unknown as ViewerFeatureSpace;
}

function axisValue(value: unknown, path: string): asserts value is AxisValue {
  jsonValue(value, path);
}

function validateAxis(values: unknown, names: unknown, path: string): AxisValue[] {
  if (!Array.isArray(values)) fail(path, "expected an array");
  values.forEach((value, index) => axisValue(value, `${path}[${index}]`));
  const typed = values as AxisValue[];
  if (!Array.isArray(names)) fail(`${path}.names`, "expected an array");
  names.forEach((name, index) => axisValue(name, `${path}.names[${index}]`));
  if (names.length === 0) fail(`${path}.names`, "expected at least one axis name");
  // Axis names preserve the level count even when a pandas MultiIndex axis is empty.
  const levels = names.length;
  typed.forEach((value, index) => {
    // With one level, an array can itself be a tuple-valued Index label. With a
    // MultiIndex, pandas split orientation uses one outer array item per level.
    if (levels > 1 && (!Array.isArray(value) || value.length !== levels)) {
      const actual = Array.isArray(value) ? value.length : 1;
      fail(`${path}[${index}]`, `expected ${levels} axis level(s), got ${actual}`);
    }
  });
  return typed;
}

function validateSplitTableAt(value: unknown, path: string): ViewerSplitTable {
  const table = objectAt(value, path);
  exactKeys(table, TABLE_KEYS, path);
  const index = validateAxis(table.index, table.index_names, `${path}.index`);
  const columns = validateAxis(table.columns, table.column_names, `${path}.columns`);
  if (!Array.isArray(table.data)) fail(`${path}.data`, "expected an array");
  if (table.data.length !== index.length)
    fail(`${path}.data`, `expected ${index.length} row(s), got ${table.data.length}`);
  table.data.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) fail(`${path}.data[${rowIndex}]`, "expected an array");
    if (row.length !== columns.length)
      fail(`${path}.data[${rowIndex}]`, `expected ${columns.length} value(s), got ${row.length}`);
    row.forEach((item, columnIndex) => jsonValue(item, `${path}.data[${rowIndex}][${columnIndex}]`));
  });
  return table as unknown as ViewerSplitTable;
}

/** Validate and return a schema-v1 bridge payload. Throws with a precise data path on failure. */
export function validateViewerData(value: unknown): ViewerData {
  const data = objectAt(value, "$.");
  exactKeys(data, TOP_LEVEL_KEYS, "$");
  if (data.schema !== "prefscope.viewer_data") fail("$.schema", 'expected "prefscope.viewer_data"');
  if (data.schema_version !== 1) fail("$.schema_version", "only version 1 is supported");

  if (!Array.isArray(data.row_ids) || data.row_ids.length === 0)
    fail("$.row_ids", "expected at least one row identifier");
  const rowIds = data.row_ids;
  rowIds.forEach((id, index) => nonEmptyString(id, `$.row_ids[${index}]`));
  if (new Set(rowIds).size !== rowIds.length) fail("$.row_ids", "identifiers must be unique");

  if (!Array.isArray(data.feature_ids) || data.feature_ids.length === 0)
    fail("$.feature_ids", "expected at least one feature identifier");
  const featureIds = data.feature_ids;
  featureIds.forEach((id, index) => {
    if (typeof id !== "number" || !Number.isSafeInteger(id)) fail(`$.feature_ids[${index}]`, "expected a safe integer");
  });
  if (new Set(featureIds).size !== featureIds.length) fail("$.feature_ids", "identifiers must be unique");
  const featureSpace = featureSpaceAt(data.feature_space, "$.feature_space");

  const views = objectAt(data.views, "$.views");
  if (!Object.keys(views).length) fail("$.views", "expected at least one feature view");
  Object.entries(views).forEach(([name, raw]) => {
    nonEmptyString(name, "$.views key");
    const view = objectAt(raw, `$.views.${name}`);
    exactKeys(view, VIEW_KEYS, `$.views.${name}`);
    for (const key of ["role", "orientation", "activation_polarity", "code_semantics"])
      nonBlankString(view[key], `$.views.${name}.${key}`);
    if (!Array.isArray(view.values) || view.values.length !== rowIds.length)
      fail(`$.views.${name}.values`, `expected ${rowIds.length} row(s)`);
    view.values.forEach((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== featureIds.length)
        fail(`$.views.${name}.values[${rowIndex}]`, `expected ${featureIds.length} feature value(s)`);
      row.forEach((item, columnIndex) => {
        if (typeof item !== "boolean" && (typeof item !== "number" || !Number.isFinite(item)))
          fail(`$.views.${name}.values[${rowIndex}][${columnIndex}]`, "expected a finite number or boolean");
      });
    });
  });

  const metadata = objectAt(data.row_metadata, "$.row_metadata");
  Object.entries(metadata).forEach(([name, values]) => {
    nonEmptyString(name, "$.row_metadata key");
    if (!Array.isArray(values) || values.length !== rowIds.length)
      fail(`$.row_metadata.${name}`, `expected ${rowIds.length} row-aligned value(s)`);
    values.forEach((item, index) => jsonValue(item, `$.row_metadata.${name}[${index}]`));
  });
  jsonObject(data.provenance, "$.provenance");

  if (data.catalog !== null) {
    const catalog = objectAt(data.catalog, "$.catalog");
    exactKeys(catalog, CATALOG_KEYS, "$.catalog");
    const catalogSpace = featureSpaceAt(catalog.feature_space, "$.catalog.feature_space");
    if (
      featureSpace.feature_space_id !== null
      && catalogSpace.feature_space_id !== null
      && featureSpace.feature_space_id !== catalogSpace.feature_space_id
    ) fail("$.catalog.feature_space", "does not match the exported feature space");
    const table = validateSplitTableAt(catalog.table, "$.catalog.table");
    if (!table.columns.every((column) => typeof column === "string"))
      fail("$.catalog.table.columns", "catalog column labels must be strings");
    if (!table.columns.includes("feature_id")) fail("$.catalog.table.columns", "missing feature_id");
    if (new Set(table.columns as string[]).size !== table.columns.length)
      fail("$.catalog.table.columns", "column labels must be unique");
    const unknownCatalogColumns = (table.columns as string[]).filter((column) => !CATALOG_COLUMNS.has(column));
    if (unknownCatalogColumns.length) fail("$.catalog.table.columns", `unsupported ${unknownCatalogColumns.join(", ")}`);
    const featureIdColumn = (table.columns as string[]).indexOf("feature_id");
    const catalogIds = new Set<number>();
    const exportedFeatureIds = new Set(featureIds as number[]);
    table.data.forEach((row, rowIndex) => {
      const featureId = row[featureIdColumn];
      if (typeof featureId !== "number" || !Number.isSafeInteger(featureId) || featureId < 0)
        fail(`$.catalog.table.data[${rowIndex}][${featureIdColumn}]`, "feature_id must be a non-negative safe integer");
      if (catalogIds.has(featureId)) fail("$.catalog.table", `duplicate feature_id ${featureId}`);
      if (!exportedFeatureIds.has(featureId))
        fail("$.catalog.table", `feature_id ${featureId} is outside the exported feature_ids`);
      catalogIds.add(featureId);
      row.forEach((item, columnIndex) => {
        if (columnIndex !== featureIdColumn && item !== null && typeof item !== "string")
          fail(`$.catalog.table.data[${rowIndex}][${columnIndex}]`, "catalog annotations must be strings or null");
      });
    });
    jsonObject(catalog.provenance, "$.catalog.provenance");
    const sources = objectAt(catalog.column_sources, "$.catalog.column_sources");
    Object.entries(sources).forEach(([name, source]) => {
      if (name === "feature_id" || !(table.columns as string[]).includes(name))
        fail(`$.catalog.column_sources.${name}`, "must name an annotation column in the catalog table");
      jsonObject(source, `$.catalog.column_sources.${name}`);
    });
  }

  const tables = objectAt(data.tables, "$.tables");
  Object.entries(tables).forEach(([name, table]) => {
    nonEmptyString(name, "$.tables key");
    validateSplitTableAt(table, `$.tables.${name}`);
  });
  return data as unknown as ViewerData;
}

/** Decode pandas orient="split" data without losing its index or multi-level axes. */
export function decodeSplitTable(table: ViewerSplitTable): DecodedSplitTable {
  // Validate independently so this public helper is safe with untrusted asserted inputs.
  const checked = validateSplitTableAt(table, "$table");
  return {
    columns: checked.columns.slice(),
    columnNames: checked.column_names.slice(),
    indexNames: checked.index_names.slice(),
    rows: checked.data.map((values, index) => ({ index: checked.index[index], values: values.slice() })),
  };
}
