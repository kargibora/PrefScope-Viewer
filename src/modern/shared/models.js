import { answerSide, exampleSources, exampleText, modelIds, modelNames } from "./viewer-data.js";
import { promptSupport } from "./observations.js";

export { modelIds, modelNames };
export function compatibleSources(a, b) {
  if (a.key === b.key && a.space === b.space) return true;
  const known = value => typeof value === "string" && value.trim() && !["unknown", "unspecified", "none"].includes(value);
  return a.space === b.space && known(a.view.code_semantics) && a.view.code_semantics === b.view.code_semantics &&
    ["signed", "nonnegative"].includes(a.view.activation_polarity) && a.view.activation_polarity === b.view.activation_polarity;
}
export function modelSourceGroups(dataset) {
  const sources = exampleSources(dataset), answers = sources.filter(source => ["response", "response_a", "response_b"].includes(source.view.role));
  return { prompt: sources.filter(source => source.view.role === "prompt"), answer: answers, a: answers.filter(source => answerSide(source) === "a"),
    b: answers.filter(source => answerSide(source) === "b"), pair: sources.filter(source => ["difference", "response_difference"].includes(source.view.role)) };
}
export function pooledAnswerSources(dataset) {
  const candidates = modelSourceGroups(dataset).answer;
  if (candidates.length === 1) return candidates;
  for (const source of candidates) {
    const compatible = candidates.filter(item => answerSide(item) && compatibleSources(source, item));
    if (compatible.length === 2 && new Set(compatible.map(answerSide)).size === 2) return compatible;
  }
  return [];
}
export function modelConcepts(source) {
  if (!source) return [];
  return source.features.flatMap((feature, column) => {
    const baseLabel = feature.label === `Feature ${feature.id} · unnamed` ? `Unnamed concept ${column + 1}` : feature.label;
    const make = (pole, label) => ({ key: JSON.stringify([source.key, feature.id, pole]), id: feature.id, column, pole, label, source });
    const positive = make("positive", baseLabel);
    return source.view.activation_polarity === "signed" || feature.negative || source.view.values.some(row => row[column] < 0)
      ? [positive, make("negative", feature.negative ?? `Unnamed opposite concept ${column + 1}`)] : [positive];
  });
}
export function conceptActivation(concept, row, source = concept.source) {
  if (!compatibleSources(concept.source, source) || source.space.feature_ids[concept.column] !== concept.id) return null;
  const value = source.view.values[row]?.[concept.column];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export function conceptStrength(concept, row, source = concept.source) {
  const value = conceptActivation(concept, row, source);
  return value === null ? null : value * (concept.pole === "negative" ? -1 : 1);
}
export const modelConceptActive = (concept, row, source = concept.source) => (conceptStrength(concept, row, source) ?? 0) > 0;

export function modelPopulation(dataset, model, opponent = null) {
  const rows = [], baselineRows = []; let paired = false;
  dataset.row_ids.forEach((_, row) => {
    const a = exampleText(dataset, row, "model_a"), b = exampleText(dataset, row, "model_b");
    if (a && b) {
      if ((a === model && (!opponent || b === opponent)) || (b === model && (!opponent || a === opponent))) {
        rows.push(row); if (a !== b) { paired = true; baselineRows.push(row); }
      }
      return;
    }
    const owner = exampleText(dataset, row, "model", "model_a", "model_b");
    if (owner === model) rows.push(row); else if (owner && (!opponent || owner === opponent)) baselineRows.push(row);
  });
  return { paired, rows, baselineRows };
}
export function modelAnswers(dataset, rows, sources) {
  const contexts = sources.map(source => ({ source, side: answerSide(source), singleView: Object.values(source.space.views).filter(view => ["response", "response_a", "response_b"].includes(view.role)).length === 1 }));
  return rows.flatMap(row => contexts.flatMap(({ source, side, singleView }) => {
    const a = exampleText(dataset, row, "model_a"), b = exampleText(dataset, row, "model_b"), generic = exampleText(dataset, row, "model");
    const model = side === "a" ? a ?? (singleView && !b ? generic : undefined) : side === "b" ? b ?? (singleView && !a ? generic : undefined) : generic ?? (!b ? a : undefined);
    return model ? [{ row, rowId: dataset.row_ids[row], model, source, key: JSON.stringify([dataset.row_ids[row], source.key]) }] : [];
  }));
}
export function modelOutcome(dataset, row, model) {
  const a = exampleText(dataset, row, "model_a"), b = exampleText(dataset, row, "model_b");
  const side = a === model && b !== model ? "a" : b === model && a !== model ? "b" : null;
  if (!side || !a || !b) return { winner: null, preference: null };
  const supplied = exampleText(dataset, row, "winner")?.toLowerCase();
  const winner = supplied === "tie" ? "tie" : ["a", "b"].includes(supplied) ? (supplied === side ? "win" : "loss") : null;
  const p = dataset.row_metadata.preference_probability?.[row];
  return { winner, preference: typeof p === "number" ? (side === "a" ? p : 1 - p) : null };
}
export function outcomeSummary(dataset, rows, model) {
  let wins = 0, losses = 0, ties = 0, softN = 0, softSum = 0;
  for (const row of rows) {
    const outcome = modelOutcome(dataset, row, model);
    if (outcome.winner === "win") wins++; else if (outcome.winner === "loss") losses++; else if (outcome.winner === "tie") ties++;
    if (outcome.preference !== null) { softN++; softSum += outcome.preference; }
  }
  const hardN = wins + losses + ties;
  return { wins, losses, ties, hardN, softN, win: hardN ? wins / hardN : null, preference: softN ? softSum / softN : null };
}
export function answerPrevalence(concept, answers) {
  const eligible = answers.filter(answer => conceptActivation(concept, answer.row, answer.source) !== null);
  const activeAnswers = eligible.filter(answer => modelConceptActive(concept, answer.row, answer.source));
  return { active: activeAnswers.length, total: eligible.length, rate: eligible.length ? activeAnswers.length / eligible.length : null, activeAnswers };
}
export function modelPairs(dataset, answers, model, opponent = null) {
  const byRow = new Map();
  for (const answer of answers) byRow.set(answer.row, [...(byRow.get(answer.row) ?? []), answer]);
  const pairs = [];
  for (const [row, observations] of byRow) {
    const a = exampleText(dataset, row, "model_a"), b = exampleText(dataset, row, "model_b");
    if (!a || !b || a === b || (a !== model && b !== model)) continue;
    const ownSide = a === model ? "a" : "b", otherSide = ownSide === "a" ? "b" : "a", otherModel = ownSide === "a" ? b : a;
    const own = observations.filter(answer => answer.model === model && answerSide(answer.source) === ownSide);
    const other = observations.filter(answer => answer.model === otherModel && answerSide(answer.source) === otherSide);
    if (own.length !== 1 || other.length !== 1 || (opponent && otherModel !== opponent) || !compatibleSources(own[0].source, other[0].source)) continue;
    pairs.push({ row, own: own[0], other: other[0] });
  }
  return pairs;
}
export function modelAssociation(dataset, concept, pairs, model, metric = "preference") {
  const observations = []; let higherN = 0, lowerN = 0, higherSum = 0, lowerSum = 0;
  for (const pair of pairs) {
    const own = conceptStrength(concept, pair.row, pair.own.source), other = conceptStrength(concept, pair.row, pair.other.source);
    if (own === null || other === null || pair.own.model !== model || own === other) continue;
    const outcome = modelOutcome(dataset, pair.row, model);
    const score = metric === "preference" ? outcome.preference : outcome.winner === null ? null : outcome.winner === "win" ? 1 : 0;
    if (score === null) continue;
    if (own > other) { higherN++; higherSum += score; } else { lowerN++; lowerSum += score; }
    observations.push({ answer: pair.own, difference: own - other, score });
  }
  const higherMean = higherN ? higherSum / higherN : null, lowerMean = lowerN ? lowerSum / lowerN : null;
  return { value: higherMean !== null && lowerMean !== null ? higherMean - lowerMean : null, higherMean, lowerMean, higherN, lowerN, observations };
}

export function modelDistribution(dataset, model, { sources = pooledAnswerSources(dataset) } = {}) {
  const answers = modelAnswers(dataset, dataset.row_ids.map((_, row) => row), sources).filter(answer => answer.model === model);
  return modelConcepts(sources[0]).map(concept => {
    const prevalence = answerPrevalence(concept, answers), support = promptSupport(dataset, prevalence.activeAnswers.map(answer => answer.row));
    return { concept, ...prevalence, support };
  });
}
export function modelPreferenceAssociations(dataset, model, opponent = null, { sources = pooledAnswerSources(dataset), metric = "preference" } = {}) {
  const allAnswers = modelAnswers(dataset, dataset.row_ids.map((_, row) => row), sources);
  const ownAnswers = allAnswers.filter(answer => answer.model === model), pairs = modelPairs(dataset, allAnswers, model, opponent);
  return modelConcepts(sources[0]).map(concept => {
    const prevalence = answerPrevalence(concept, ownAnswers), association = modelAssociation(dataset, concept, pairs, model, metric);
    return { concept, activity: prevalence.rate, active: prevalence.active, total: prevalence.total, ...association,
      support: promptSupport(dataset, association.observations.map(item => item.answer.row)), available: association.value !== null };
  });
}
export function compareAnswerActivity(dataset, firstModel, secondModel, { sources = pooledAnswerSources(dataset) } = {}) {
  const answers = modelAnswers(dataset, dataset.row_ids.map((_, row) => row), sources);
  const first = answers.filter(answer => answer.model === firstModel), second = answers.filter(answer => answer.model === secondModel);
  return modelConcepts(sources[0]).map(concept => {
    const a = answerPrevalence(concept, first), b = answerPrevalence(concept, second);
    return { concept, first: a.rate, second: b.rate, firstActive: a.active, firstTotal: a.total, secondActive: b.active, secondTotal: b.total,
      gap: a.rate === null || b.rate === null ? null : a.rate - b.rate,
      firstSupport: promptSupport(dataset, a.activeAnswers.map(answer => answer.row)), secondSupport: promptSupport(dataset, b.activeAnswers.map(answer => answer.row)) };
  });
}
export function comparePromptScores(dataset, firstModel, secondModel, { source = modelSourceGroups(dataset).prompt[0], metric = "preference" } = {}) {
  if (!source) return [];
  const concepts = modelConcepts(source), firstRows = modelPopulation(dataset, firstModel).rows, secondRows = modelPopulation(dataset, secondModel).rows;
  return concepts.map(concept => {
    const summarize = (model, rows) => {
      const activeRows = rows.filter(row => modelConceptActive(concept, row));
      const outcomes = outcomeSummary(dataset, activeRows, model), value = outcomes[metric];
      const scored = activeRows.filter(row => metric === "win" ? modelOutcome(dataset, row, model).winner !== null : modelOutcome(dataset, row, model).preference !== null);
      return { value, scoredRows: metric === "win" ? outcomes.hardN : outcomes.softN, support: promptSupport(dataset, scored), activeRows: activeRows.length };
    };
    const first = summarize(firstModel, firstRows), second = summarize(secondModel, secondRows);
    return { concept, first, second, gap: first.value === null || second.value === null ? null : first.value - second.value };
  });
}
export function sortModelResults(items, { by = "gap", direction = "desc" } = {}) {
  return [...items].sort((a, b) => {
    const av = by === "gap" ? a.gap : a[by] && typeof a[by] === "object" && Object.hasOwn(a[by], "value") ? a[by].value : a[by];
    const bv = by === "gap" ? b.gap : b[by] && typeof b[by] === "object" && Object.hasOwn(b[by], "value") ? b[by].value : b[by];
    if (av == null || bv == null) return av == null && bv == null ? a.concept.key.localeCompare(b.concept.key) : av == null ? 1 : -1;
    return (direction === "asc" ? av - bv : bv - av) || a.concept.key.localeCompare(b.concept.key);
  });
}


export function matchedBattleComparison(dataset, concept, pairs, metric = "preference") {
  const points = [], groups = { ownHigher: { points: [], scored: 0, mean: null }, equal: { points: [], scored: 0, mean: null }, otherHigher: { points: [], scored: 0, mean: null } };
  const sums = { ownHigher: 0, equal: 0, otherHigher: 0 }; let unavailable = 0;
  for (const pair of pairs) {
    const x = conceptStrength(concept, pair.row, pair.own.source), y = conceptStrength(concept, pair.row, pair.other.source);
    if (x === null || y === null) { unavailable++; continue; }
    const outcome = modelOutcome(dataset, pair.row, pair.own.model);
    const score = metric === "preference" ? outcome.preference : outcome.winner === null ? null : outcome.winner === "win" ? 1 : 0;
    const point = { pair, x, y, score, winner: outcome.winner }, key = x > y ? "ownHigher" : x === y ? "equal" : "otherHigher";
    points.push(point); groups[key].points.push(point);
    if (score !== null) { groups[key].scored++; sums[key] += score; }
  }
  for (const key of Object.keys(groups)) groups[key].mean = groups[key].scored ? sums[key] / groups[key].scored : null;
  return { points, groups, unavailable };
}
export function matchedActivationRange(points) {
  let minimum = 0, maximum = 0;
  for (const point of points) { minimum = Math.min(minimum, point.x, point.y); maximum = Math.max(maximum, point.x, point.y); }
  return { minimum, maximum: minimum === maximum ? 1 : maximum };
}
