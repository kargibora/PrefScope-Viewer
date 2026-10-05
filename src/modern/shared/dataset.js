import { exampleSources, exampleText, modelIds } from "./viewer-data.js";
import { conceptActive, conceptChoices, conceptObservations, conceptUnit, promptSupport } from "./observations.js";
import { modelAnswers } from "./models.js";

export function datasetDistribution(dataset, choices, population) {
  if (new Set(choices.map(choice => choice.groupKey)).size > 1) throw new Error("datasetDistribution requires concepts from one measurement group");
  const first = choices[0], allObservations = first ? conceptObservations(first) : [];
  const keys = population === undefined ? null : new Set(population.map(observation => observation.key));
  const observations = keys ? allObservations.filter(observation => keys.has(observation.key)) : allObservations;
  const isAnswer = first && ["response", "response_a", "response_b"].includes(first.source.view.role);
  const modelByObservation = new Map(isAnswer ? modelAnswers(dataset, dataset.row_ids.map((_, row) => row), first.sources).map(answer => [answer.key, answer.model]) : []);
  const field = ["language", "source", "group"].find(key => allObservations.some(observation => exampleText(dataset, observation.row, key))) ?? (modelByObservation.size ? "model" : null);
  const groupByObservation = new Map(allObservations.map(observation => [observation.key,
    field === "model" ? modelByObservation.get(observation.key) ?? "" : field ? exampleText(dataset, observation.row, field) ?? "" : ""]));
  const groups = [...new Set([...groupByObservation.values()].filter(Boolean))].sort();
  function summarize(items) {
    const totals = Object.create(null);
    for (const observation of items) {
      const group = groupByObservation.get(observation.key); if (group) totals[group] = (totals[group] ?? 0) + 1;
    }
    const counts = new Array(items.length).fill(0);
    const rows = choices.map(choice => {
      let active = 0, sum = 0; const activeRows = [], byGroup = Object.fromEntries(Object.entries(totals).map(([key, total]) => [key, { active: 0, total }]));
      items.forEach((observation, index) => {
        if (!conceptActive(choice, observation.row, observation.source)) return;
        active++; counts[index]++; activeRows.push(observation.row); sum += Math.abs(observation.source.view.values[observation.row][choice.column]);
        const group = groupByObservation.get(observation.key); if (group) byGroup[group].active++;
      });
      return { choice, active, support: promptSupport(dataset, activeRows), rate: items.length ? active / items.length : 0, meanActivation: active ? sum / active : 0, groups: byGroup };
    });
    const sorted = [...counts].sort((a, b) => a - b), histogram = new Array((sorted.at(-1) ?? 0) + 1).fill(0);
    counts.forEach(count => histogram[count]++);
    const covered = counts.filter(count => count > 0).length;
    return { rows, observations: items, counts, total: items.length, originalRows: new Set(items.map(item => item.row)).size,
      support: promptSupport(dataset, items.map(item => item.row)), covered, coverage: items.length ? covered / items.length : 0, histogram,
      mean: counts.length ? counts.reduce((sum, count) => sum + count, 0) / counts.length : 0,
      median: sorted[Math.floor(.5 * Math.max(0, sorted.length - 1))] ?? 0,
      p99: sorted[Math.floor(.99 * Math.max(0, sorted.length - 1))] ?? 0,
      min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0, inactive: rows.filter(row => row.active === 0).length };
  }
  return { ...summarize(observations), field, groups, byGroup: new Map(groups.map(group => [group, summarize(observations.filter(item => groupByObservation.get(item.key) === group))])) };
}

export function conceptMeasurements(dataset, { kind = "answer", population, groupKey } = {}) {
  const unit = kind === "prompt" ? "prompts" : kind === "pair" ? "pairs" : "answers";
  const candidates = conceptChoices(dataset).filter(choice => conceptUnit(choice) === unit);
  const groups = [...new Set(candidates.map(choice => choice.groupKey))];
  if (groups.length > 1 && groupKey === undefined) throw new Error(`Multiple ${kind} measurement groups require groupKey`);
  const selected = groupKey ?? groups[0];
  return datasetDistribution(dataset, candidates.filter(choice => choice.groupKey === selected), population);
}

function distributionsByUnit(dataset, choices, unit) {
  const matching = choices.filter(choice => conceptUnit(choice) === unit), groups = new Map();
  for (const choice of matching) groups.set(choice.groupKey, [...(groups.get(choice.groupKey) ?? []), choice]);
  return [...groups.values()].map(group => datasetDistribution(dataset, group));
}
function combineDistributions(distributions) {
  const rows = distributions.flatMap(distribution => distribution.rows), counts = distributions.flatMap(distribution => distribution.counts);
  const sorted = [...counts].sort((a, b) => a - b), total = counts.length, covered = counts.filter(Boolean).length;
  return { rows, counts, total, inactive: rows.filter(row => row.active === 0).length, covered, coverage: total ? covered / total : 0,
    mean: total ? counts.reduce((sum, count) => sum + count, 0) / total : 0,
    median: sorted[Math.floor(.5 * Math.max(0, total - 1))] ?? 0,
    p99: sorted[Math.floor(.99 * Math.max(0, total - 1))] ?? 0,
    min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0 };
}

export function datasetInventory(dataset) {
  const choices = conceptChoices(dataset), answerBanks = distributionsByUnit(dataset, choices, "answers"), promptBanks = distributionsByUnit(dataset, choices, "prompts"), pairBanks = distributionsByUnit(dataset, choices, "pairs");
  const answers = combineDistributions(answerBanks), prompts = combineDistributions(promptBanks), pairs = combineDistributions(pairBanks);
  const probabilityCount = (dataset.row_metadata.preference_probability ?? []).filter(value => typeof value === "number").length;
  const labeledCount = (dataset.row_metadata.winner ?? []).filter(value => typeof value === "string" && ["a", "b", "tie"].includes(value.toLowerCase())).length;
  const answerSources = exampleSources(dataset).filter(source => ["response", "response_a", "response_b"].includes(source.view.role));
  const answerOwners = modelAnswers(dataset, dataset.row_ids.map((_, row) => row), answerSources);
  const modelAnswerCounts = Object.fromEntries(modelIds(dataset).map(model => [model, answerOwners.filter(answer => answer.model === model).length]));
  return {
    prompts: promptBanks.length ? promptSupport(dataset, dataset.row_ids.map((_, row) => row)).count : 0,
    canonicalRows: dataset.row_ids.length,
    answers: answerBanks.reduce((sum, bank) => sum + bank.total, 0),
    pairs: pairBanks.reduce((sum, bank) => sum + bank.total, 0),
    models: modelIds(dataset).length,
    scoredComparisons: labeledCount || probabilityCount,
    modelAnswerCounts,
    answerConcepts: { total: answers.rows.length, active: answers.rows.length - answers.inactive },
    promptConcepts: { total: prompts.rows.length, active: prompts.rows.length - prompts.inactive },
    pairConcepts: { total: pairs.rows.length, active: pairs.rows.length - pairs.inactive },
    answerDensity: densitySummary(answers), promptDensity: densitySummary(prompts), pairDensity: densitySummary(pairs),
    answerCoverage: answers.coverage, promptCoverage: prompts.coverage, pairCoverage: pairs.coverage,
    answerTop: topConcepts(answers.rows, 4), promptTop: topConcepts(prompts.rows, 4),
    banks: { answer: answerBanks, prompt: promptBanks, pair: pairBanks }, provenance: dataset.provenance,
  };
}
function densitySummary(distribution) {
  return { mean: distribution.mean, median: distribution.median, p99: distribution.p99, min: distribution.min, max: distribution.max };
}
function topConcepts(rows, count) {
  return [...rows].sort((a, b) => b.rate - a.rate || b.active - a.active || a.choice.key.localeCompare(b.choice.key)).slice(0, count);
}

export function datasetChecks(dataset) {
  const answerChoices = conceptChoices(dataset).filter(choice => conceptUnit(choice) === "answers");
  const positive = [...new Map(answerChoices.filter(choice => choice.pole === "positive")
    .map(choice => [`${choice.source.spaceKey}:${choice.featureId}`, choice])).values()];
  const unnamed = positive.filter(choice => choice.name.startsWith("Unnamed concept "));
  const provisional = positive.filter(choice => !choice.name.startsWith("Unnamed concept ") && (() => {
    const status = choice.source.features[choice.column]?.catalog?.verification_status ?? choice.source.space.catalog?.provenance?.verification_status;
    return status === "not_run" || status === "provisional" || choice.source.features[choice.column]?.catalog?.provisional_label === true;
  })());
  const names = new Map();
  for (const choice of positive.filter(choice => !choice.name.startsWith("Unnamed concept "))) {
    const normalized = choice.name.trim().toLowerCase(), current = names.get(normalized) ?? { name: choice.name.trim(), featureIds: [] };
    current.featureIds.push(choice.featureId); names.set(normalized, current);
  }
  const duplicates = [...names.values()].filter(group => group.featureIds.length > 1);
  return [
    { id: "unnamed-answer-concepts", severity: "review", count: unnamed.length, concepts: unnamed },
    { id: "provisional-answer-names", severity: "review", count: provisional.length, concepts: provisional },
    { id: "repeated-answer-names", severity: "review", count: duplicates.length, groups: duplicates },
  ];
}
export function filterConceptMeasurements(rows, { query = "", minimumPrompts = 0, includeBelow = false, sort = "common" } = {}) {
  const needle = query.trim().toLowerCase();
  return [...rows].filter(row => (includeBelow || row.support.count >= minimumPrompts) && (!needle || row.choice.name.toLowerCase().includes(needle) || String(row.choice.featureId) === needle))
    .sort((a, b) => Number(b.support.count >= minimumPrompts) - Number(a.support.count >= minimumPrompts) ||
      (sort === "rare" ? a.rate - b.rate : sort === "activation" ? b.meanActivation - a.meanActivation : b.rate - a.rate) ||
      b.support.count - a.support.count || a.choice.name.localeCompare(b.choice.name));
}
