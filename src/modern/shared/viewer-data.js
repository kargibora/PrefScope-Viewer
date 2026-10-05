const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

function object(value, where) {
  if (!isObject(value)) throw new Error(`${where} must be an object`);
  return value;
}
function nonempty(value, where) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a non-empty string`);
}
function table(value, where) {
  const result = object(value, where);
  if (!Array.isArray(result.columns) || !Array.isArray(result.index) || !Array.isArray(result.data))
    throw new Error(`${where} requires columns, index, and data arrays`);
  if (result.index.length !== result.data.length || result.data.some(row => !Array.isArray(row) || row.length !== result.columns.length))
    throw new Error(`${where} has inconsistent table dimensions`);
  return result;
}
export function tableRecords(value) {
  if (!value) return [];
  const keys = value.columns.map(column => typeof column === "string" ? column : JSON.stringify(column));
  if (new Set(keys).size !== keys.length) throw new Error("Table columns must be unique to convert to records");
  return value.data.map(row => Object.fromEntries(keys.map((key, index) => [key, row[index]])));
}
function identity(value, where) {
  const result = object(value, where);
  const bound = new Set(["exact_weights", "declared_pinned_coordinate", "declared_unpinned"]);
  if (result.feature_space_id === null) {
    if (result.feature_space_status !== "unbound") throw new Error(`${where} has an invalid unbound identity`);
  } else {
    nonempty(result.feature_space_id, `${where}.feature_space_id`);
    if (!bound.has(result.feature_space_status)) throw new Error(`${where} has an invalid bound status`);
  }
  return result;
}
function parseSpace(value, where) {
  const space = object(value, where);
  if (space.schema !== "prefscope.viewer_data" || ![1, 2].includes(space.schema_version))
    throw new Error(`${where} has an unsupported viewer data schema`);
  if (!Array.isArray(space.row_ids) || space.row_ids.some(id => typeof id !== "string" || !id.trim()) || new Set(space.row_ids).size !== space.row_ids.length)
    throw new Error(`${where}.row_ids must be unique non-empty strings`);
  if (!Array.isArray(space.feature_ids) || !space.feature_ids.length || space.feature_ids.some(id => !Number.isSafeInteger(id)) || new Set(space.feature_ids).size !== space.feature_ids.length)
    throw new Error(`${where}.feature_ids must be unique safe integers with positive width`);
  const featureSpace = identity(space.feature_space, `${where}.feature_space`);
  const rawViews = object(space.views, `${where}.views`);
  if (!Object.keys(rawViews).length) throw new Error(`${where}.views must not be empty`);
  const views = Object.create(null);
  const n = space.row_ids.length, width = space.feature_ids.length;
  for (const [name, rawView] of Object.entries(rawViews)) {
    nonempty(name, `${where}.views name`);
    const view = object(rawView, `${where}.views.${name}`);
    for (const key of ["role", "orientation", "activation_polarity", "code_semantics"])
      nonempty(view[key], `${where}.views.${name}.${key}`);
    if ((view.role === "response_a" && ["absolute_b", "model_b"].includes(view.orientation)) ||
        (view.role === "response_b" && ["absolute_a", "model_a"].includes(view.orientation)))
      throw new Error(`${where}.views.${name} has contradictory response role and orientation`);
    if (!Array.isArray(view.values) || view.values.length !== n) throw new Error(`${where}.views.${name} has an invalid row count`);
    const values = view.values.map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== width || row.some(x => typeof x !== "boolean" && (typeof x !== "number" || !Number.isFinite(x))))
        throw new Error(`${where}.views.${name}.values[${rowIndex}] must contain ${width} finite codes`);
      return row.some(x => typeof x === "boolean") ? row.map(Number) : row;
    });
    if (view.activation_polarity === "nonnegative" && values.some(row => row.some(x => x < 0)))
      throw new Error(`${where}.views.${name} declares nonnegative codes but contains negatives`);
    views[name] = { ...view, values };
  }
  const metadata = object(space.row_metadata, `${where}.row_metadata`);
  for (const [key, values] of Object.entries(metadata))
    if (!Array.isArray(values) || values.length !== n) throw new Error(`${where}.row_metadata.${key} must align with row_ids`);
  if (metadata.preference_probability?.some(value => value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)))
    throw new Error(`${where}.row_metadata.preference_probability must contain P(A) in [0,1] or null`);
  if (metadata.winner?.some(value => value != null && (typeof value !== "string" || !["a", "b", "tie"].includes(value.toLowerCase()))))
    throw new Error(`${where}.row_metadata.winner must contain a, b, tie, or null`);
  object(space.provenance, `${where}.provenance`);
  if (space.catalog !== null) {
    const catalog = object(space.catalog, `${where}.catalog`);
    const catalogSpace = identity(catalog.feature_space, `${where}.catalog.feature_space`);
    if (catalogSpace.feature_space_id !== null && featureSpace.feature_space_id !== null && catalogSpace.feature_space_id !== featureSpace.feature_space_id)
      throw new Error(`${where}.catalog feature-space identity does not match its codes`);
    const records = tableRecords(table(catalog.table, `${where}.catalog.table`));
    const known = new Set(space.feature_ids), ids = records.map(row => row.feature_id);
    if (!catalog.table.columns.includes("feature_id") || ids.some(id => !Number.isSafeInteger(id) || !known.has(id)) || new Set(ids).size !== ids.length)
      throw new Error(`${where}.catalog contains invalid, duplicate, or unknown feature IDs`);
    object(catalog.provenance, `${where}.catalog.provenance`);
    object(catalog.column_sources, `${where}.catalog.column_sources`);
  }
  object(space.tables, `${where}.tables`);
  for (const [name, value] of Object.entries(space.tables)) {
    nonempty(name, `${where}.tables name`);
    table(value, `${where}.tables.${name}`);
  }
  return { ...space, views };
}

export function parseViewerDataset(value) {
  const raw = object(value, "viewer-data.json");
  const dataset = parseSpace(value, "viewer-data.json");
  if (raw.prompt != null) {
    if (dataset.schema_version !== 2) throw new Error("prompt space requires viewer data schema v2");
    const prompt = parseSpace(raw.prompt, "viewer-data.json.prompt");
    if (prompt.schema_version !== 1 || Object.hasOwn(raw.prompt, "prompt")) throw new Error("prompt must be a non-recursive v1 space");
    if (prompt.row_ids.length !== dataset.row_ids.length || prompt.row_ids.some((id, index) => id !== dataset.row_ids[index]))
      throw new Error("prompt row_ids must match the response row order exactly");
    if (Object.values(prompt.views).some(view => view.role !== "prompt")) throw new Error("prompt space views must declare role prompt");
    dataset.prompt = prompt;
  } else if (Object.hasOwn(raw, "prompt")) dataset.prompt = null;
  validateKnownTables(dataset);
  return dataset;
}

function validateKnownTables(dataset) {
  const metadata = tableRecords(dataset.tables.example_umap_meta);
  const points = tableRecords(dataset.tables.example_umap_points);
  if (Boolean(dataset.tables.example_umap_meta) !== Boolean(dataset.tables.example_umap_points))
    throw new Error("Invalid UMAP export: both coordinate and metadata tables are required");
  const spaces = { main: dataset, prompt: dataset.prompt };
  for (const meta of metadata) {
    const space = spaces[meta.space];
    if (!space) throw new Error("Invalid UMAP export: unknown space");
    if (!Array.isArray(meta.views) || !meta.views.length || meta.views.some(name => !space.views[name]))
      throw new Error(`Invalid UMAP export: ${meta.projection_id} has unknown views`);
    if (!Array.isArray(meta.view_descriptors) || meta.view_descriptors.length !== meta.views.length || meta.view_descriptors.some(descriptor => {
      const view = space.views[descriptor?.view];
      return !view || descriptor.role !== view.role || descriptor.orientation !== view.orientation || descriptor.activation_polarity !== view.activation_polarity || descriptor.code_semantics !== view.code_semantics;
    })) throw new Error(`Invalid UMAP export: ${meta.projection_id} view descriptor mismatch`);
    if (meta.feature_space_id !== space.feature_space.feature_space_id || JSON.stringify(meta.feature_ids) !== JSON.stringify(space.feature_ids))
      throw new Error(`Invalid UMAP export: ${meta.projection_id} feature identity mismatch`);
    if (meta.row_order !== "row_major_view_order" || meta.n_rows !== dataset.row_ids.length || meta.n_features !== space.feature_ids.length || meta.n_points !== meta.n_rows * meta.views.length)
      throw new Error(`Invalid UMAP export: ${meta.projection_id} dimensions or row order mismatch`);
    if (meta.method !== "umap" || meta.basis !== "full_feature_activations" || meta.preprocessing !== "none")
      throw new Error(`Invalid UMAP export: ${meta.projection_id} is not an accepted UMAP`);
    const rows = points.filter(point => point.projection_id === meta.projection_id);
    if (rows.length !== meta.n_points) throw new Error(`Invalid UMAP export: ${meta.projection_id} point count mismatch`);
  }
}

export function exampleText(dataset, row, ...keys) {
  for (const key of keys) {
    const value = dataset.row_metadata[key]?.[row] ?? dataset.prompt?.row_metadata[key]?.[row];
    if (typeof value === "string") return value;
  }
}

export function exampleAnswerText(dataset, row, source) {
  if (!["response", "response_a", "response_b"].includes(source.view.role)) return undefined;
  const { role, orientation } = source.view;
  const side = role === "response_a" || ["absolute_a", "model_a"].includes(orientation) ? "a"
    : role === "response_b" || ["absolute_b", "model_b"].includes(orientation) ? "b" : null;
  if (!side) return exampleText(dataset, row, "response", "completion");
  const own = exampleText(dataset, row, `response_${side}`, `completion_${side}`);
  if (own !== undefined) return own;
  const opposite = side === "a" ? "b" : "a";
  const individualViews = Object.values(source.space.views).filter(view => ["response", "response_a", "response_b"].includes(view.role));
  return individualViews.length === 1 && exampleText(dataset, row, `response_${opposite}`, `completion_${opposite}`, `model_${opposite}`) === undefined
    ? exampleText(dataset, row, "response", "completion") : undefined;
}

export function exampleSources(dataset) {
  const spaces = [["main", dataset], ...(dataset.prompt ? [["prompt", dataset.prompt]] : [])];
  return spaces.flatMap(([spaceKey, space]) => {
    const catalog = new Map(tableRecords(space.catalog?.table).map(row => [row.feature_id, row]));
    const poleTable = dataset.tables[spaceKey === "prompt" ? "prompt_pole_labels" : "feature_pole_labels"];
    const poles = new Map(tableRecords(poleTable).map(row => [JSON.stringify([row.feature_id, row.pole]), row]));
    const features = space.feature_ids.map((id, column) => {
      const row = catalog.get(id), positivePole = poles.get(JSON.stringify([id, "positive"])), negativePole = poles.get(JSON.stringify([id, "negative"]));
      const positive = positivePole?.name ?? row?.positive_concept ?? row?.concept ?? row?.name;
      const negative = negativePole?.name ?? row?.negative_concept;
      return { id, column, label: typeof positive === "string" && positive.trim() ? positive : `Feature ${id} · unnamed`,
        negative: typeof negative === "string" && negative.trim() ? negative : undefined,
        positiveNamingStatus: positivePole?.naming_status,
        negativeNamingStatus: negativePole?.naming_status,
        positiveDescription: positivePole?.description ?? positivePole?.reason ?? row?.description,
        negativeDescription: negativePole?.description ?? negativePole?.reason,
        catalog: row };
    });
    return Object.entries(space.views).map(([viewName, view]) => ({
      key: JSON.stringify([spaceKey, viewName]), spaceKey, viewName, view, space, features,
      label: `${view.role === "prompt" ? "Prompt" : ["response", "response_a", "response_b"].includes(view.role) ? "Answer" : ["difference", "response_difference"].includes(view.role) ? "Pair contrast" : view.role} · ${viewName} · ${view.orientation}`,
    }));
  });
}

export function answerSide(source) {
  const { role, orientation } = source.view;
  return role === "response_a" || ["absolute_a", "model_a"].includes(orientation) ? "a"
    : role === "response_b" || ["absolute_b", "model_b"].includes(orientation) ? "b" : null;
}

export function modelIds(dataset) {
  return [...new Set(["model", "model_a", "model_b"].flatMap(key => (dataset.row_metadata[key] ?? []).filter(value => typeof value === "string" && value.trim())))].sort();
}
export function modelNames(dataset) {
  const names = new Map(modelIds(dataset).map(id => [id, id]));
  const meta = tableRecords(dataset.tables.paired_comparison_meta)[0];
  for (const side of ["a", "b"]) {
    const ids = new Set((dataset.row_metadata[`model_${side}`] ?? []).filter(id => typeof id === "string" && id));
    const name = meta?.[`side_${side}_name`];
    if (ids.size === 1 && typeof name === "string" && name.trim()) names.set([...ids][0], name);
  }
  return names;
}
