import { answerSide, exampleAnswerText, exampleSources, exampleText, tableRecords } from "./viewer-data.js";

export function buildMapProjections(dataset, sources = exampleSources(dataset)) {
  const definitions = [["prompt", "Prompt UMAP", ["prompt"]], ["answers", "Answer UMAP", ["response", "response_a", "response_b"]], ["pair", "Pair UMAP", ["difference", "response_difference"]]];
  const projections = definitions.map(([id, label, roles]) => ({ id, label, sources: sources.filter(source => roles.includes(source.view.role)), points: [], meta: null }))
    .filter(projection => projection.sources.length);
  const metadata = tableRecords(dataset.tables.example_umap_meta), coordinates = tableRecords(dataset.tables.example_umap_points);
  const fail = reason => { throw new Error(`Invalid UMAP export: ${reason}`); };
  const known = new Set(projections.map(projection => projection.id));
  if ([...metadata, ...coordinates].some(row => !known.has(row.projection_id))) fail("unknown projection ID");
  const rowIndex = new Map(dataset.row_ids.map((id, row) => [id, row]));
  for (const projection of projections) {
    const metaRows = metadata.filter(row => row.projection_id === projection.id);
    const pointRows = coordinates.filter(row => row.projection_id === projection.id);
    if (!metaRows.length && !pointRows.length) continue;
    if (metaRows.length !== 1) fail(`${projection.id} must have exactly one metadata row`);
    const meta = metaRows[0], space = projection.sources[0].space, spaceKey = space === dataset ? "main" : "prompt";
    const views = projection.sources.map(source => source.viewName);
    if (projection.sources.some(source => source.space !== space)) fail(`${projection.id} mixes feature spaces`);
    if (meta.method !== "umap" || meta.basis !== "full_feature_activations" || meta.preprocessing !== "none")
      fail(`${projection.id} is not UMAP of full feature activations without preprocessing`);
    if (meta.space !== spaceKey || meta.feature_space_id !== space.feature_space.feature_space_id ||
        JSON.stringify(meta.feature_ids) !== JSON.stringify(space.feature_ids) || !Array.isArray(meta.views) || meta.views.length !== views.length ||
        new Set(meta.views).size !== views.length || !views.every(view => meta.views.includes(view))) fail(`${projection.id} has inconsistent space, feature identity, or views`);
    if (meta.n_rows !== dataset.row_ids.length || meta.n_features !== space.feature_ids.length || meta.n_points !== dataset.row_ids.length * views.length || pointRows.length !== meta.n_points)
      fail(`${projection.id} does not cover every row and view`);
    for (const field of ["parameters", "versions"]) if (!meta[field] || typeof meta[field] !== "object" || Array.isArray(meta[field])) fail(`${projection.id} is missing ${field}`);
    if (typeof meta.input_hash !== "string" || !meta.input_hash.trim()) fail(`${projection.id} is missing its input hash`);
    const seen = new Set(); let zeroCount = 0;
    projection.points = pointRows.map(point => {
      const source = projection.sources.find(item => item.viewName === point.view), row = rowIndex.get(point.row_id);
      if (!source || row === undefined || point.space !== spaceKey) fail(`${projection.id} contains an unknown row, view, or space`);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) fail(`${projection.id} has non-finite coordinates`);
      const identity = JSON.stringify([point.row_id, source.viewName]);
      if (seen.has(identity)) fail(`${projection.id} contains a duplicate row/view point`);
      seen.add(identity);
      const zeroVector = source.view.values[row].every(value => value === 0);
      if (point.zero_vector !== zeroVector) fail(`${projection.id} has an inconsistent zero-vector flag`);
      if (zeroVector) zeroCount++;
      return { key: identity, row, rowId: point.row_id, source, x: point.x, y: point.y, zeroVector };
    });
    if (meta.n_zero_rows !== zeroCount) fail(`${projection.id} has an inconsistent zero-vector count`);
    projection.meta = meta;
  }
  return projections;
}

export function mapConcepts(sources) {
  const groups = [], used = new Set();
  for (const source of sources) {
    if (used.has(source.key)) continue;
    const side = answerSide(source);
    const compatible = sources.filter(item => item.space === source.space && answerSide(item) &&
      item.view.code_semantics === source.view.code_semantics && item.view.activation_polarity === source.view.activation_polarity);
    const group = side && compatible.length === 2 && new Set(compatible.map(answerSide)).size === 2 ? compatible : [source];
    group.forEach(item => used.add(item.key));
    groups.push(group);
  }
  return groups.flatMap(group => group[0].features.flatMap((feature, column) => {
    const label = feature.label === `Feature ${feature.id} · unnamed` ? `Unnamed concept ${column + 1}` : feature.label;
    const scope = group.length > 1 ? "Answer" : sourceLabel(group[0]);
    const base = { scope, featureId: feature.id, sources: group, column };
    const result = [{ ...base, label, pole: "positive", key: JSON.stringify([group[0].key, feature.id, "positive"]), namingStatus: feature.positiveNamingStatus }];
    if (group.some(source => source.view.activation_polarity === "signed")) result.push({ ...base, label: feature.negative ?? `Unnamed concept ${column + 1}`,
      pole: "negative", key: JSON.stringify([group[0].key, feature.id, "negative"]), namingStatus: feature.negativeNamingStatus });
    return result;
  }));
}
export function sourceLabel(source) {
  if (source.view.role === "prompt") return "Prompt";
  if (["difference", "response_difference"].includes(source.view.role)) return "Pair contrast";
  const side = answerSide(source);
  return side ? `Answer ${side.toUpperCase()}` : source.view.role === "response" ? "Answer" : source.view.role;
}
export function pointActivation(point, featureId, source = point.source) {
  const column = source.space.feature_ids.indexOf(featureId);
  return column < 0 ? null : source.view.values[point.row]?.[column] ?? null;
}
const layerActive = (value, layer) => value !== null && (layer.pole === "negative" ? value < 0 : value > 0);
export function pointMatchesLayers(point, layers) {
  return layers.every(layer => layer.sources.some(source => source.key === point.source.key) && layerActive(pointActivation(point, layer.featureId), layer));
}
export function searchMapPoints(dataset, points, layers = [], { query = "", selectedKeys } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return points.filter(point => {
    if (layers.length && !pointMatchesLayers(point, layers)) return false;
    if (selectedKeys && !selectedKeys.has(point.key)) return false;
    if (!needle) return true;
    const label = sourceLabel(point.source), side = answerSide(point.source);
    const texts = [point.rowId, label, exampleText(dataset, point.row, "prompt")];
    if (["response", "response_a", "response_b"].includes(point.source.view.role)) {
      texts.push(exampleAnswerText(dataset, point.row, point.source), exampleText(dataset, point.row, side ? `model_${side}` : "model"));
    } else {
      texts.push(exampleText(dataset, point.row, "response_a", "completion_a", "response", "completion"), exampleText(dataset, point.row, "response_b", "completion_b"),
        exampleText(dataset, point.row, "model_a", "model"), exampleText(dataset, point.row, "model_b"));
    }
    return texts.some(text => text?.toLocaleLowerCase().includes(needle));
  });
}
/** One layer provides sign-corrected activation. Multiple layers provide matching only. */
export function pointColorModel(point, layers, colorMax = 1) {
  const matches = pointMatchesLayers(point, layers);
  if (!matches) return { matches, mode: "outside", activation: null, color: "#a9b5ab", opacity: 0.55 };
  if (!layers.length || layers.length > 1) return { matches, mode: layers.length ? "match" : "generic", activation: null, color: "#528367", opacity: 1 };
  const value = pointActivation(point, layers[0].featureId);
  const activation = Math.max(0, (value ?? 0) * (layers[0].pole === "negative" ? -1 : 1));
  const lightness = 76 - 46 * Math.sqrt(activation / (colorMax || 1));
  return { matches, mode: "activation", activation, color: activation ? `hsl(151 33% ${lightness}%)` : "#c6cec7", opacity: 1 };
}
export function layerColorMaximum(points, layer) {
  return points.reduce((maximum, point) => Math.max(maximum, Math.max(0, (pointActivation(point, layer.featureId) ?? 0) * (layer.pole === "negative" ? -1 : 1))), 0);
}
export function mapPointState(point, matchingKeys, selectedKeys) {
  if (selectedKeys && !selectedKeys.has(point.key)) return "outside-selection";
  if (matchingKeys && !matchingKeys.has(point.key)) return "outside-highlights";
  return "current";
}
