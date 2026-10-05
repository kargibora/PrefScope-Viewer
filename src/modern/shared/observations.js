import { answerSide, exampleAnswerText, exampleSources, exampleText, tableRecords } from "./viewer-data.js";

const individual = source => ["response", "response_a", "response_b"].includes(source.view.role);
const difference = source => ["difference", "response_difference"].includes(source.view.role);
export const conceptKind = choice => choice.source.view.role === "prompt" ? "prompt" : "answer";
export const conceptUnit = choice => conceptKind(choice) === "prompt" ? "prompts" : difference(choice.source) ? "pairs" : "answers";

function observationLabel(source) {
  if (source.view.role === "prompt") return "Prompt";
  if (difference(source)) return `Pair contrast · ${source.view.orientation === "b_minus_a" ? "Answer B relative to Answer A" : source.view.orientation === "a_minus_b" ? "Answer A relative to Answer B" : "supplied comparison"}`;
  const side = answerSide(source);
  return side ? `Answer ${side.toUpperCase()}` : source.view.role === "response" ? "Answer" : source.view.role;
}

export function conceptChoices(dataset) {
  const sources = exampleSources(dataset), groups = [], used = new Set();
  for (const source of sources) {
    if (used.has(source.key)) continue;
    const compatible = sources.filter(item => item.space === source.space && item.view.code_semantics === source.view.code_semantics &&
      item.view.activation_polarity === source.view.activation_polarity && individual(item) && answerSide(item));
    const paired = individual(source) && answerSide(source) && compatible.length === 2 && new Set(compatible.map(answerSide)).size === 2;
    const group = paired ? compatible : [source];
    group.forEach(item => used.add(item.key));
    groups.push(group);
  }
  const labels = groups.map(group => group.length > 1 ? "Answers" : observationLabel(group[0]));
  return groups.flatMap((group, groupIndex) => {
    const baseLabel = labels[groupIndex];
    const groupLabel = labels.filter(label => label === baseLabel).length > 1
      ? `${baseLabel} · source ${labels.slice(0, groupIndex + 1).filter(label => label === baseLabel).length}` : baseLabel;
    const sources = group.map(source => ({ ...source, label: group.length > 1 ? observationLabel(source) : groupLabel }));
    const groupKey = JSON.stringify(group.map(source => source.key));
    return sources[0].features.flatMap((feature, column) => {
      const poles = sources[0].view.activation_polarity === "signed" ? ["positive", "negative"] : ["positive"];
      return poles.map(pole => {
        const supplied = pole === "negative" ? feature.negative : feature.label;
        const unnamed = !supplied || supplied === `Feature ${feature.id} · unnamed`;
        const name = unnamed ? `Unnamed concept ${column + 1}` : supplied;
        return { key: JSON.stringify([groupKey, feature.id, pole]), groupKey, groupLabel, source: sources[0], sources, column,
          featureId: feature.id, pole, name, displayName: name, namingStatus: pole === "negative" ? feature.negativeNamingStatus : feature.positiveNamingStatus };
      });
    });
  });
}

export function defaultConcept(dataset, kind, choices = conceptChoices(dataset), minimumPrompts = 20) {
  const eligible = choices.filter(choice => conceptKind(choice) === kind).map(choice => ({ choice, support: conceptSupport(dataset, choice) }))
    .filter(item => item.support.count >= minimumPrompts)
    .sort((a, b) => b.support.active - a.support.active || a.choice.displayName.localeCompare(b.choice.displayName) || a.choice.key.localeCompare(b.choice.key));
  return eligible[0]?.choice ?? choices.find(choice => conceptKind(choice) === kind) ?? null;
}

export function conceptLabelState(choice) {
  const status = choice.namingStatus;
  if (status === "proposed") return "proposed";
  if (status === "mixed") return "mixed";
  if (status === "insufficient_evidence") return "insufficient_evidence";
  const row = choice.source.features[choice.column]?.catalog;
  const fallback = row?.[`${choice.pole}_status`] ?? row?.verification_status ?? choice.source.space.catalog?.provenance?.verification_status;
  if (row?.provisional_label === true || ["not_run", "provisional"].includes(fallback)) return "provisional";
  if (row?.fidelity_pass === false || fallback === "failed") return "uncertain";
  if (row?.fidelity_pass === true || ["verified", "passed"].includes(fallback)) return "checked";
  return "unchecked";
}

// Parsed source identities are immutable. Keep one key per actual source row,
// rather than serializing it again for every concept relationship.
const observationKeys = new WeakMap(), observationPopulations = new WeakMap();
export function observationKey(row, source) {
  let keys = observationKeys.get(source);
  if (!keys) {
    keys = source.space.row_ids.map(id => JSON.stringify([id, source.key]));
    observationKeys.set(source, keys);
  }
  return keys[row] ?? JSON.stringify([source.space.row_ids[row], source.key]);
}
export function conceptObservations(choice) {
  let population = observationPopulations.get(choice.sources);
  if (!population) {
    population = choice.source.view.values.flatMap((_, row) => choice.sources.map(source => ({
      key: observationKey(row, source), row, rowId: source.space.row_ids[row], source,
    })));
    observationPopulations.set(choice.sources, population);
  }
  return population.map(item => ({ ...item }));
}
export function observationSource(choice, observation) {
  return conceptKind(choice) === "prompt" ? choice.source : choice.sources.find(source => source.key === observation.source.key);
}
export function conceptActive(choice, row, source = choice.source) {
  const value = source.view.values[row]?.[choice.column];
  return choice.pole === "positive" ? value > 0 : value < 0;
}
// Parsed datasets are immutable; intern long prompt identities once per dataset.
const promptIdentityCache = new WeakMap();
export function promptSupport(dataset, rows) {
  let identities = promptIdentityCache.get(dataset);
  if (!identities) {
    const ids = new Map();
    identities = dataset.row_ids.map((_, row) => {
      for (const key of ["prompt_id", "instruction_id", "prompt"]) {
        for (const metadata of [dataset.row_metadata, dataset.prompt?.row_metadata]) {
          const value = metadata?.[key]?.[row];
          const valid = typeof value === "string" ? Boolean(value.trim()) : key !== "prompt" && typeof value === "number" && Number.isFinite(value);
          if (!valid) continue;
          const identity = JSON.stringify([key, value]);
          if (!ids.has(identity)) ids.set(identity, ids.size);
          return ids.get(identity);
        }
      }
      return undefined;
    });
    promptIdentityCache.set(dataset, identities);
  }
  const uniqueRows = [...new Set(rows)], selected = new Set();
  for (const row of uniqueRows) {
    if (identities[row] === undefined) return { count: new Set(uniqueRows.map(index => dataset.row_ids[index])).size, unit: "rows" };
    selected.add(identities[row]);
  }
  return { count: selected.size, unit: "prompts" };
}
export function conceptSupport(dataset, choice, population = conceptObservations(choice)) {
  const active = population.filter(item => conceptActive(choice, item.row, item.source));
  return { active: active.length, total: population.length, ...promptSupport(dataset, active.map(item => item.row)) };
}

export function matchingObservations(dataset, choices, focused, { query = "", allowedKeys } = {}) {
  for (const kind of ["prompt", "answer"]) {
    if (new Set(choices.filter(choice => conceptKind(choice) === kind).map(choice => choice.groupKey)).size > 1) return [];
  }
  const population = choices.find(choice => conceptKind(choice) === "answer") ?? focused;
  const needle = query.trim().toLowerCase();
  return conceptObservations(population).filter(observation => {
    if (!choices.every(choice => {
      const source = observationSource(choice, observation);
      return source && (!allowedKeys || allowedKeys.has(observationKey(observation.row, source))) && conceptActive(choice, observation.row, source);
    })) return false;
    if (!needle) return true;
    const texts = [dataset.row_ids[observation.row], exampleText(dataset, observation.row, "prompt")];
    if (difference(observation.source)) texts.push(exampleText(dataset, observation.row, "response_a", "completion_a"), exampleText(dataset, observation.row, "response_b", "completion_b"));
    else if (observation.source.view.role !== "prompt") texts.push(exampleAnswerText(dataset, observation.row, observation.source));
    return !needle || texts.some(text => text?.toLowerCase().includes(needle));
  });
}

/** Resolve a stable row_id + source cursor within a result set. */
export function pageResults(observations, cursor, movement = 0) {
  if (!observations.length) return { index: -1, total: 0, current: null, cursor: null };
  let index = cursor ? observations.findIndex(item => item.rowId === cursor.row_id && item.source.key === cursor.source) : -1;
  if (index < 0) index = 0;
  index = Math.max(0, Math.min(observations.length - 1, index + movement));
  const current = observations[index];
  return { index, position: index + 1, total: observations.length, current,
    cursor: { row_id: current.rowId, source: current.source.key } };
}

export function activationState(source, row, request) {
  const column = source.space.feature_ids.indexOf(request.featureId);
  if (column < 0 || (request.sourceKeys && !request.sourceKeys.includes(source.key)))
    return { ...request, state: "unavailable", value: null, magnitude: null, formatted: "Unavailable" };
  const value = source.view.values[row]?.[column];
  if (typeof value !== "number") return { ...request, state: "unavailable", value: null, magnitude: null, formatted: "Unavailable" };
  const magnitude = request.pole === "negative" ? -value : value;
  return { ...request, value, magnitude, state: magnitude > 0 ? "active" : "inactive", formatted: magnitude > 0 ? formatActivation(magnitude) : "Inactive" };
}
export function formatActivation(value) {
  if (!Number.isFinite(value)) return "Unavailable";
  if (value === 0) return "0";
  return Number(value.toPrecision(4)).toString();
}
/** Include every active direction plus requested inactive/unavailable directions. */
export function inspectActivations(source, row, requests = []) {
  const requested = new Map(requests.map(request => [`${request.featureId}:${request.pole}`, request]));
  const entries = [];
  source.features.forEach((feature, column) => {
    const value = source.view.values[row][column];
    const poles = source.view.activation_polarity === "signed" ? ["positive", "negative"] : ["positive"];
    for (const pole of poles) {
      const request = requested.get(`${feature.id}:${pole}`);
      const magnitude = pole === "negative" ? -value : value;
      if (magnitude > 0 || request) entries.push(activationState(source, row, { featureId: feature.id, pole,
        label: pole === "negative" ? feature.negative ?? `Unnamed concept ${column + 1}` : feature.label === `Feature ${feature.id} · unnamed` ? `Unnamed concept ${column + 1}` : feature.label,
        ...request }));
      requested.delete(`${feature.id}:${pole}`);
    }
  });
  for (const request of requested.values()) entries.push(activationState(source, row, request));
  return { state: entries.some(entry => entry.state === "active") ? "available" : "no-active", entries,
    activeCount: entries.filter(entry => entry.state === "active").length };
}

export function conceptRelationships(dataset, focused, choices, { populationFilter, allowedKeys } = {}) {
  return choices.flatMap(target => {
    if (target.key === focused.key) return [];
    const sameKind = conceptKind(target) === conceptKind(focused);
    if (sameKind && target.groupKey !== focused.groupKey) return [];
    const populationChoice = conceptKind(focused) === "answer" ? focused : target;
    let observations = conceptObservations(populationChoice);
    if (populationFilter) observations = populationFilter(observations);
    let support = 0, targetSupport = 0, total = 0;
    const jointRows = [];
    for (const observation of observations) {
      const fromSource = observationSource(focused, observation), toSource = observationSource(target, observation);
      if (!fromSource || !toSource) continue;
      if (allowedKeys && (!allowedKeys.has(observationKey(observation.row, fromSource)) || !allowedKeys.has(observationKey(observation.row, toSource)))) continue;
      total++;
      const from = conceptActive(focused, observation.row, fromSource), to = conceptActive(target, observation.row, toSource);
      if (from) support++;
      if (to) targetSupport++;
      if (from && to) jointRows.push(observation.row);
    }
    if (!jointRows.length || !support || !total) return [];
    const frequency = jointRows.length / support, baseline = targetSupport / total;
    return [{ target, support, targetSupport, joint: jointRows.length, jointRows, promptSupport: promptSupport(dataset, jointRows), total,
      frequency, baseline, increase: frequency - baseline }];
  });
}
export function relationshipGroups(dataset, focused, choices, options = {}) {
  const all = conceptRelationships(dataset, focused, choices, options);
  const sameKind = all.filter(item => conceptKind(item.target) === conceptKind(focused));
  const linked = all.filter(item => conceptKind(item.target) !== conceptKind(focused));
  const labels = conceptKind(focused) === "prompt"
    ? { same: "In the same prompt", linked: "In linked answers" }
    : { same: "In the same answer", linked: "In the linked prompt" };
  return { labels, same: sameKind, linked };
}
export function rankRelationships(relations, { minimumPrompts = 20, sort = "frequency" } = {}) {
  return relations.filter(relation => relation.promptSupport.count >= minimumPrompts).sort((a, b) =>
    (sort === "increase" ? b.increase - a.increase : b.frequency - a.frequency) || b.joint - a.joint || a.target.key.localeCompare(b.target.key));
}
export function checkedRelationshipResults(dataset, focused, checked, options = {}) {
  return matchingObservations(dataset, [focused, ...checked], focused, options);
}

export function conceptPreference(dataset, row, source) {
  const p = dataset.row_metadata.preference_probability?.[row] ?? dataset.prompt?.row_metadata.preference_probability?.[row];
  if (typeof p !== "number") return null;
  const side = source && answerSide(source);
  if (source && individual(source) && !side) return null;
  return side === "b" ? 1 - p : p;
}
