import { datasetChecks, datasetInventory } from "./dataset.js";
import { buildMapProjections } from "./maps.js";
import {
  compareAnswerActivity, comparePromptScores, modelDistribution, modelNames, modelAnswers,
  modelPreferenceAssociations, pooledAnswerSources, conceptStrength, modelConceptActive, modelOutcome, modelPopulation, modelPairs, outcomeSummary,
} from "./models.js";
import {
  checkedRelationshipResults, conceptChoices, conceptKind, conceptLabelState, conceptPreference, conceptSupport, defaultConcept,
  inspectActivations, matchingObservations, observationKey, rankRelationships, relationshipGroups,
} from "./observations.js";
import { exampleAnswerText, exampleSources, exampleText, modelIds, parseViewerDataset } from "./viewer-data.js";

async function loadJson(url, fetcher) {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { value: JSON.parse(new TextDecoder().decode(bytes)), bytes };
}
async function sha256(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error("createEngine requires Web Crypto SHA-256 support");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}
function validateManifestFile(bundle, path, bytes, hash, label) {
  const entry = bundle.files?.find(item => item.path === path);
  if (!entry || entry.sha256 !== hash || entry.size_bytes !== bytes.byteLength)
    throw new Error(`${label} does not match viewer-bundle.json`);
}
function answerTextShards(raw, dataset, bundle) {
  const descriptor = raw.answer_text_shards;
  if (descriptor === undefined) return null;
  const invalid = () => { throw new Error("Invalid answer text shard descriptor"); };
  const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  if (!exactKeys(descriptor, ["schema", "schema_version", "files"]) ||
      descriptor.schema !== "prefscope.viewer_answer_text_shards" || descriptor.schema_version !== 1 || !Array.isArray(descriptor.files) ||
      !Array.isArray(dataset.row_metadata.response_a) || dataset.row_metadata.response_a.some(text => text !== null) ||
      descriptor.files.length !== Math.ceil(dataset.row_ids.length / 128)) invalid();
  const paths = new Set();
  descriptor.files.forEach((file, index) => {
    const start = index * 128;
    if (!exactKeys(file, ["start", "end", "path"]) || file.start !== start || file.end !== Math.min(start + 128, dataset.row_ids.length) ||
        typeof file.path !== "string" || !file.path.startsWith("data/answer-text/") || !bundle.files.some(item => item.path === file.path) || paths.has(file.path)) invalid();
    paths.add(file.path);
  });
  return descriptor.files;
}
function validateArtifacts(dataset, bundle, build, dataArtifact, buildArtifact, expectedViewerVersion) {
  const fail = message => { throw new Error(`Invalid PrefScope viewer bundle: ${message}`); };
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = value => typeof value === "string" && value.trim().length > 0;
  const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  const keys = (value, expected, label) => {
    if (!object(value) || Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key)))
      fail(`${label} has invalid fields`);
  };
  const supported = value => Array.isArray(value) && value.length > 0 && value.every(item => object(item) &&
    text(item.schema) && Array.isArray(item.versions) && item.versions.length > 0 && item.versions.every(version => Number.isSafeInteger(version) && version > 0));
  keys(bundle, ["schema", "schema_version", "producer", "viewer", "data", "files"], "manifest");
  if (bundle.schema !== "prefscope.viewer_bundle" || bundle.schema_version !== 1) fail("unsupported manifest schema");
  keys(bundle.producer, ["package", "version"], "producer");
  if (bundle.producer.package !== "prefscope" || !text(bundle.producer.version)) fail("invalid producer identity");
  keys(bundle.viewer, ["package", "version", "build", "build_sha256"], "viewer");
  if (bundle.viewer.package !== "@prefscope/viewer" || !text(bundle.viewer.version) || !digest(bundle.viewer.build_sha256))
    fail("invalid viewer identity or build digest");
  if (expectedViewerVersion !== undefined && bundle.viewer.version !== expectedViewerVersion)
    fail(`expected the executing Viewer version ${expectedViewerVersion}`);
  keys(bundle.data, ["path", "schema", "schema_version"], "data");
  if (bundle.data.path !== "data/viewer-data.json" || bundle.data.schema !== dataset.schema || bundle.data.schema_version !== dataset.schema_version)
    fail("manifest does not describe the loaded viewer data");
  const declared = bundle.viewer.build;
  keys(declared, ["path", "schema", "schema_version", "supported_data_schemas"], "viewer.build");
  if (declared.path !== "viewer-build.json" || declared.schema !== "prefscope.viewer_build" || declared.schema_version !== 1 || !supported(declared.supported_data_schemas))
    fail("invalid declared build contract");
  if (!object(build) || build.schema !== declared.schema || build.schema_version !== declared.schema_version ||
      build.package !== bundle.viewer.package || build.version !== bundle.viewer.version || !supported(build.supported_data_schemas) ||
      JSON.stringify(build.supported_data_schemas) !== JSON.stringify(declared.supported_data_schemas))
    fail("viewer-build.json identity or compatibility differs from the manifest");
  if (!build.supported_data_schemas.some(item => item.schema === dataset.schema && item.versions.includes(dataset.schema_version)))
    fail("viewer-build.json does not support the loaded viewer data");
  if (!Array.isArray(bundle.files)) fail("files must be an array");
  const seen = new Set();
  for (const file of bundle.files) {
    keys(file, ["path", "size_bytes", "sha256"], "file");
    if (!text(file.path) || file.path.startsWith("/") || file.path.includes("\\") || file.path.includes(":") ||
        /[\u0000-\u001f]/.test(file.path) || file.path.split("/").some(part => ["", ".", ".."].includes(part)))
      fail("files require normalized relative POSIX paths");
    if (seen.has(file.path)) fail(`duplicate file path ${file.path}`);
    seen.add(file.path);
    if (!Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0 || !digest(file.sha256)) fail(`invalid size or digest for ${file.path}`);
  }
  if (seen.has("viewer-bundle.json")) fail("files must exclude viewer-bundle.json");
  for (const path of ["index.html", "viewer-build.json", "data/viewer-data.json"])
    if (!seen.has(path)) fail(`missing ${path}`);
  validateManifestFile(bundle, bundle.data.path, dataArtifact.bytes, dataArtifact.hash, "viewer-data.json");
  validateManifestFile(bundle, declared.path, buildArtifact.bytes, buildArtifact.hash, "viewer-build.json");
}

function histogramCounts(magnitudes, maximum) {
  const counts = Array(8).fill(0);
  const boundaries = Array.from({ length: 7 }, (_, index) => maximum * (index + 1) / 8);
  if (maximum > 0) for (const magnitude of magnitudes) {
    let bin = 0;
    while (bin < boundaries.length && magnitude >= boundaries[bin]) bin++;
    counts[bin]++;
  }
  return counts;
}
function histogramPopulation(magnitudes, total, available) {
  const maxMagnitude = magnitudes.length ? Math.max(...magnitudes) : 0;
  const counts = histogramCounts(magnitudes, maxMagnitude);
  const sorted = [...magnitudes].sort((a, b) => a - b);
  const boundaries = Array.from({ length: 5 }, (_, index) => {
    if (!sorted.length) return 0;
    const position = (sorted.length - 1) * index / 4, lower = Math.floor(position), fraction = position - lower;
    return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * fraction;
  });
  const quartiles = boundaries.slice(0, 4).map((x0, index) => {
    const x1 = boundaries[index + 1], includeMax = index === 3;
    return { x0, x1, count: sorted.filter(value => value >= x0 && (value < x1 || includeMax && value === x1)).length, includeMax };
  });
  return { available, total, active: magnitudes.length, magnitudes, quartiles,
    bins: counts.map((count, index) => ({ x0: maxMagnitude * index / 8, x1: maxMagnitude * (index + 1) / 8, count })),
    maxMagnitude, maxBinCount: Math.max(0, ...counts) };
}

/** Load the three public artifacts and expose the compact API used by the Design V2 shell. */
export async function createEngine({ dataUrl, bundleUrl, buildUrl, expectedViewerVersion, fetcher = globalThis.fetch }) {
  if (typeof fetcher !== "function") throw new Error("createEngine requires fetch");
  const [dataArtifact, bundleArtifact, buildArtifact] = await Promise.all([
    loadJson(dataUrl, fetcher), loadJson(bundleUrl, fetcher), loadJson(buildUrl, fetcher),
  ]);
  const [dataHash, buildHash] = await Promise.all([sha256(dataArtifact.bytes), sha256(buildArtifact.bytes)]);
  dataArtifact.hash = dataHash; buildArtifact.hash = buildHash;
  const dataset = parseViewerDataset(dataArtifact.value), bundle = bundleArtifact.value, build = buildArtifact.value;
  validateArtifacts(dataset, bundle, build, dataArtifact, buildArtifact, expectedViewerVersion);
  const shards = answerTextShards(dataArtifact.value, dataset, bundle);
  if (shards && !dataUrl.endsWith(bundle.data.path)) throw new Error("Sharded viewer data URL must end with the manifest data path");
  const loadedShards = new Set(), pendingShards = new Map();
  function hasFullAnswer(rowIndex) {
    return Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < dataset.row_ids.length &&
      (!shards || loadedShards.has(Math.floor(rowIndex / 128)));
  }
  async function loadShard(index) {
    if (loadedShards.has(index)) return;
    if (!pendingShards.has(index)) {
      const file = shards[index];
      const pending = (async () => {
        const artifact = await loadJson(dataUrl.slice(0, -bundle.data.path.length) + file.path, fetcher);
        validateManifestFile(bundle, file.path, artifact.bytes, await sha256(artifact.bytes), file.path);
        const shard = artifact.value, count = file.end - file.start;
        if (shard === null || typeof shard !== "object" || Array.isArray(shard) ||
            Object.keys(shard).length !== 3 || !["start", "row_ids", "texts"].every(key => Object.hasOwn(shard, key)) ||
            shard.start !== file.start || !Array.isArray(shard.row_ids) || shard.row_ids.length !== count ||
            shard.row_ids.some((id, offset) => id !== dataset.row_ids[file.start + offset]) ||
            !Array.isArray(shard.texts) || shard.texts.length !== count ||
            shard.texts.some(text => text !== null && typeof text !== "string"))
          throw new Error(`Invalid answer text shard ${file.path}: row identity or text mismatch`);
        dataset.row_metadata.response_a.splice(file.start, count, ...shard.texts);
        loadedShards.add(index);
      })();
      pendingShards.set(index, pending);
      pending.finally(() => pendingShards.delete(index)).catch(() => {});
    }
    return pendingShards.get(index);
  }
  function ensureAnswerTexts(rowIndices) {
    if (!Array.isArray(rowIndices) || rowIndices.some(row => !Number.isInteger(row) || row < 0 || row >= dataset.row_ids.length))
      return Promise.reject(new Error("Answer text row indices must be valid dataset rows"));
    return shards ? Promise.all([...new Set(rowIndices.map(row => Math.floor(row / 128)))].map(loadShard)).then(() => {}) : Promise.resolve();
  }
  async function ensureAllAnswerTexts() {
    if (!shards) return;
    for (let index = 0; index < shards.length; index += 4)
      await Promise.all(shards.slice(index, index + 4).map((_, offset) => loadShard(index + offset)));
  }
  const inventory = datasetInventory(dataset);
  if (inventory.banks.prompt.length > 1 || inventory.banks.answer.length > 1 || inventory.banks.pair.length > 1)
    throw new Error("The Viewer requires at most one measurement group per prompt, answer, and pair lens");

  const choices = engineChoices(dataset), prompt = choices.filter(item => conceptKind(item.choice) === "prompt");
  const answer = choices.filter(item => item.choice.source.view.role !== "prompt" && !["difference", "response_difference"].includes(item.choice.source.view.role));
  const pair = choices.filter(item => item.source === "pair"), pairByKey = new Map(pair.map(item => [item.key, item]));
  const promptByKey = new Map(prompt.map(item => [item.key, item])), answerByKey = new Map(answer.map(item => [item.key, item]));
  const conceptByKey = new Map(choices.map(item => [item.key, item]));
  const sources = exampleSources(dataset), answerSources = pooledAnswerSources(dataset);
  const sourceA = answerSources.find(source => source.view.role === "response_a" || ["model_a", "absolute_a"].includes(source.view.orientation))
    ?? (answerSources.length === 1 && answerSources[0].view.role === "response" && !["model_b", "absolute_b"].includes(answerSources[0].view.orientation) ? answerSources[0] : undefined);
  const sourceB = answerSources.find(source => source.view.role === "response_b" || ["model_b", "absolute_b"].includes(source.view.orientation));
  const pairSource = sources.find(source => ["difference", "response_difference"].includes(source.view.role));
  const names = modelNames(dataset);
  const modelRegistry = modelIds(dataset).map(rawId => ({ rawId, name: names.get(rawId) ?? rawId }));
  const modelById = new Map(modelRegistry.map(model => [model.rawId, model]));
  const answerObservations = modelAnswers(dataset, dataset.row_ids.map((_, row) => row), answerSources);
  const observationModels = new Map(answerObservations.map(item => [observationKey(item.row, item.source), item.model]));
  const answerModels = [...new Set(answerObservations.map(item => item.model))].sort().map(rawId => ({ rawId, name: names.get(rawId) ?? rawId }));
  const answerModelById = new Map(answerModels.map(model => [model.rawId, model]));
  const sideIds = side => new Set((dataset.row_metadata[`model_${side}`] ?? []).filter(value => typeof value === "string" && value.trim()));
  const aIds = sideIds("a"), bIds = sideIds("b");
  const rawA = sourceA && aIds.size === 1 ? [...aIds][0] : undefined, rawB = sourceB && bIds.size === 1 ? [...bIds][0] : undefined;
  const models = [rawA && { side: "a", name: names.get(rawA) ?? rawA, rawId: rawA, view: sourceA.viewName },
    rawB && { side: "b", name: names.get(rawB) ?? rawB, rawId: rawB, view: sourceB.viewName }].filter(Boolean);
  const projections = buildMapProjections(dataset, sources);
  const projection = id => projections.find(item => item.id === id);
  const mapPoints = id => (projection(id)?.points ?? []).map(point => ({ ...facadeObservation(point),
    row_id: point.rowId, pointKey: point.key, x: point.x, y: point.y, zero_vector: point.zeroVector,
  }));
  const pointIndex = new Map(dataset.row_ids.map((id, row) => [id, row]));
  const promptMeasurements = inventory.banks.prompt[0] ?? { rows: [], total: 0 };
  const answerMeasurements = inventory.banks.answer[0] ?? { rows: [], total: 0 };
  const pairMeasurements = inventory.banks.pair[0] ?? { rows: [], total: 0 };
  const health = datasetChecks(dataset);

  function resolve(items, keys) { return keys.map(key => items.get(key)?.choice).filter(Boolean); }
  function record(index) {
    const modelAt = (side, source) => {
      const model = source ? answerModelById.get(observationModels.get(observationKey(index, source)))
        : pairSource && modelById.get(exampleText(dataset, index, `model_${side}`));
      return model ? { ...model, side, view: source?.viewName ?? null } : undefined;
    };
    return { index, rowId: dataset.row_ids[index], prompt: exampleText(dataset, index, "prompt"),
      answerA: sourceA ? exampleAnswerText(dataset, index, sourceA) : pairSource && exampleText(dataset, index, "response_a", "completion_a"),
      answerB: sourceB ? exampleAnswerText(dataset, index, sourceB) : pairSource && exampleText(dataset, index, "response_b", "completion_b"),
      preferenceA: sourceA || pairSource ? conceptPreference(dataset, index, sourceA) : null,
      preferenceB: sourceB ? conceptPreference(dataset, index, sourceB) : pairSource && conceptPreference(dataset, index) !== null ? 1 - conceptPreference(dataset, index) : null,
      modelA: modelAt("a", sourceA), modelB: modelAt("b", sourceB), judge: exampleText(dataset, index, "judge") };
  }
  function activationItems(index, owner, focusedKey) {
    const source = owner === "prompt" ? sources.find(item => item.view.role === "prompt") : owner === "pair" ? pairSource : owner === "a" ? sourceA : sourceB;
    if (!source) return [];
    const catalog = owner === "prompt" ? promptByKey : owner === "pair" ? pairByKey : answerByKey, focused = catalog.get(focusedKey);
    const requests = focused ? [{ featureId: focused.featureId, pole: focused.pole, label: focused.name,
      sourceKeys: focused.choice.sources.map(item => item.key) }] : [];
    const items = inspectActivations(source, index, requests).entries.map(item => {
      const key = owner === "prompt" || owner === "pair" ? `${owner}:${item.featureId}:${item.pole}` : `answer:${item.featureId}`;
      const concept = catalog.get(key);
      return { ...(concept ?? {}), key, name: concept?.name ?? item.label, featureId: item.featureId, pole: item.pole,
        value: item.state === "active" ? item.magnitude : null, rawValue: item.value, state: item.state, active: item.state === "active" };
    }).sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
    const focus = items.findIndex(item => item.key === focusedKey);
    if (focus > 0) items.unshift(items.splice(focus, 1)[0]);
    return items;
  }
  const sameSource = (left, right) => Boolean(left && right && left.key === right.key);
  const facadeObservation = item => {
    const side = sameSource(item.source, sourceB) ? "b" : sameSource(item.source, sourceA) ? "a" : null;
    const modelId = observationModels.get(observationKey(item.row, item.source)) ?? null;
    const lens = item.source.view.role === "prompt" ? "prompt" : ["difference", "response_difference"].includes(item.source.view.role) ? "pair" : "answer";
    return { rowIndex: item.row, rowId: item.rowId, side, sourceKey: item.source.key, view: item.source.viewName,
      lens, unit: lens === "pair" ? "pairs" : lens === "prompt" ? "prompts" : "answers",
      role: item.source.view.role, orientation: item.source.view.orientation, modelId,
      observationKey: observationKey(item.row, item.source), cursor: { row_id: item.rowId, source: item.source.key } };
  };
  function observation(index, owner) {
    const source = owner === "prompt" ? sources.find(item => item.view.role === "prompt") : owner === "pair" ? pairSource : owner === "a" ? sourceA : owner === "b" ? sourceB : null;
    return source && Number.isInteger(index) && index >= 0 && index < dataset.row_ids.length
      ? facadeObservation({ row: index, rowId: dataset.row_ids[index], source }) : null;
  }
  function filterPromptObservations(keys) {
    const selected = resolve(promptByKey, keys), focused = selected[0] ?? defaultConcept(dataset, "prompt", choices.map(item => item.choice));
    return focused ? matchingObservations(dataset, selected.length ? selected : [focused], focused).map(facadeObservation) : [];
  }
  function filterPrompt(keys) { return filterPromptObservations(keys).map(item => item.rowIndex); }
  function matchesAnswerModel(item, model) {
    if (model === "all") return true;
    if (model === "a" || model === "b") return sameSource(item.source, model === "a" ? sourceA : sourceB);
    return typeof model === "string" && model.startsWith("model:") &&
      observationModels.get(observationKey(item.row, item.source)) === model.slice(6);
  }
  function filterAnswers(keys, model = "all") {
    if (keys.some(key => pairByKey.has(key) || promptByKey.has(key))) return [];
    const selected = resolve(answerByKey, keys), focused = selected[0] ?? defaultConcept(dataset, "answer", answer.map(item => item.choice));
    if (!focused) return [];
    return matchingObservations(dataset, selected.length ? selected : [focused], focused)
      .filter(item => matchesAnswerModel(item, model)).map(facadeObservation);
  }
  function matchesPairModel(row, model) {
    return model === "all" || typeof model === "string" && model.startsWith("model:") &&
      [exampleText(dataset, row, "model_a"), exampleText(dataset, row, "model_b")].includes(model.slice(6));
  }
  function filterPairs(keys, model = "all") {
    const selected = resolve(pairByKey, keys), focused = selected[0] ?? defaultConcept(dataset, "answer", pair.map(item => item.choice));
    if (!focused || keys.some(key => !pairByKey.has(key))) return [];
    return matchingObservations(dataset, selected.length ? selected : [focused], focused)
      .filter(item => matchesPairModel(item.row, model)).map(facadeObservation);
  }
  const promptCounts = new Map(prompt.map(concept => [concept.key, concept.count]));
  const answerCounts = new Map([["all", new Map(answer.map(concept => [concept.key, concept.count]))]]);
  function conceptCounts(source, model = "all") {
    if (source === "prompt") return new Map(promptCounts);
    if (source === "pair") return new Map(pair.map(concept => [concept.key, model === "all" ? concept.count : filterPairs([concept.key], model).length]));
    if (source !== "answer") return new Map();
    if (!answerCounts.has(model)) {
      const counts = new Map([...answerByKey.keys()].map(key => [key, 0]));
      if (!["a", "b"].includes(model) && !(typeof model === "string" && model.startsWith("model:") && answerModelById.has(model.slice(6))))
        return counts;
      for (const source of answerSources) {
        const columns = source.space.feature_ids.map(featureId => {
          const concept = answerByKey.get(`answer:${featureId}`);
          return concept?.choice.sources.some(item => item.key === source.key) ? concept : null;
        });
        source.view.values.forEach((values, row) => {
          if (!matchesAnswerModel({ row, source }, model)) return;
          columns.forEach((concept, column) => {
            if (concept && values[column] * (concept.pole === "negative" ? -1 : 1) > 0)
              counts.set(concept.key, counts.get(concept.key) + 1);
          });
        });
      }
      answerCounts.set(model, counts);
    }
    return new Map(answerCounts.get(model));
  }
  function observationCursor(observation) {
    return observation?.rowId && observation?.sourceKey ? { row_id: observation.rowId, source: observation.sourceKey } : null;
  }
  function observationStrengths(observations, key) {
    const choice = conceptByKey.get(key)?.choice;
    const sign = choice?.pole === "negative" ? -1 : 1;
    const views = new Map(choice?.sources.map(source => [source.key, source.view.values]) ?? []);
    return new Map(observations.map(item => {
      const value = views.get(item.sourceKey)?.[item.rowIndex]?.[choice?.column];
      return [item.observationKey, Number.isFinite(value) ? Math.max(0, value * sign) : null];
    }));
  }
  function sortObservations(observations, key, order = "dataset") {
    if (!conceptByKey.has(key) || !["strongest", "weakest"].includes(order)) return observations;
    const strengths = observationStrengths(observations, key);
    return observations.map(item => ({ item, strength: strengths.get(item.observationKey) }))
      .sort((a, b) => a.strength === null ? (b.strength === null ? 0 : 1) : b.strength === null ? -1
      : (a.strength - b.strength) * (order === "strongest" ? -1 : 1)).map(({ item }) => item);
  }
  function filterActivationRange(observations, key, range) {
    const concept = conceptByKey.get(key);
    if (!concept || !Number.isFinite(range?.min) || !Number.isFinite(range?.max) || range.min > range.max) return [];
    const choice = concept.choice, sign = choice.pole === "negative" ? -1 : 1;
    const views = new Map(choice.sources.map(source => [source.key, source.view.values]));
    return observations.filter(item => {
      if (!item || !Number.isInteger(item.rowIndex) || dataset.row_ids[item.rowIndex] !== item.rowId) return false;
      const value = views.get(item.sourceKey)?.[item.rowIndex]?.[choice.column];
      const magnitude = Number.isFinite(value) ? value * sign : null;
      return magnitude > 0 && magnitude >= range.min && (magnitude < range.max || range.includeMax === true && magnitude === range.max);
    });
  }
  function pageObservationResults(observations, cursor, movement = 0) {
    if (!observations.length) return { index: -1, total: 0, current: null, cursor: null };
    let index = cursor ? observations.findIndex(item => item.rowId === cursor.row_id && item.sourceKey === cursor.source) : -1;
    if (index < 0) index = 0;
    index = Math.max(0, Math.min(observations.length - 1, index + movement));
    const current = observations[index];
    return { index, position: index + 1, total: observations.length, current, cursor: observationCursor(current) };
  }
  function originalComparison(rows) {
    const originalRows = [...new Set(rows.map(item => typeof item === "number" ? item : item.rowIndex))];
    const values = originalRows.map(row => dataset.row_metadata.preference_probability?.[row]).filter(Number.isFinite);
    const preferenceA = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    return { rows: originalRows.length, probabilityCount: values.length, preferenceA,
      preferenceB: preferenceA === null ? null : 1 - preferenceA };
  }
  const focusedConcept = focused => typeof focused === "string" ? conceptByKey.get(focused) : focused?.choice ? focused : null;
  // Keep only the last cohort; dialog search, selection and display controls do
  // not change its statistics. Arbitrary population callbacks remain uncached.
  let relationshipCohort = null;
  function relationships(focused, options = {}) {
    const concept = focusedConcept(focused);
    if (!concept) return { focusedKey: null, support: 0, measure: "frequency", minimumPrompts: 0, groups: [] };
    if (typeof options === "string") options = { measure: options };
    const { measure = "frequency", minimumPrompts = 20, limit = null, populationFilter, allowedKeys } = options;
    const cacheKey = populationFilter ? null : JSON.stringify([concept.choice.key, allowedKeys ? [...allowedKeys].sort() : null]);
    const relations = cacheKey !== null && relationshipCohort?.key === cacheKey ? relationshipCohort.relations
      : relationshipGroups(dataset, concept.choice, choices.map(item => item.choice), { populationFilter, allowedKeys });
    if (cacheKey !== null) relationshipCohort = { key: cacheKey, relations };
    const group = (key, title, items) => {
      const ranked = rankRelationships(items, { minimumPrompts, sort: measure });
      const rows = (limit == null ? ranked : ranked.slice(0, Math.max(0, limit))).map(item => ({
        ...facadeConcept(item.target), relationKey: item.target.key, group: key, joint: item.joint, support: item.support,
        targetSupport: item.targetSupport, total: item.total, frequency: item.frequency, baseline: item.baseline,
        increase: item.increase, promptSupport: item.promptSupport.count, promptSupportUnit: item.promptSupport.unit,
      }));
      return { key, title, total: ranked.length, rows };
    };
    return { focusedKey: concept.key, support: conceptSupport(dataset, concept.choice).active, measure, minimumPrompts,
      groups: [group("same", concept.source === "pair" ? "In the same pair" : relations.labels.same, relations.same),
        group("linked", concept.source === "prompt" && pair.length ? answer.length ? "In linked answers and pairs" : "In linked pairs" : relations.labels.linked, relations.linked)] };
  }
  function filterByRelationships(focused, checkedRelationKeys = [], options = {}) {
    const concept = focusedConcept(focused);
    if (!concept) return [];
    const checked = checkedRelationKeys.map(key => conceptByKey.get(key)).filter(Boolean);
    return checkedRelationshipResults(dataset, concept.choice, checked.map(item => item.choice), options).map(facadeObservation);
  }
  // Only the two fixed model sides and two comparison metrics are cached. Query,
  // cursor and arbitrary caller strings never create cache entries.
  const modelResultCache = new Map(), comparisonCache = new Map();
  function modelResults(side, mode) {
    const model = models.find(item => item.side === side), opponent = models.find(item => item.side !== side);
    if (!model) return [];
    const key = `${side}:${mode}`;
    if (!modelResultCache.has(key)) modelResultCache.set(key, mode === "preference"
      ? modelPreferenceAssociations(dataset, model.rawId, opponent?.rawId, { sources: answerSources })
      : modelDistribution(dataset, model.rawId, { sources: answerSources }));
    return modelResultCache.get(key);
  }
  function comparisonResults(metric) {
    if (models.length < 2) return [];
    const key = metric === "answer" ? "answer" : "prompt";
    if (!comparisonCache.has(key)) comparisonCache.set(key, key === "answer"
      ? compareAnswerActivity(dataset, models[0].rawId, models[1].rawId, { sources: answerSources })
      : comparePromptScores(dataset, models[0].rawId, models[1].rawId));
    return comparisonCache.get(key);
  }
  function distributions(side = "a") {
    return modelResults(side, "activity").map(item => ({ ...facadeConcept(item.concept),
      active: item.active, total: item.total, share: item.rate, support: item.support.count }));
  }
  function promptConceptDistribution(key, cursor = null) {
    const concept = promptByKey.get(key), source = concept?.choice.source;
    const column = source?.space.feature_ids.indexOf(concept.featureId) ?? -1;
    const available = column >= 0, sign = concept?.pole === "negative" ? -1 : 1;
    const values = available ? source.view.values.map(row => row[column] * sign).filter(Number.isFinite) : [];
    const population = histogramPopulation(values.filter(value => value > 0), values.length, available);
    let current = { magnitude: null, state: "unavailable" };
    const row = pointIndex.get(cursor?.row_id);
    if (available && row != null && cursor?.source === source.key) {
      const item = activationItems(row, "prompt", key).find(value => value.key === key);
      current = { magnitude: item?.state === "active" ? item.value : null, state: item?.state ?? "unavailable" };
    }
    return { population, current };
  }
  function pairConceptDistribution(key, cursor = null, model = "all") {
    const concept = pairByKey.get(key), source = concept?.choice.source;
    const available = Boolean(source) && (model === "all" || typeof model === "string" && model.startsWith("model:") && modelById.has(model.slice(6)));
    const sign = concept?.pole === "negative" ? -1 : 1;
    const values = available ? source.view.values.flatMap((values, row) => matchesPairModel(row, model) ? [values[concept.choice.column] * sign] : []) : [];
    const population = histogramPopulation(values.filter(value => value > 0), values.length, available);
    let current = { magnitude: null, state: "unavailable" };
    const row = pointIndex.get(cursor?.row_id);
    if (available && row != null && cursor?.source === source.key && matchesPairModel(row, model)) {
      const value = source.view.values[row][concept.choice.column] * sign;
      current = { magnitude: value > 0 ? value : null, state: value > 0 ? "active" : "inactive" };
    }
    return { population, current };
  }
  function battleStats({ modelId = null, opponent = null, conceptKey = null } = {}) {
    const activeRows = conceptKey === null ? null : new Set(filterPairs([conceptKey]).map(item => item.rowIndex));
    return modelRegistry.filter(model => modelId === null || model.rawId === modelId).map(model => {
      const rows = dataset.row_ids.flatMap((_, row) => {
        const a = exampleText(dataset, row, "model_a"), b = exampleText(dataset, row, "model_b");
        return modelById.has(a) && modelById.has(b) && a !== b && (!activeRows || activeRows.has(row)) &&
          (a === model.rawId && (!opponent || b === opponent) || b === model.rawId && (!opponent || a === opponent)) ? [row] : [];
      });
      const outcome = outcomeSummary(dataset, rows, model.rawId);
      const scored = rows.filter(row => { const value = modelOutcome(dataset, row, model.rawId); return value.winner !== null || value.preference !== null; }).length;
      return { ...model, battles: rows.length, scored, wins: outcome.wins, losses: outcome.losses, ties: outcome.ties,
        hardN: outcome.hardN, winTieScore: outcome.hardN ? (outcome.wins + .5 * outcome.ties) / outcome.hardN : null,
        winRate: outcome.win, meanPreference: outcome.preference, probabilityCount: outcome.softN };
    });
  }
  const pairBattles = dataset.row_ids.flatMap((_, row) => {
    const a = exampleText(dataset, row, "model_a"), b = exampleText(dataset, row, "model_b");
    return modelById.has(a) && modelById.has(b) && a !== b ? [{ row, a, b }] : [];
  });
  // Cache only actual concepts; an opponent-specific query retains one result.
  const pairModelCache = new Map();
  let pairOpponentCache = null;
  function* pairModelMeasurements(concept, modelId = null, opponent = null) {
    const sign = concept.greaterSide === "a" ? 1 : -1;
    for (const battle of pairBattles) {
      const value = concept.choice.source.view.values[battle.row]?.[concept.choice.column];
      if (!Number.isFinite(value)) continue;
      for (const side of ["a", "b"]) {
        if (modelId !== null && battle[side] !== modelId || opponent !== null && battle[side === "a" ? "b" : "a"] !== opponent) continue;
        const relativeActivation = value * sign * (side === "a" ? 1 : -1);
        yield { row: battle.row, modelId: battle[side], relativeActivation,
          group: relativeActivation > 0 ? "greater" : relativeActivation < 0 ? "lower" : "equal" };
      }
    }
  }
  function pairModelConcepts(key, { opponent = null } = {}) {
    const concept = pairByKey.get(key);
    if (!concept?.greaterSide) return [];
    const cacheKey = JSON.stringify([key, opponent]);
    let result = opponent === null ? pairModelCache.get(key) : pairOpponentCache?.key === cacheKey ? pairOpponentCache.rows : null;
    if (!result) {
      const rows = new Map(modelRegistry.map(model => [model.rawId, { ...model, total: 0, greater: 0, lower: 0, equal: 0, sum: 0 }]));
      for (const measurement of pairModelMeasurements(concept, null, opponent)) {
        const row = rows.get(measurement.modelId);
        row.total++; row.sum += measurement.relativeActivation; row[measurement.group]++;
      }
      result = [...rows.values()].map(({ sum, ...row }) => ({ ...row, nonzero: row.greater + row.lower,
        greaterRate: row.greater + row.lower ? row.greater / (row.greater + row.lower) : null,
        meanSignedActivation: row.total ? sum / row.total : null }));
      if (opponent === null) pairModelCache.set(key, result); else pairOpponentCache = { key: cacheKey, rows: result };
    }
    return result.map(row => ({ ...row }));
  }
  function pairModelEvidence(key, modelId, { group = "all", opponent = null } = {}) {
    const concept = pairByKey.get(key);
    if (!concept?.greaterSide || !modelById.has(modelId) || !["all", "greater", "lower", "equal"].includes(group)) return [];
    return [...pairModelMeasurements(concept, modelId, opponent)].filter(item => group === "all" || item.group === group)
      .map(item => ({ ...observation(item.row, "pair"), relativeActivation: item.relativeActivation, group: item.group,
        participantModelId: modelId, ...modelOutcome(dataset, item.row, modelId) }));
  }
  // One retained comparison bounds memory even when users explore many model pairs.
  let modelComparisonCache = null, comparisonPromptIds = null;
  function promptCohort(rows) {
    if (!comparisonPromptIds) {
      const identities = new Map();
      comparisonPromptIds = dataset.row_ids.map((_, row) => {
        for (const key of ["prompt_id", "instruction_id", "prompt"]) {
          for (const metadata of [dataset.row_metadata, dataset.prompt?.row_metadata]) {
            const value = metadata?.[key]?.[row];
            if (!(typeof value === "string" ? value.trim() : key !== "prompt" && typeof value === "number" && Number.isFinite(value))) continue;
            const identity = JSON.stringify([key, value]);
            if (!identities.has(identity)) identities.set(identity, identities.size);
            return identities.get(identity);
          }
        }
        return undefined;
      });
    }
    const complete = rows.every(row => comparisonPromptIds[row] !== undefined);
    return { unit: complete ? "prompts" : "rows", rows: rows.map(row => ({ row,
      identity: complete ? comparisonPromptIds[row] : dataset.row_ids[row] })) };
  }
  function modelConceptComparison(firstId, secondId, { source = "answer", scope = "all" } = {}) {
    const cacheKey = JSON.stringify([firstId, secondId, source, scope]);
    if (modelComparisonCache?.key !== cacheKey) {
      const first = modelById.get(firstId), second = modelById.get(secondId);
      const catalog = { prompt, answer, pair }[source];
      const valid = first && second && firstId !== secondId && catalog && ["all", "headToHead"].includes(scope);
      let rows = [];
      if (valid) {
        const direct = new Set(pairBattles.filter(battle => battle.a === firstId && battle.b === secondId ||
          battle.a === secondId && battle.b === firstId).map(battle => battle.row));
        const cohorts = [firstId, secondId].map(modelId => {
          const selected = scope === "headToHead" ? [...direct] : modelPopulation(dataset, modelId).rows;
          if (source === "prompt") return promptCohort(selected);
          if (source === "answer") return answerObservations.filter(item => item.model === modelId &&
            (scope === "all" || direct.has(item.row)));
          return pairBattles.filter(battle => (battle.a === modelId || battle.b === modelId) &&
            (scope === "all" || direct.has(battle.row)));
        });
        const metrics = (concept, model, cohort) => {
          const choice = concept.choice, sign = concept.pole === "negative" ? -1 : 1;
          if (source === "pair") {
            let total = 0, greater = 0, lower = 0, sum = 0;
            for (const battle of cohort) {
              const raw = choice.source.view.values[battle.row]?.[choice.column];
              if (!Number.isFinite(raw) || !concept.greaterSide) continue;
              const value = raw * (concept.greaterSide === "a" ? 1 : -1) * (battle.a === model.rawId ? 1 : -1);
              total++; sum += value; greater += Number(value > 0); lower += Number(value < 0);
            }
            const nonzero = greater + lower, share = nonzero ? greater / nonzero : null, mean = total ? sum / total : null;
            return { ...model, unit: "pairs", active: greater, total, share, mean, greater, lower,
              equal: total - nonzero, nonzero, greaterRate: share, meanSignedActivation: mean };
          }
          let magnitudes;
          if (source === "prompt") {
            const values = new Map();
            for (const { row, identity } of cohort.rows) {
              const raw = choice.source.view.values[row]?.[choice.column];
              if (Number.isFinite(raw)) values.set(identity, Math.max(values.get(identity) ?? 0, raw * sign));
            }
            magnitudes = [...values.values()];
          } else {
            const compatible = new Set(choice.sources.map(item => item.key));
            magnitudes = cohort.flatMap(item => {
              const raw = compatible.has(item.source.key) ? item.source.view.values[item.row]?.[choice.column] : null;
              return Number.isFinite(raw) ? [Math.max(0, raw * sign)] : [];
            });
          }
          const total = magnitudes.length, active = magnitudes.filter(value => value > 0).length;
          return { ...model, unit: source === "prompt" ? cohort.unit : "answers", active, total,
            share: total ? active / total : null, mean: total ? magnitudes.reduce((sum, value) => sum + value, 0) / total : null };
        };
        rows = catalog.map(concept => {
          const a = metrics(concept, first, cohorts[0]), b = metrics(concept, second, cohorts[1]);
          return { ...concept, first: a, second: b, gap: a.share !== null && b.share !== null ? a.share - b.share : null };
        });
      }
      modelComparisonCache = { key: cacheKey, result: { first: first ?? null, second: second ?? null, source, scope, rows } };
    }
    const result = modelComparisonCache.result;
    return { ...result, first: result.first && { ...result.first }, second: result.second && { ...result.second },
      rows: result.rows.map(row => ({ ...row, first: { ...row.first }, second: { ...row.second } })) };
  }
  function modelBattleEvidence(modelId, { opponent = null } = {}) {
    if (!modelById.has(modelId)) return [];
    const owned = new Map(answerObservations.filter(item => item.model === modelId).map(item => [item.row, item]));
    return pairBattles.filter(battle => (battle.a === modelId && (opponent === null || battle.b === opponent)) ||
      (battle.b === modelId && (opponent === null || battle.a === opponent))).map(battle => {
      const item = owned.get(battle.row);
      return { ...(pairSource ? observation(battle.row, "pair") : item ? facadeObservation(item) : observation(battle.row, "prompt")),
        rowIndex: battle.row, rowId: dataset.row_ids[battle.row], participantModelId: modelId,
        opponentModelId: battle.a === modelId ? battle.b : battle.a,
        ...modelOutcome(dataset, battle.row, modelId) };
    });
  }
  // Profiles retain one model/source/opponent result; evidence is produced on demand.
  let profileCache = null, profileRowModels = null;
  function profileContext(modelId, opponent, requestedScoreKind = "auto") {
    if (!profileRowModels) profileRowModels = dataset.row_ids.map((_, row) => {
      const a = exampleText(dataset, row, "model_a"), b = exampleText(dataset, row, "model_b");
      return (a && b ? [a, b] : [exampleText(dataset, row, "model", "model_a", "model_b")]).filter(id => modelById.has(id));
    });
    const battles = pairBattles.filter(battle => battle.a === modelId && (opponent === null || battle.b === opponent) ||
      battle.b === modelId && (opponent === null || battle.a === opponent));
    const battleRows = new Set(battles.map(battle => battle.row));
    const rows = opponent === null ? profileRowModels.flatMap((ids, row) => ids.includes(modelId) ? [row] : []) : [...battleRows];
    const own = answerObservations.filter(item => item.model === modelId && (opponent === null || battleRows.has(item.row)));
    const peers = answerObservations.filter(item => item.model !== modelId && (opponent === null || item.model === opponent && battleRows.has(item.row)));
    const baseline = outcomeSummary(dataset, [...battleRows], modelId);
    const scoreKind = ["hard", "soft"].includes(requestedScoreKind) ? requestedScoreKind
      : baseline.hardN ? "hard" : baseline.softN ? "soft" : null;
    return { modelId, opponent, rows, own, peers, battles, battleRows, scoreKind,
      pairs: modelPairs(dataset, answerObservations, modelId, opponent) };
  }
  function profileScore(rows, context) {
    const outcome = outcomeSummary(dataset, [...new Set(rows)].filter(row => context.battleRows.has(row)), context.modelId);
    const winTieScore = outcome.hardN ? (outcome.wins + .5 * outcome.ties) / outcome.hardN : null;
    return { scoreKind: context.scoreKind, score: context.scoreKind === "hard" ? winTieScore : context.scoreKind === "soft" ? outcome.preference : null,
      scored: context.scoreKind === "hard" ? outcome.hardN : context.scoreKind === "soft" ? outcome.softN : 0,
      hardN: outcome.hardN, softN: outcome.softN, winTieScore, meanPreference: outcome.preference };
  }
  function profileMeasurements(concept, context) {
    const sign = concept.pole === "negative" ? -1 : 1, choice = concept.choice;
    const value = (row, source) => {
      if (!choice.sources.some(item => item.key === source.key)) return null;
      const raw = source.view.values[row]?.[choice.column];
      return Number.isFinite(raw) ? raw * sign : null;
    };
    if (concept.source === "pair") return [...pairModelMeasurements(concept, context.modelId, context.opponent)].map(item => ({
      row: item.row, source: choice.source, magnitude: Math.max(0, item.relativeActivation), relativeActivation: item.relativeActivation,
      group: item.group === "greater" ? "more" : item.group === "lower" ? "less" : "equal" }));
    if (concept.source === "prompt") return context.rows.flatMap(row => {
      const magnitude = value(row, choice.source);
      return magnitude === null ? [] : [{ row, source: choice.source, magnitude: Math.max(0, magnitude), relativeActivation: null,
        group: magnitude > 0 ? "active" : "inactive" }];
    });
    const differences = new Map(context.pairs.flatMap(item => {
      const own = value(item.row, item.own.source), other = value(item.row, item.other.source);
      return own === null || other === null ? [] : [[item.row, own - other]];
    }));
    return context.own.flatMap(item => {
      const magnitude = value(item.row, item.source), relativeActivation = differences.get(item.row) ?? null;
      return magnitude === null ? [] : [{ row: item.row, source: item.source, magnitude: Math.max(0, magnitude), relativeActivation,
        group: relativeActivation === null ? "unpaired" : relativeActivation > 0 ? "more" : relativeActivation < 0 ? "less" : "equal" }];
    });
  }
  function modelConceptProfile(modelId, { source = "answer", opponent = null, conceptKey = null, scoreKind = "auto" } = {}) {
    const bank = { prompt, answer, pair }[source];
    const catalog = conceptKey === null ? bank : bank?.filter(concept => concept.key === conceptKey);
    if (!modelById.has(modelId) || !catalog || opponent !== null && (!modelById.has(opponent) || opponent === modelId)) return [];
    const key = JSON.stringify([modelId, source, opponent, conceptKey, scoreKind]);
    if (profileCache?.key !== key) {
      const context = profileContext(modelId, opponent, scoreKind), baseline = profileScore([...context.battleRows], context);
      const peerRows = source === "prompt" ? (opponent !== null ? [...context.battleRows]
        : profileRowModels.flatMap((ids, row) => ids.some(id => id !== modelId) ? [row] : [])) : [];
      const promptCountsFor = measurements => {
        const cohort = promptCohort(measurements.map(item => item.row)), values = new Map();
        measurements.forEach((item, index) => values.set(cohort.rows[index].identity, Math.max(values.get(cohort.rows[index].identity) ?? 0, item.magnitude)));
        return { total: values.size, active: [...values.values()].filter(value => value > 0).length, unit: cohort.unit };
      };
      const rows = catalog.map(concept => {
        const measurements = profileMeasurements(concept, context), more = measurements.filter(item => item.group === "more"), less = measurements.filter(item => item.group === "less");
        const active = measurements.filter(item => item.magnitude > 0);
        const directional = measurements.filter(item => item.relativeActivation !== null);
        let counts = { active: active.length, total: measurements.length, unit: concept.unit }, peerCounts;
        if (source === "prompt") {
          counts = promptCountsFor(measurements);
          peerCounts = promptCountsFor(profileMeasurements(concept, { ...context, rows: peerRows }));
        } else if (source === "answer") {
          const peers = profileMeasurements(concept, { ...context, own: context.peers, pairs: [] });
          peerCounts = { active: peers.filter(item => item.magnitude > 0).length, total: peers.length };
        } else {
          // Compare participant directions, never label a pair difference as an absolute answer activation.
          const peers = [...pairModelMeasurements(concept)].filter(item => item.modelId !== modelId &&
            (opponent === null || item.modelId === opponent && context.battleRows.has(item.row)));
          peerCounts = { active: peers.filter(item => item.relativeActivation > 0).length,
            total: peers.filter(item => item.relativeActivation !== 0).length };
        }
        const denominator = source === "pair" ? more.length + less.length : counts.total;
        const share = denominator ? counts.active / denominator : null, baselineShare = peerCounts.total ? peerCounts.active / peerCounts.total : null;
        const scored = profileScore((source === "pair" ? [...more, ...less] : active).map(item => item.row), context);
        const moreScore = profileScore(more.map(item => item.row), context), lessScore = profileScore(less.map(item => item.row), context);
        return { ...concept, ...counts, share, nonzero: source === "pair" ? denominator : null,
          baselineActive: peerCounts.active, baselineTotal: peerCounts.total, baselineShare, baselineShareKind: "peers",
          shareGap: share !== null && baselineShare !== null ? share - baselineShare : null,
          ...scored, baselineKind: "overall", baselineScore: baseline.score, baselineScored: baseline.scored,
          scoreGap: scored.score !== null && baseline.score !== null ? scored.score - baseline.score : null,
          moreScore: moreScore.score, lessScore: lessScore.score, moreN: moreScore.scored, lessN: lessScore.scored,
          moreTotal: more.length, lessTotal: less.length, equalTotal: measurements.filter(item => item.group === "equal").length,
          meanGap: directional.length ? directional.reduce((sum, item) => sum + item.relativeActivation, 0) / directional.length : null,
          associationGap: moreScore.score !== null && lessScore.score !== null ? moreScore.score - lessScore.score : null };
      });
      profileCache = { key, rows };
    }
    return profileCache.rows.map(row => ({ ...row }));
  }
  function modelProfileEvidence(key, modelId, { opponent = null, group = "all", scoreKind = "auto" } = {}) {
    const concept = conceptByKey.get(key);
    if (!concept || !modelById.has(modelId) || !["all", "more", "less"].includes(group) ||
        opponent !== null && (!modelById.has(opponent) || opponent === modelId)) return [];
    const context = profileContext(modelId, opponent, scoreKind);
    return profileMeasurements(concept, context).filter(item => group === "all"
      ? concept.source === "pair" ? item.relativeActivation !== 0 : item.magnitude > 0 : item.group === group).map(item => {
      const outcome = context.battleRows.has(item.row) ? modelOutcome(dataset, item.row, modelId) : { winner: null, preference: null };
      const score = context.scoreKind === "hard" ? outcome.winner === "win" ? 1 : outcome.winner === "tie" ? .5 : outcome.winner === "loss" ? 0 : null
        : context.scoreKind === "soft" ? outcome.preference : null;
      return { ...facadeObservation({ row: item.row, rowId: dataset.row_ids[item.row], source: item.source }),
        participantModelId: modelId, magnitude: item.magnitude, relativeActivation: item.relativeActivation, group: item.group,
        ...outcome, scoreKind: context.scoreKind, score };
    });
  }
  function answerConceptDistribution(key, cursor = null, model = "all") {
    const concept = answerByKey.get(key), sides = { a: sourceA, b: sourceB };
    const lane = (source, scope = "all") => {
      if (!concept || !source || !concept.choice.sources.some(item => item.key === source.key))
        return { available: false, total: 0, active: 0, magnitudes: [] };
      const column = source.space.feature_ids.indexOf(concept.featureId);
      if (column < 0) return { available: false, total: 0, active: 0, magnitudes: [] };
      const sign = concept.pole === "negative" ? -1 : 1;
      const values = source.view.values.flatMap((row, index) => matchesAnswerModel({ row: index, source }, scope) ? [row[column] * sign] : []);
      const magnitudes = values.filter(value => Number.isFinite(value) && value > 0);
      return { available: true, total: values.filter(Number.isFinite).length, active: magnitudes.length, magnitudes };
    };
    const a = lane(sides.a), b = lane(sides.b), active = [...a.magnitudes, ...b.magnitudes];
    const maxMagnitude = active.length ? Math.max(...active) : 0;
    const aCounts = histogramCounts(a.magnitudes, maxMagnitude), bCounts = histogramCounts(b.magnitudes, maxMagnitude);
    const bins = Array.from({ length: 8 }, (_, index) => ({
      x0: maxMagnitude * index / 8, x1: maxMagnitude * (index + 1) / 8,
      aCount: aCounts[index], bCount: bCounts[index],
    }));
    const validScope = ["all", "a", "b"].includes(model) ||
      (typeof model === "string" && model.startsWith("model:") && answerModelById.has(model.slice(6)));
    const populationLanes = (model === "all" ? [a, b] : Object.entries(sides).filter(([side]) => !["a", "b"].includes(model) || model === side).map(([, source]) => lane(source, model)))
      .filter(item => item.available);
    const magnitudes = populationLanes.flatMap(item => item.magnitudes);
    const population = histogramPopulation(magnitudes, populationLanes.reduce((sum, item) => sum + item.total, 0),
      validScope && populationLanes.length > 0);
    let current = { side: null, magnitude: null, state: "unavailable" };
    if (cursor?.row_id && cursor?.source) {
      const side = sameSource(sides.a, { key: cursor.source }) ? "a" : sameSource(sides.b, { key: cursor.source }) ? "b" : null;
      const row = pointIndex.get(cursor.row_id), source = side && sides[side];
      if (side && row != null && source && concept && matchesAnswerModel({ row, source }, model)) {
        const item = activationItems(row, side, key).find(value => value.key === key);
        current = { side, magnitude: item?.state === "active" ? item.value : null, state: item?.state ?? "unavailable" };
      }
    }
    return { maxMagnitude, maxBinCount: Math.max(0, ...aCounts, ...bCounts), bins, a, b, current, population };
  }
  function preferenceAssociations(side = "a") {
    return modelResults(side, "preference").map(item => ({ ...facadeConcept(item.concept),
      activity: item.activity, active: item.active, total: item.total, value: item.value, higherN: item.higherN, lowerN: item.lowerN,
      higherMean: item.higherMean, lowerMean: item.lowerMean, support: item.support.count, available: item.available }));
  }
  function modelEvidence(key, side = "a", mode = "activity") {
    const model = models.find(item => item.side === side), opponent = models.find(item => item.side !== side);
    if (!model) return [];
    const evidence = (answer, concept, preference, group = "active", otherStrength = null) => ({
      ...facadeObservation(answer), preference, strength: conceptStrength(concept, answer.row, answer.source), otherStrength, group,
    });
    if (mode === "preference") {
      const result = modelResults(side, "preference").find(item => facadeConcept(item.concept).key === key);
      return result ? result.observations.map(item => evidence(item.answer, result.concept, item.score,
        item.difference > 0 ? "higher" : "lower",
        conceptStrength(result.concept, item.answer.row, sameSource(item.answer.source, sourceA) ? sourceB : sourceA))) : [];
    }
    if (mode === "activity") {
      const result = modelResults(side, "activity").find(item => facadeConcept(item.concept).key === key);
      return result ? result.activeAnswers.map(answer => evidence(answer, result.concept, conceptPreference(dataset, answer.row, answer.source))) : [];
    }
    if (mode === "prompt" && opponent) {
      const result = comparisonResults("prompt").find(item => facadeConcept(item.concept).key === key);
      if (!result) return [];
      return modelPopulation(dataset, model.rawId).rows
        .filter(row => modelConceptActive(result.concept, row) && modelOutcome(dataset, row, model.rawId).preference !== null)
        .map(row => evidence({ row, rowId: dataset.row_ids[row], source: result.concept.source }, result.concept,
          modelOutcome(dataset, row, model.rawId).preference));
    }
    return [];
  }
  function compare(metric = "prompt") {
    const rows = comparisonResults(metric);
    return rows.map(item => metric === "answer" ? ({ ...facadeConcept(item.concept), a: item.first, b: item.second, gap: item.gap,
      supportA: item.firstActive, supportB: item.secondActive }) : ({ ...facadeConcept(item.concept), a: item.first.value, b: item.second.value,
      gap: item.gap, supportA: item.first.scoredRows, supportB: item.second.scoredRows }));
  }
  function datasetConcepts(kind = "answer") {
    const measurements = kind === "pair" ? pairMeasurements : kind === "answer" ? answerMeasurements : promptMeasurements;
    return measurements.rows.map(item => ({ ...facadeConcept(item.choice), active: item.active, total: measurements.total,
      share: item.rate, support: item.support.count, mean: item.active ? item.meanActivation : null }));
  }
  function summary() {
    const unnamedAnswers = health.find(item => item.id === "unnamed-answer-concepts")?.count ?? 0;
    return { canonicalRows: inventory.canonicalRows, prompts: inventory.prompts, answers: inventory.answers, pairs: inventory.pairs, models: inventory.models, scored: inventory.scoredComparisons,
      answerDensity: { ...inventory.answerDensity, nonzero: inventory.answerCoverage }, promptDensity: { ...inventory.promptDensity, nonzero: inventory.promptCoverage },
      pairDensity: { ...inventory.pairDensity, nonzero: inventory.pairCoverage },
      answerActive: inventory.answerConcepts.active, promptActive: inventory.promptConcepts.active, pairActive: inventory.pairConcepts.active,
      namedAnswers: inventory.answerConcepts.total - unnamedAnswers, unnamedAnswers,
      topAnswers: inventory.answerTop.map(item => ({ ...facadeConcept(item.choice), share: item.rate })),
      topPrompts: inventory.promptTop.map(item => ({ ...facadeConcept(item.choice), share: item.rate })),
      modelAnswerCounts: inventory.modelAnswerCounts };
  }
  function checks() {
    const [unnamed, provisional, repeated] = health;
    return [
      { count: unnamed.count, status: unnamed.count ? "Review" : "None", title: `${unnamed.count} unnamed answer concepts`, detail: unnamed.count ? "These concepts have feature numbers but no supplied descriptive name." : "All answer concepts have supplied names.", action: "Details" },
      { count: provisional.count, status: provisional.count ? "Review" : "None", title: `${provisional.count} provisional answer labels`, detail: provisional.count ? "These supplied names have not been reviewed. Use the answer examples to interpret each concept." : "No answer labels are marked provisional.", action: "Details" },
      { count: repeated.count, status: repeated.count ? "Review" : "None", title: `${repeated.count} repeated ${repeated.count === 1 ? "name" : "names"}`, detail: repeated.groups.map(group => `${group.name} · features ${group.featureIds.join(", ")}`).join("; ") || "No answer concept names are repeated.", action: "Details" },
    ];
  }

  return { contractVersion: 1,
    dataset: { name: dataset.provenance.title ?? "Dataset", payloadHash: dataHash, bundle, build }, models, answerModels, modelRegistry,
    lenses: [answer.length && "answer", pair.length && "pair"].filter(Boolean),
    concepts: { prompt, answer, pair }, record, hasFullAnswer, ensureAnswerTexts, ensureAllAnswerTexts,
    observation, activationItems, conceptCounts, filterPrompt, filterPromptObservations, filterAnswers, filterPairs, battleStats, pairModelConcepts, pairModelEvidence, modelConceptComparison, modelBattleEvidence, modelConceptProfile, modelProfileEvidence,
    observationCursor, observationStrengths, sortObservations, filterActivationRange, pageObservationResults, originalComparison, relationships, filterByRelationships,
    map: { points: { prompt: mapPoints("prompt"), answer: mapPoints("answers"), pair: mapPoints("pair") },
      meta: { prompt: projection("prompt")?.meta ?? null, answer: projection("answers")?.meta ?? null, pair: projection("pair")?.meta ?? null }, pointIndex },
    distributions, promptConceptDistribution, answerConceptDistribution, pairConceptDistribution, preferenceAssociations, modelEvidence, compare, datasetConcepts, summary, checks,
    provenance: { ...dataset.provenance, answerFeatureSpace: dataset.feature_space, promptFeatureSpace: dataset.prompt?.feature_space, catalog: dataset.catalog?.provenance },
  };
}

function facadeConcept(choice) {
  const featureId = choice.featureId ?? choice.id;
  const pole = choice.pole;
  const feature = choice.source?.features[choice.column];
  const description = pole === "negative" ? feature?.negativeDescription : feature?.positiveDescription;
  const view = choice.source?.view, source = view?.role === "prompt" ? "prompt" : ["difference", "response_difference"].includes(view?.role) ? "pair" : "answer";
  const positiveSide = view?.orientation === "a_minus_b" ? "a" : view?.orientation === "b_minus_a" ? "b" : null;
  const greaterSide = source === "pair" && positiveSide ? pole === "negative" ? positiveSide === "a" ? "b" : "a" : positiveSide : null;
  return { key: source === "prompt" || source === "pair" ? `${source}:${featureId}:${pole}` : `answer:${featureId}`, source, lens: source,
    unit: source === "pair" ? "pairs" : source === "prompt" ? "prompts" : "answers", orientation: view?.orientation,
    activationPolarity: view?.activation_polarity, greaterSide, featureId, pole,
    name: choice.name ?? choice.label, description: typeof description === "string" ? description.trim() : "",
    status: conceptLabelState(choice), conceptType: feature?.catalog?.concept_type, choice };
}
function engineChoices(dataset) {
  return conceptChoices(dataset).map(choice => ({ ...facadeConcept(choice), count: conceptSupport(dataset, choice).active }));
}
