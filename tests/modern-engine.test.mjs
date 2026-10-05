import assert from "node:assert/strict";
import test from "node:test";
import { createEngine } from "../src/modern/shared/engine.js";
import { parseViewerDataset, conceptChoices, conceptObservations, observationKey, promptSupport, matchingObservations } from "../src/modern/shared/index.js";
import { genericFixture, pairedFixture, artifacts, viewerVersion, jsonBytes, sha256 } from "./modern-fixture.mjs";
import { differenceFixture } from "./difference-fixture.mjs";

const open = (fixture, options = {}) => createEngine({ dataUrl: "data/viewer-data.json", bundleUrl: "viewer-bundle.json", buildUrl: "viewer-build.json", expectedViewerVersion: viewerVersion, fetcher: fixture.fetcher, ...options });

test("observation identities and populations reuse source groups without sharing mutable result rows", () => {
  const dataset = parseViewerDataset(pairedFixture());
  const choices = conceptChoices(dataset), answers = choices.filter(choice => choice.source.view.role === "response_a");
  const expected = dataset.row_ids.flatMap((rowId, row) => answers[0].sources.map(source => ({
    key: JSON.stringify([rowId, source.key]), row, rowId, source,
  })));
  let identityReads = 0;
  for (const source of answers[0].sources) {
    const key = source.key;
    Object.defineProperty(source, "key", { get() { identityReads++; return key; } });
  }
  const first = conceptObservations(answers[0]);
  assert.deepEqual(first, expected);
  assert.ok(identityReads > 0);
  identityReads = 0;
  assert.deepEqual(conceptObservations(answers[1]), expected);
  assert.equal(observationKey(1, answers[0].sources[1]), expected[3].key);
  assert.equal(identityReads, 0, "changing feature must not regenerate identical source-row keys");
  first[0].row = 99; first[0].key = "caller edit"; first.pop();
  assert.deepEqual(conceptObservations(answers[0]), expected);
  const prompt = choices.find(choice => choice.source.view.role === "prompt");
  assert.equal(conceptObservations(prompt).length, 3);
  assert.notEqual(conceptObservations(prompt)[0].key, expected[0].key);
  const changed = pairedFixture();
  changed.row_ids = changed.prompt.row_ids = changed.row_ids.map(id => `other-${id}`);
  const other = conceptChoices(parseViewerDataset(changed)).find(choice => choice.source.view.role === "response_a");
  assert.equal(conceptObservations(other)[0].rowId, "other-synthetic-1");
  assert.notEqual(conceptObservations(other)[0].key, expected[0].key);
  assert.deepEqual(conceptObservations(answers[0]), expected);
});

function replaceFile(fixture, path, value) {
  const bytes = jsonBytes(value);
  fixture.files.set(path, bytes);
  Object.assign(fixture.bundle.files.find(file => file.path === path), { size_bytes: bytes.length, sha256: sha256(bytes) });
}

function shardedFixture(count = 129) {
  const data = pairedFixture();
  data.row_ids = Array.from({ length: count }, (_, row) => `shard-row-${row}`);
  data.prompt.row_ids = [...data.row_ids];
  for (const space of [data, data.prompt]) {
    for (const view of Object.values(space.views)) view.values = data.row_ids.map((_, row) => view.values[row % 3]);
    for (const [key, values] of Object.entries(space.row_metadata))
      space.row_metadata[key] = data.row_ids.map((_, row) => values[row % 3]);
  }
  const texts = data.row_ids.map((_, row) => `Answer ${row}`);
  data.row_metadata.response_a = new Array(count).fill(null);
  data.answer_text_shards = { schema: "prefscope.viewer_answer_text_shards", schema_version: 1,
    files: Array.from({ length: Math.ceil(count / 128) }, (_, index) => {
      const start = index * 128;
      return { start, end: Math.min(start + 128, count), path: `data/answer-text/${start}.json` };
    }) };
  const fixture = artifacts(data);
  replaceFile(fixture, "data/viewer-data.json", data);
  for (const file of data.answer_text_shards.files) {
    const bytes = jsonBytes({ start: file.start, row_ids: data.row_ids.slice(file.start, file.end), texts: texts.slice(file.start, file.end) });
    fixture.files.set(file.path, bytes);
    fixture.bundle.files.push({ path: file.path, size_bytes: bytes.length, sha256: sha256(bytes) });
  }
  return fixture;
}

test("relationship cohort reuse preserves scope, ranking and independently mutable results", async () => {
  const engine = await open(artifacts(pairedFixture()));
  const owners = ["a", "b", "prompt"].flatMap(owner => [0, 1, 2].map(row => engine.observation(row, owner)));
  let lookups = 0;
  class CountedKeys extends Set {
    has(key) { lookups++; return super.has(key); }
  }
  const allowedKeys = new CountedKeys(owners.map(item => item.observationKey));
  const options = { allowedKeys, minimumPrompts: 0 };
  const original = engine.relationships("answer:3", options);
  assert.ok(lookups > 0);
  assert.ok(original.groups.some(group => group.rows.length));
  lookups = 0;
  assert.deepEqual(engine.relationships("answer:3", options), original);
  assert.equal(lookups, 0, "unchanged cohort must not rescan observations");
  for (const display of [{ measure: "increase" }, { limit: 1 }, { minimumPrompts: 2 }]) {
    const cached = engine.relationships("answer:3", { ...options, ...display });
    assert.equal(lookups, 0, "display changes reuse the cohort");
    const direct = engine.relationships("answer:3", { ...options, ...display, populationFilter: rows => rows });
    assert.deepEqual(cached, direct);
    lookups = 0;
  }
  original.groups[0].rows[0].frequency = -999;
  original.groups[0].rows.length = 0;
  assert.deepEqual(engine.relationships("answer:3", options),
    engine.relationships("answer:3", { ...options, populationFilter: rows => rows }));
  allowedKeys.delete(owners[0].observationKey);
  lookups = 0;
  const changed = engine.relationships("answer:3", options);
  assert.ok(lookups > 0, "mutating the caller's Set invalidates the cohort");
  assert.deepEqual(changed, engine.relationships("answer:3", { ...options, populationFilter: rows => rows }));
  for (const key of ["answer:3", "answer:7", "prompt:6:positive"])
    for (const keys of [undefined, new Set(), new Set([...allowedKeys].reverse())])
      assert.deepEqual(engine.relationships(key, { allowedKeys: keys, minimumPrompts: 0 }),
        engine.relationships(key, { allowedKeys: keys, minimumPrompts: 0, populationFilter: rows => rows }));
  const first = engine.relationships("answer:3", { ...options, populationFilter: rows => rows.filter(row => row.row === 0) });
  const second = engine.relationships("answer:3", { ...options, populationFilter: rows => rows.filter(row => row.row === 2) });
  assert.notDeepEqual(first, second, "custom callbacks must be reevaluated");
});

test("generic v1 answers retain owned text, activity, model filters and cursors without maps", async () => {
  const engine = await open(artifacts(genericFixture()));
  assert.deepEqual(engine.concepts.prompt, []);
  assert.deepEqual(engine.map.points.answer, []);
  assert.deepEqual(engine.answerModels.map(model => model.rawId), ["synthetic/one", "synthetic/two"]);
  const answers = engine.filterAnswers(["answer:3"]);
  assert.deepEqual(answers.map(answer => [answer.rowIndex, answer.side, answer.role]), [[0, "a", "response"], [2, "a", "response"]]);
  assert.equal(engine.record(0).answerA, "Synthetic first answer.");
  assert.equal(engine.record(0).answerB, undefined);
  assert.equal(engine.record(0).modelA.rawId, "synthetic/one");
  assert.equal(engine.record(0).preferenceA, null);
  assert.deepEqual(engine.filterAnswers(["answer:3"], "model:synthetic/one"), answers);
  assert.deepEqual(engine.filterAnswers(["answer:3"], "model:synthetic/two"), []);
  assert.deepEqual(engine.filterAnswers(["answer:3"], "model:unknown"), []);
  assert.deepEqual(engine.observation(0, "a"), answers[0]);
  assert.deepEqual(engine.observation(0, "a").cursor, { row_id: "synthetic-1", source: '["main","response"]' });
  for (const [row, owner] of [[0, "b"], [0, "prompt"], [0, "unknown"], [-1, "a"], [3, "a"], [0.5, "a"]])
    assert.equal(engine.observation(row, owner), null);
  const histogram = engine.answerConceptDistribution("answer:3", answers[0].cursor);
  assert.deepEqual([histogram.population.available, histogram.population.total, histogram.population.active], [true, 3, 2]);
  assert.deepEqual(histogram.current, { side: "a", state: "active", magnitude: 1 });
  assert.equal(histogram.population.bins.reduce((sum, bin) => sum + bin.count, 0), 2);
  assert.equal(engine.activationItems(0, "a", "answer:3")[0].value, 1);
});

test("generic v1 can omit model identity and answer text without inventing either", async () => {
  const data = genericFixture(); data.row_metadata = {};
  const engine = await open(artifacts(data));
  assert.deepEqual(engine.answerModels, []);
  assert.equal(engine.record(0).answerA, undefined);
  assert.equal(engine.record(0).modelA, undefined);
  assert.equal(engine.filterAnswers(["answer:3"]).length, 2);
});

test("answer text shards load only requested rows and preserve exact row ownership", async () => {
  const fixture = shardedFixture(), requested = [];
  const engine = await open(fixture, { fetcher: path => { requested.push(path); return fixture.fetcher(path); } });
  assert.equal(engine.record(0).answerA, undefined);
  assert.equal(engine.hasFullAnswer(0), false);
  assert.equal(engine.hasFullAnswer(128), false);
  assert.equal(engine.hasFullAnswer(-1), false);
  await Promise.all([engine.ensureAnswerTexts([0, 127]), engine.ensureAnswerTexts([1])]);
  assert.deepEqual(requested.filter(path => path.includes("answer-text/")), ["data/answer-text/0.json"]);
  assert.equal(engine.record(127).answerA, "Answer 127");
  assert.equal(engine.record(128).answerA, undefined);
  assert.equal(engine.hasFullAnswer(127), true);
  await engine.ensureAnswerTexts([128, 128]);
  assert.equal(engine.record(128).answerA, "Answer 128");
  await engine.ensureAllAnswerTexts();
  assert.equal(requested.filter(path => path.includes("answer-text/")).length, 2);
  await assert.rejects(engine.ensureAnswerTexts([129]), /valid dataset rows/);
  const old = await open(artifacts(pairedFixture()));
  assert.equal(old.hasFullAnswer(0), true);
  await old.ensureAnswerTexts([0]);
  await old.ensureAllAnswerTexts();
  assert.equal(old.record(0).answerA, "Synthetic A one.");
});

test("missing, damaged and mismatched answer text shards fail without marking rows loaded", async () => {
  for (const change of ["missing", "digest", "row", "start", "text"]) {
    const fixture = shardedFixture(), path = "data/answer-text/0.json";
    if (change === "missing") fixture.files.delete(path);
    else if (change === "digest") fixture.files.set(path, jsonBytes({ changed: true }));
    else {
      const value = JSON.parse(new TextDecoder().decode(fixture.files.get(path)));
      if (change === "row") value.row_ids[127] = "shard-row-128";
      if (change === "start") value.start = 1;
      if (change === "text") value.texts[127] = {};
      replaceFile(fixture, path, value);
    }
    const engine = await open(fixture);
    await assert.rejects(engine.ensureAnswerTexts([127]), /404|does not match|Invalid answer text shard/);
    assert.equal(engine.hasFullAnswer(127), false);
    assert.equal(engine.record(127).answerA, undefined);
  }
});

test("bulk answer text loading limits concurrent shard requests", async () => {
  const fixture = shardedFixture(769);
  let inFlight = 0, peak = 0;
  const engine = await open(fixture, { fetcher: async path => {
    if (path.includes("answer-text/")) {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setImmediate(resolve));
      inFlight--;
    }
    return fixture.fetcher(path);
  } });
  await engine.ensureAllAnswerTexts();
  assert.equal(peak, 4);
  assert.equal(engine.record(768).answerA, "Answer 768");
});

test("a failed shard can be retried without exposing its text early", async () => {
  const fixture = shardedFixture(), path = "data/answer-text/0.json", bytes = fixture.files.get(path);
  fixture.files.delete(path);
  const engine = await open(fixture);
  await assert.rejects(engine.ensureAnswerTexts([0]), /404/);
  assert.equal(engine.hasFullAnswer(0), false);
  fixture.files.set(path, bytes);
  await engine.ensureAnswerTexts([0]);
  assert.equal(engine.hasFullAnswer(0), true);
  assert.equal(engine.record(0).answerA, "Answer 0");
});

test("invalid answer text descriptors fail before fetching shards", async () => {
  for (const change of ["missing-file", "range", "core-text", "unsafe-path"]) {
    const fixture = shardedFixture();
    if (change === "missing-file") fixture.bundle.files = fixture.bundle.files.filter(file => file.path !== "data/answer-text/0.json");
    if (change === "range") fixture.data.answer_text_shards.files[1].start = 127;
    if (change === "core-text") fixture.data.row_metadata.response_a[127] = "unexpected";
    if (change === "unsafe-path") fixture.data.answer_text_shards.files[0].path = "../wrong.json";
    replaceFile(fixture, "data/viewer-data.json", fixture.data);
    await assert.rejects(open(fixture), /Invalid answer text shard descriptor/);
  }
});

test("v2 paired owners, signed prompts, optional preferences and exact source cursors remain distinct", async () => {
  const engine = await open(artifacts(pairedFixture()));
  const negative = engine.filterPromptObservations(["prompt:12:negative"]);
  assert.deepEqual(negative.map(item => item.rowIndex), [0, 2]);
  const page = engine.pageObservationResults(negative, negative[0].cursor, 1);
  assert.deepEqual(page.cursor, engine.observation(2, "prompt").cursor);
  const prompts = engine.promptConceptDistribution("prompt:12:negative", page.cursor);
  assert.deepEqual([prompts.population.total, prompts.population.active, prompts.current.magnitude], [3, 2, 3]);
  assert.deepEqual(prompts.population.bins.map(bin => bin.count), [0, 0, 1, 0, 0, 0, 0, 1]);
  assert.equal(engine.promptConceptDistribution("prompt:12:positive", page.cursor).current.state, "inactive");
  assert.equal(engine.promptConceptDistribution("prompt:12:negative", engine.observation(2, "a").cursor).current.state, "unavailable");
  const owned = engine.filterAnswers(["answer:7"], "model:synthetic/two");
  assert.deepEqual(owned.map(item => [item.rowIndex, item.side]), [[0, "b"], [2, "a"]]);
  assert.equal(engine.record(2).modelA.rawId, "synthetic/two");
  assert.equal(engine.record(2).modelB.rawId, "synthetic/one");
  assert.deepEqual([engine.record(0).preferenceA, engine.record(0).preferenceB], [0, 1]);
  assert.deepEqual([engine.record(1).preferenceA, engine.record(1).preferenceB], [null, null]);
  const population = engine.answerConceptDistribution("answer:7", owned[0].cursor, "model:synthetic/two");
  assert.deepEqual([population.population.total, population.population.active, population.current.side, population.current.magnitude], [3, 2, "b", 4]);
});

test("manifest pins the executing version while optional dev callers remain compatible", async () => {
  const fixture = artifacts();
  await assert.rejects(open(fixture, { expectedViewerVersion: "different" }), /executing Viewer version/);
  await open(fixture, { expectedViewerVersion: undefined });
});

test("bundle manifest rejects unsafe paths, missing files, duplicates and malformed identities", async () => {
  const cases = [
    [bundle => { bundle.schema_version = 2; }, /manifest schema/],
    [bundle => { bundle.producer.package = "other"; }, /producer identity/],
    [bundle => { bundle.viewer.package = "other"; }, /viewer identity/],
    [bundle => { bundle.viewer.build_sha256 = "bad"; }, /build digest/],
    [bundle => { bundle.data.path = "https://evil.invalid/data"; }, /loaded viewer data/],
    [bundle => { bundle.data.schema_version = 1; }, /loaded viewer data/],
    [bundle => { bundle.viewer.build.path = "../viewer-build.json"; }, /build contract/],
    [bundle => { bundle.files.push({ ...bundle.files[0] }); }, /duplicate/],
    [bundle => { bundle.files = bundle.files.filter(file => file.path !== "index.html"); }, /missing index.html/],
    [bundle => { bundle.files[0].size_bytes = -1; }, /invalid size/],
    [bundle => { bundle.files[0].size_bytes = 1.5; }, /invalid size/],
    [bundle => { bundle.files[0].sha256 = "bad"; }, /digest/],
    [bundle => { bundle.files.push({ ...bundle.files[0], path: "viewer-bundle.json" }); }, /must exclude/],
    [bundle => { bundle.extra = true; }, /invalid fields/],
  ];
  for (const path of ["../outside", "/absolute", "a//b", "a/./b", "a\\b", "https://evil.invalid/asset", "a\u0000b"])
    cases.push([bundle => { bundle.files.push({ ...bundle.files[0], path }); }, /normalized relative/]);
  for (const [mutate, error] of cases) {
    const fixture = artifacts(); mutate(fixture.bundle);
    await assert.rejects(open(fixture), error);
  }
});

test("loaded build identity and compatibility must agree with the manifest", async () => {
  for (const change of [{ package: "other" }, { version: "other" }, { schema_version: 2 }, { supported_data_schemas: [] }]) {
    const fixture = artifacts(); replaceFile(fixture, "viewer-build.json", { ...fixture.build, ...change });
    await assert.rejects(open(fixture), /identity or compatibility/);
  }
  const fixture = artifacts();
  fixture.build.supported_data_schemas = [{ schema: "prefscope.viewer_data", versions: [1] }];
  fixture.bundle.viewer.build.supported_data_schemas = fixture.build.supported_data_schemas;
  replaceFile(fixture, "viewer-build.json", fixture.build);
  await assert.rejects(open(fixture), /does not support/);
});

test("missing, malformed and tampered data or build bytes fail without fallback", async () => {
  for (const path of ["data/viewer-data.json", "viewer-build.json"]) {
    const missing = artifacts(); missing.files.delete(path);
    await assert.rejects(open(missing), /404/);
    const changed = artifacts();
    const value = path.startsWith("data") ? { ...changed.data, provenance: { title: "altered" } } : { ...changed.build, note: "altered" };
    changed.files.set(path, jsonBytes(value));
    await assert.rejects(open(changed), /does not match/);
  }
  const missingManifest = artifacts();
  await assert.rejects(open(missingManifest, { fetcher: path => path === "viewer-bundle.json" ? Promise.resolve({ ok: false, status: 404, statusText: "Not Found" }) : missingManifest.fetcher(path) }), /404/);
  const html = artifacts(); html.files.set("data/viewer-data.json", new TextEncoder().encode("<!doctype html><title>Fallback</title>"));
  await assert.rejects(open(html), SyntaxError);
  const wrongShape = artifacts(); wrongShape.data.views.z_a.values[0] = [1]; replaceFile(wrongShape, "data/viewer-data.json", wrongShape.data);
  await assert.rejects(open(wrongShape), /finite codes/);
});

function fixedPairEvidenceFixture() {
  const data = pairedFixture(), rows = Array.from({ length: 6 }, (_, index) => `evidence-${index}`);
  data.row_ids = rows;
  data.row_metadata = {
    model_a: rows.map(() => "synthetic/one"), model_b: rows.map(() => "synthetic/two"),
    prompt: rows.map(row => `Synthetic prompt ${row}`),
    response_a: rows.map(row => `Synthetic A ${row}`), response_b: rows.map(row => `Synthetic B ${row}`),
    preference_probability: [0.8, 0.2, 1, null, 0, 1],
  };
  data.views.z_a.values = [[4, -1], [1, -3], [2, -2], [5, -5], [0, 0], [4, -4]];
  data.views.z_b.values = [[1, -4], [3, -1], [2, -2], [1, -1], [4, -2], [0, 0]];
  data.views.z_a.activation_polarity = data.views.z_b.activation_polarity = "signed";
  data.prompt.row_ids = rows;
  data.prompt.views.z_prompt.values = [[-1, 0], [2, 1], [-3, 1], [-4, 1], [-5, 0], [-6, 1]];
  return data;
}

test("model evidence reproduces preference association groups exactly while activity retains unscored answers", async () => {
  const engine = await open(artifacts(fixedPairEvidenceFixture()));
  assert.deepEqual(engine.map.points.answer, []);
  for (const side of ["a", "b"]) {
    const evidence = engine.modelEvidence("answer:3", side, "preference");
    const association = engine.preferenceAssociations(side).find(item => item.key === "answer:3");
    assert.deepEqual(evidence.map(item => item.rowIndex), [0, 1, 4, 5]); // Equal and unscored pairs excluded.
    for (const group of ["higher", "lower"]) {
      const selected = evidence.filter(item => item.group === group);
      assert.equal(selected.length, association[`${group}N`]);
      const mean = selected.reduce((sum, item) => sum + item.preference, 0) / selected.length;
      assert.ok(Math.abs(mean - association[`${group}Mean`]) < 1e-12);
      assert.ok(selected.every(item => group === "higher" ? item.strength > item.otherStrength : item.strength < item.otherStrength));
    }
    assert.ok(Math.abs(association.value - (association.higherMean - association.lowerMean)) < 1e-12);
    for (const item of evidence) {
      const { preference, strength, otherStrength, group, ...owned } = item;
      assert.deepEqual(owned, engine.observation(item.rowIndex, side));
      assert.equal(preference, side === "a" ? engine.record(item.rowIndex).preferenceA : engine.record(item.rowIndex).preferenceB);
    }
    const activity = engine.modelEvidence("answer:3", side);
    const distribution = engine.distributions(side).find(item => item.key === "answer:3");
    assert.equal(activity.length, distribution.active);
    assert.equal(activity.find(item => item.rowIndex === 3).preference, null);
    assert.ok(activity.some(item => item.rowIndex === 2)); // Equal strengths are still active evidence.
    assert.ok(activity.every(item => item.group === "active" && item.strength > 0 && item.otherStrength === null));
  }
  assert.deepEqual(engine.modelEvidence("answer:3", "a", "preference").find(item => item.rowIndex === 4), {
    ...engine.observation(4, "a"), preference: 0, strength: 0, otherStrength: 4, group: "lower",
  });
  const signed = engine.modelEvidence("answer:7", "a", "preference");
  assert.equal(signed.find(item => item.rowIndex === 0).strength, -1);
  assert.equal(signed.find(item => item.rowIndex === 0).otherStrength, -4);
  assert.equal(signed.find(item => item.rowIndex === 0).group, "higher");
  for (const [key, side, mode] of [["missing", "a", "preference"], ["missing", "a", "activity"], ["answer:3", "missing", "activity"], ["answer:3", "a", "missing"]])
    assert.deepEqual(engine.modelEvidence(key, side, mode), []);
});

test("prompt model evidence uses exactly the scored comparison population and prompt-owned cursors", async () => {
  const engine = await open(artifacts(fixedPairEvidenceFixture()));
  assert.deepEqual(engine.map.points.prompt, []);
  for (const key of ["prompt:12:negative", "prompt:12:positive"]) {
    const comparison = engine.compare("prompt").find(item => item.key === key);
    for (const side of ["a", "b"]) {
      const evidence = engine.modelEvidence(key, side, "prompt");
      assert.equal(evidence.length, side === "a" ? comparison.supportA : comparison.supportB);
      assert.ok(Math.abs(evidence.reduce((sum, item) => sum + item.preference, 0) / evidence.length - comparison[side]) < 1e-12);
      assert.ok(evidence.every(item => item.rowIndex !== 3 && item.strength > 0 && item.otherStrength === null && item.group === "active"));
      for (const item of evidence) {
        const { preference, strength, otherStrength, group, ...owned } = item;
        assert.deepEqual(owned, engine.observation(item.rowIndex, "prompt"));
      }
    }
  }
  assert.deepEqual(engine.modelEvidence("prompt:12:negative", "a", "prompt").map(item => item.rowIndex), [0, 2, 4, 5]);
  assert.deepEqual(engine.modelEvidence("missing", "a", "prompt"), []);
  const generic = await open(artifacts(genericFixture()));
  assert.deepEqual(generic.modelEvidence("answer:3", "a", "preference"), []);
  assert.deepEqual(generic.modelEvidence("prompt:12:positive", "a", "prompt"), []);
});

test("concept count snapshots match exact filters for every signed concept and model scope", async () => {
  for (const data of [genericFixture(), pairedFixture(), fixedPairEvidenceFixture()]) {
    const engine = await open(artifacts(data));
    for (const concept of engine.concepts.prompt)
      assert.equal(engine.conceptCounts("prompt").get(concept.key), engine.filterPromptObservations([concept.key]).length);
    for (const scope of ["all", "a", "b", ...engine.answerModels.map(model => `model:${model.rawId}`), "model:missing", "invalid", null]) {
      const counts = engine.conceptCounts("answer", scope);
      for (const concept of engine.concepts.answer)
        assert.equal(counts.get(concept.key), engine.filterAnswers([concept.key], scope).length, `${concept.key} ${scope}`);
      const expected = [...counts]; counts.clear();
      assert.deepEqual([...engine.conceptCounts("answer", scope)], expected);
    }
    const promptCounts = engine.conceptCounts("prompt"), expected = [...promptCounts]; promptCounts.clear();
    assert.deepEqual([...engine.conceptCounts("prompt")], expected);
    assert.equal(engine.conceptCounts("invalid").size, 0);
  }
});

test("cached model results remain isolated from caller sorting, edits and other dataset instances", async () => {
  const engine = await open(artifacts(fixedPairEvidenceFixture()));
  const calls = [() => engine.distributions("a"), () => engine.distributions("b"),
    () => engine.preferenceAssociations("a"), () => engine.preferenceAssociations("b"),
    () => engine.compare("prompt"), () => engine.compare("answer"),
    () => engine.modelEvidence("answer:3", "a", "preference"), () => engine.modelEvidence("answer:3", "b", "activity")];
  for (const call of calls) {
    const expected = call(), altered = call();
    assert.ok(altered.length);
    altered.reverse(); altered[0].name = "Changed by caller";
    if (altered[0].cursor) altered[0].cursor.source = "Changed by caller";
    altered.pop();
    assert.deepEqual(call(), expected);
  }
  const different = fixedPairEvidenceFixture();
  different.views.z_a.values = different.views.z_a.values.map(row => row.map(() => 0));
  const other = await open(artifacts(different));
  assert.ok(other.distributions("a").every(item => item.active === 0));
  assert.ok(engine.distributions("a").some(item => item.active > 0));
  assert.deepEqual(engine.distributions("invalid"), []);
  assert.deepEqual(engine.preferenceAssociations("invalid"), []);
});

test("prompt support preserves identity precedence, type, missing-row fallback and dataset isolation", () => {
  const dataset = {
    row_ids: ["one", "two", "three", "four", "five", "six"],
    row_metadata: { prompt_id: [7, 7, null, "7", null, null], instruction_id: [null, null, 7, null, null, null],
      prompt: ["ignored", "ignored", "ignored", "ignored", "repeat", null] },
  };
  assert.deepEqual(promptSupport(dataset, [0, 1, 0]), { count: 1, unit: "prompts" });
  assert.deepEqual(promptSupport(dataset, [0, 1, 2, 3, 4]), { count: 4, unit: "prompts" });
  assert.deepEqual(promptSupport(dataset, [0, 1, 5]), { count: 3, unit: "rows" });
  assert.deepEqual(promptSupport(dataset, [0, 1]), { count: 1, unit: "prompts" }); // Missing unselected rows do not change units.
  assert.deepEqual(promptSupport(dataset, []), { count: 0, unit: "prompts" });
  const reloaded = structuredClone(dataset); reloaded.row_metadata.prompt_id[0] = 8;
  assert.deepEqual(promptSupport(reloaded, [0, 1]), { count: 2, unit: "prompts" });
  assert.deepEqual(promptSupport(dataset, [0, 1]), { count: 1, unit: "prompts" });
  const nested = structuredClone(dataset);
  nested.prompt = { row_metadata: { prompt_id: [null, null, 7, null, null, null], prompt: [null, null, null, null, null, "repeat"] } };
  assert.deepEqual(promptSupport(nested, [0, 2]), { count: 1, unit: "prompts" }); // Nested prompt ID precedes top-level instruction ID.
  assert.deepEqual(promptSupport(nested, [4, 5]), { count: 1, unit: "prompts" });
});

test("empty observation queries preserve matching population and nonempty queries still inspect owned text", () => {
  const dataset = parseViewerDataset(genericFixture()), concept = conceptChoices(dataset).find(item => item.featureId === 3);
  const rows = query => matchingObservations(dataset, [concept], concept, { query }).map(item => item.row);
  assert.deepEqual(rows(""), [0, 2]);
  assert.deepEqual(rows("  "), [0, 2]);
  assert.deepEqual(rows("FIRST ANSWER"), [0]);
  assert.deepEqual(rows("second answer"), []);
});

test("concept explanations preserve supplied text and stay with their own pole", async () => {
  const data = pairedFixture();
  const catalog = (space, rows) => ({ feature_space: space.feature_space, provenance: {}, column_sources: {},
    table: { columns: ["feature_id", "name", "description"], index: rows.map((_, i) => i), data: rows } });
  data.catalog = catalog(data, [[3, "Answer concept", "  Supplied <answer> explanation.  "], [7, "No explanation", 42]]);
  data.prompt.catalog = catalog(data.prompt, [[12, "Prompt concept", "Default positive explanation."], [6, "Another prompt", "   "]]);
  let engine = await open(artifacts(data));
  assert.equal(engine.concepts.answer.find(x => x.featureId === 3).description, "Supplied <answer> explanation.");
  assert.equal(engine.datasetConcepts("answer").find(x => x.featureId === 3).description, "Supplied <answer> explanation.");
  assert.equal(engine.concepts.answer.find(x => x.featureId === 7).description, "");
  assert.equal(engine.concepts.prompt.find(x => x.key === "prompt:12:positive").description, "Default positive explanation.");
  assert.equal(engine.concepts.prompt.find(x => x.key === "prompt:12:negative").description, "");
  assert.equal(engine.concepts.prompt.find(x => x.featureId === 6).description, "");
  data.tables.prompt_pole_labels = { columns: ["feature_id", "pole", "name", "description"], index: [0, 1],
    data: [[12, "positive", "Positive", "Pole-specific positive."], [12, "negative", "Negative", "Pole-specific negative."]] };
  engine = await open(artifacts(data));
  assert.equal(engine.concepts.prompt.find(x => x.key === "prompt:12:positive").description, "Pole-specific positive.");
  assert.equal(engine.concepts.prompt.find(x => x.key === "prompt:12:negative").description, "Pole-specific negative.");
});

test("reader activation sorting follows the selected pole and exact answer owner", async () => {
  const engine = await open(artifacts(pairedFixture()));
  const prompts = engine.filterPromptObservations(["prompt:12:negative"]);
  assert.deepEqual(engine.sortObservations(prompts, "prompt:12:negative", "strongest").map(x => x.rowIndex), [2, 0]);
  assert.deepEqual(engine.sortObservations(prompts, "prompt:12:negative", "weakest"), prompts);
  const answers = engine.filterAnswers(["answer:7"]), original = answers.slice();
  const sorted = engine.sortObservations(answers, "answer:7", "strongest");
  assert.deepEqual(sorted.map(x => [x.rowIndex, x.side]), [[0, "b"], [1, "a"], [2, "a"], [2, "b"]]);
  assert.deepEqual(engine.sortObservations(answers, "answer:7", "weakest").map(x => [x.rowIndex, x.side]), [[2, "a"], [2, "b"], [1, "a"], [0, "b"]]);
  assert.deepEqual(answers, original);
  assert.equal(engine.sortObservations(answers, "answer:7", "dataset"), answers);
  const first = engine.pageObservationResults(sorted, null);
  assert.deepEqual(first.current, sorted[0]);
  assert.deepEqual(engine.pageObservationResults(sorted, first.cursor, 1).current, sorted[1]);
  const scoped = engine.filterAnswers(["answer:7"], "model:synthetic/two");
  assert.deepEqual(engine.sortObservations(scoped, "answer:7", "strongest").map(x => [x.rowIndex, x.side]), [[0, "b"], [2, "a"]]);
});

test("observation strengths preserve renamed paired owners and both signed prompt poles", async () => {
  const data = pairedFixture();
  data.views = { left_vectors: data.views.z_a, right_vectors: data.views.z_b };
  data.prompt.views = { encoded_prompt: data.prompt.views.z_prompt };
  const engine = await open(artifacts(data));
  const prompts = [0, 1, 2].map(row => engine.observation(row, "prompt"));
  const answers = [0, 1, 2].flatMap(row => ["a", "b"].map(owner => engine.observation(row, owner)));
  const values = (rows, key) => [...engine.observationStrengths(rows, key).values()];
  assert.deepEqual(values(prompts, "prompt:12:positive"), [0, 2, 0]);
  assert.deepEqual(values(prompts, "prompt:12:negative"), [1, 0, 3]);
  assert.deepEqual(values(answers, "answer:3"), [1, 0, 0, 2, 3, 0]);
  assert.deepEqual(values(answers, "answer:7"), [0, 4, 2, 0, 1, 1]);
  assert.deepEqual([...engine.observationStrengths(answers, "answer:7").keys()], answers.map(row => row.observationKey));
  assert.deepEqual(values(prompts, "answer:3"), [null, null, null]);
  assert.deepEqual(values(answers, "prompt:12:negative"), Array(6).fill(null));
});

test("observation strengths distinguish generic inactivity from unavailable measurements", async () => {
  const data = genericFixture();
  data.views = { completion_vectors: data.views.response };
  data.views.completion_vectors.values[0] = [true, false];
  const engine = await open(artifacts(data));
  const rows = [0, 1, 2].map(row => engine.observation(row, "a"));
  const missing = [
    { ...rows[0], observationKey: "absent-source", sourceKey: "absent-source" },
    { ...rows[0], observationKey: "absent-row", rowIndex: 99, rowId: "absent-row" },
  ];
  assert.deepEqual([...engine.observationStrengths([...rows, ...missing], "answer:3").values()], [1, 0, 3, null, null]);
  assert.deepEqual([...engine.observationStrengths(rows, "answer:999").values()], [null, null, null]);
  assert.deepEqual(engine.observationStrengths([], "answer:3"), new Map());
  const sortedKeys = order => engine.sortObservations([...missing, ...rows], "answer:3", order).map(row => row.observationKey);
  assert.deepEqual(sortedKeys("strongest"), [rows[2], rows[0], rows[1], ...missing].map(row => row.observationKey));
  assert.deepEqual(sortedKeys("weakest"), [rows[1], rows[0], rows[2], ...missing].map(row => row.observationKey));
});

test("batch strengths and sorting read the selected measurement once per observation", async () => {
  const engine = await open(artifacts(genericFixture()));
  const rows = [0, 1, 2].map(row => engine.observation(row, "a"));
  const source = engine.concepts.answer.find(item => item.key === "answer:3").choice.source;
  let reads = 0;
  for (const row of source.view.values) {
    const value = row[0];
    Object.defineProperty(row, 0, { get() { reads++; return value; } });
    Object.defineProperty(row, 1, { get() { throw new Error("Unrelated feature scanned"); } });
  }
  assert.deepEqual([...engine.observationStrengths(rows, "answer:3").values()], [1, 0, 3]);
  assert.equal(reads, rows.length);
  reads = 0;
  assert.deepEqual(engine.sortObservations(rows, "answer:3", "strongest"), [rows[2], rows[0], rows[1]]);
  assert.equal(reads, rows.length);
});


test("concept type metadata reaches Viewer concepts", async () => {
  const data = genericFixture();
  data.catalog = {
    feature_space: data.feature_space,
    provenance: {},
    column_sources: {},
    table: {
      columns: ["feature_id", "name", "concept_type"],
      index: [0, 1],
      data: [[3, "Typed topic", "topic"], [7, "Typed behavior", "response_behavior"]],
    },
  };
  const engine = await open(artifacts(data));
  assert.equal(engine.concepts.answer.find(item => item.featureId === 3).conceptType, "topic");
  assert.equal(engine.concepts.answer.find(item => item.featureId === 7).conceptType, "response_behavior");
});

test("difference-only lenses retain pair ownership, both poles and supplied battle records", async () => {
  for (const orientation of ["a_minus_b", "b_minus_a"]) {
    const data = differenceFixture({ orientation });
    if (orientation === "b_minus_a") data.views.difference_vectors.role = "difference";
    const engine = await open(artifacts(data));
    assert.deepEqual(engine.lenses, ["pair"]);
    assert.deepEqual(engine.concepts.answer, []);
    assert.deepEqual(engine.answerModels, []);
    assert.deepEqual(engine.filterAnswers([]), []);
    assert.equal(engine.summary().pairs, 3);
    assert.equal(engine.summary().answers, 0);
    assert.equal(engine.concepts.pair.length, 4);
    const positive = engine.concepts.pair.find(item => item.key === "pair:3:positive");
    const negative = engine.concepts.pair.find(item => item.key === "pair:3:negative");
    assert.deepEqual([positive.lens, positive.unit, positive.orientation, positive.activationPolarity], ["pair", "pairs", orientation, "signed"]);
    assert.equal(positive.greaterSide, orientation === "a_minus_b" ? "a" : "b");
    assert.equal(negative.greaterSide, orientation === "a_minus_b" ? "b" : "a");
    const rows = [0, 1, 2].map(row => engine.observation(row, "pair"));
    assert.ok(rows.every(item => item.side === null && item.modelId === null && item.lens === "pair" && item.unit === "pairs"));
    assert.ok(rows.every(item => item.view === "difference_vectors"));
    assert.equal(engine.observation(0, "a"), null);
    assert.equal(engine.observation(0, "b"), null);
    assert.deepEqual([...engine.observationStrengths(rows, positive.key).values()], [2, 0, 0]);
    assert.deepEqual([...engine.observationStrengths(rows, negative.key).values()], [0, 0, 4]);
    assert.deepEqual(engine.filterPairs([positive.key]).map(row => row.rowIndex), [0]);
    assert.deepEqual(engine.filterPairs([negative.key]).map(row => row.rowIndex), [2]);
    assert.deepEqual(engine.filterPairs([positive.key, "pair:7:negative"]).map(row => row.rowIndex), [0]);
    assert.deepEqual(engine.filterPairs([positive.key, negative.key]), []);
    assert.deepEqual(engine.filterPairs(["answer:3"]), []);
    assert.deepEqual(engine.filterPairs([positive.key], "a"), []);
    assert.equal(engine.conceptCounts("pair").get(negative.key), 1);
    assert.deepEqual(engine.filterActivationRange(rows, negative.key, { min: 3, max: 4, includeMax: true }).map(row => row.rowIndex), [2]);
    const distribution = engine.pairConceptDistribution(negative.key, rows[2].cursor);
    assert.equal(distribution.population.total, 3);
    assert.deepEqual(distribution.population.magnitudes, [4]);
    assert.deepEqual(distribution.current, { magnitude: 4, state: "active" });
    assert.equal(engine.pairConceptDistribution(negative.key, rows[0].cursor).current.state, "inactive");
    assert.equal(engine.pairConceptDistribution(negative.key, engine.observation(2, "prompt").cursor).current.state, "unavailable");
    assert.equal(engine.activationItems(2, "pair", negative.key)[0].value, 4);
    assert.equal(engine.datasetConcepts("pair").find(item => item.key === negative.key).mean, 4);
    assert.equal(engine.record(0).answerA, "Synthetic A one.");
    assert.equal(engine.record(0).answerB, "Synthetic B one.");
    assert.equal(engine.record(2).modelA.rawId, "synthetic/two");
    assert.equal(engine.record(2).modelB.rawId, "synthetic/one");
    assert.deepEqual([engine.record(1).preferenceA, engine.record(1).preferenceB], [null, null]);
    const relations = engine.relationships(positive.key, { minimumPrompts: 0 });
    assert.equal(relations.groups[0].title, "In the same pair");
    assert.ok(relations.groups[0].rows.some(item => item.key === "pair:7:negative"));
    assert.ok(relations.groups[1].rows.some(item => item.key === "prompt:12:negative"));
    assert.deepEqual(engine.filterByRelationships(positive.key, ["pair:7:negative"]).map(item => item.rowIndex), [0]);
  }
});

test("mixed lenses keep pair projections, individual activations and participant filters separate", async () => {
  const data = differenceFixture({ mixed: true });
  data.row_metadata.model_b[1] = "synthetic/third";
  const split = rows => ({ columns: Object.keys(rows[0]), index: rows.map((_, index) => index), data: rows.map(row => Object.values(row)) });
  const view = data.views.difference_vectors;
  data.tables.example_umap_meta = split([{ projection_id: "pair", method: "umap", basis: "full_feature_activations", preprocessing: "none",
    space: "main", feature_space_id: null, feature_ids: data.feature_ids, views: ["difference_vectors"],
    view_descriptors: [{ view: "difference_vectors", role: view.role, orientation: view.orientation, activation_polarity: view.activation_polarity, code_semantics: view.code_semantics }],
    row_order: "row_major_view_order", n_rows: 3, n_features: 2, n_points: 3, n_zero_rows: 0, parameters: {}, versions: {}, input_hash: "synthetic" }]);
  data.tables.example_umap_points = split(data.row_ids.map((row_id, index) => ({ projection_id: "pair", space: "main", row_id, view: "difference_vectors", x: index, y: index, zero_vector: false })));
  const engine = await open(artifacts(data));
  assert.deepEqual(engine.lenses, ["answer", "pair"]);
  assert.equal(engine.filterAnswers(["answer:3"]).length, 3);
  assert.deepEqual(engine.filterAnswers(["pair:3:positive"]), []);
  assert.equal(engine.filterPairs(["pair:3:positive"]).length, 1);
  assert.equal(engine.summary().answers, 6);
  assert.equal(engine.summary().pairs, 3);
  assert.equal(engine.map.points.pair.length, 3);
  assert.ok(engine.map.points.pair.every(point => point.lens === "pair" && point.side === null && point.view === "difference_vectors"));
  assert.notEqual(engine.map.points.pair[0].observationKey, engine.observation(0, "a").observationKey);
  assert.deepEqual(engine.filterPairs(["pair:7:positive"], "model:synthetic/third").map(row => row.rowIndex), [1]);
  assert.equal(engine.conceptCounts("pair", "model:synthetic/third").get("pair:3:positive"), 0);
  assert.equal(engine.pairConceptDistribution("pair:7:positive", null, "model:synthetic/third").population.total, 1);
  assert.equal(engine.pairConceptDistribution("pair:7:positive", null, "model:missing").population.available, false);
  assert.deepEqual(engine.filterPairs(["pair:7:positive"], "model:missing"), []);
  assert.equal(engine.answerConceptDistribution("answer:3").population.total, 6);
});

test("battle statistics use participant IDs and only supplied outcomes, optionally conditioned on pair activity", async () => {
  const data = differenceFixture();
  data.row_metadata.winner = ["b", "tie", "a"];
  const engine = await open(artifacts(data));
  const one = engine.battleStats({ modelId: "synthetic/one" })[0];
  assert.deepEqual(one, { rawId: "synthetic/one", name: "synthetic/one", battles: 3, scored: 3, wins: 0, losses: 2, ties: 1,
    hardN: 3, winTieScore: 1 / 6, winRate: 0, meanPreference: 0, probabilityCount: 2 });
  const negative = engine.battleStats({ modelId: "synthetic/one", opponent: "synthetic/two", conceptKey: "pair:3:negative" })[0];
  assert.equal(negative.battles, 1);
  assert.equal(negative.meanPreference, 0, "feature direction must not imply the preferred model");
  assert.equal(engine.battleStats({ modelId: "synthetic/one", opponent: "missing" })[0].battles, 0);
  assert.deepEqual(engine.battleStats({ modelId: "missing" }), []);
  delete data.row_metadata.winner;
  delete data.row_metadata.preference_probability;
  const unscored = await open(artifacts(data));
  assert.ok(unscored.battleStats().every(row => row.battles === 3 && row.scored === 0 && row.meanPreference === null && row.winRate === null));
  assert.ok(unscored.battleStats().every(row => row.hardN === 0 && row.winTieScore === null));
  assert.equal(unscored.filterPairs(["pair:7:positive"]).length, 1, "missing preferences must not remove active pairs");
});

test("model-relative pair analytics respect orientation and selected pole without using preference or individual activity", async () => {
  for (const mixed of [false, true]) for (const orientation of ["a_minus_b", "b_minus_a"]) {
    const data = differenceFixture({ mixed, orientation });
    delete data.row_metadata.preference_probability;
    const engine = await open(artifacts(data));
    for (const pole of ["positive", "negative"]) {
      const key = `pair:3:${pole}`, reverse = (orientation === "b_minus_a") !== (pole === "negative");
      const rows = engine.pairModelConcepts(key), one = rows.find(row => row.rawId === "synthetic/one"), two = rows.find(row => row.rawId === "synthetic/two");
      assert.deepEqual(one, { rawId: "synthetic/one", name: "synthetic/one", total: 3, greater: reverse ? 0 : 2,
        lower: reverse ? 2 : 0, equal: 1, nonzero: 2, greaterRate: reverse ? 0 : 1, meanSignedActivation: reverse ? -2 : 2 });
      assert.equal(two.greater, one.lower);
      assert.equal(two.lower, one.greater);
      assert.equal(two.meanSignedActivation, -one.meanSignedActivation);
      for (const model of rows) {
        const evidence = engine.pairModelEvidence(key, model.rawId);
        assert.equal(evidence.length, model.total);
        assert.ok(evidence.every(row => row.lens === "pair" && row.side === null && row.modelId === null && row.participantModelId === model.rawId));
        assert.equal(evidence.reduce((sum, row) => sum + row.relativeActivation, 0) / evidence.length, model.meanSignedActivation);
        for (const group of ["greater", "lower", "equal"]) {
          const selected = engine.pairModelEvidence(key, model.rawId, { group });
          assert.equal(selected.length, model[group]);
          assert.ok(selected.every(row => row.group === group && row.cursor.source.includes("difference_vectors")));
        }
      }
    }
    assert.deepEqual(engine.pairModelConcepts("answer:3"), []);
    assert.deepEqual(engine.pairModelEvidence("pair:3:positive", "missing"), []);
    assert.deepEqual(engine.pairModelEvidence("pair:3:positive", "synthetic/one", { group: "invalid" }), []);
  }
});

test("pair analytics retain zero measurements, exact opponent cohorts and independent cached results", async () => {
  const data = differenceFixture();
  data.row_metadata.model_b[1] = "synthetic/third";
  const engine = await open(artifacts(data)), key = "pair:3:positive";
  const all = engine.pairModelConcepts(key);
  const rows = engine.pairModelConcepts(key, { opponent: "synthetic/third" });
  const one = rows.find(row => row.rawId === "synthetic/one");
  assert.deepEqual([one.total, one.equal, one.nonzero, one.greaterRate, one.meanSignedActivation], [1, 1, 0, null, 0]);
  assert.deepEqual(engine.pairModelEvidence(key, "synthetic/one", { opponent: "synthetic/third", group: "equal" }).map(row => row.rowIndex), [1]);
  const twoOpponent = engine.pairModelConcepts(key, { opponent: "synthetic/two" }).find(row => row.rawId === "synthetic/one");
  assert.deepEqual([twoOpponent.total, twoOpponent.greater, twoOpponent.meanSignedActivation], [2, 2, 3]);
  assert.equal(engine.pairModelEvidence(key, "synthetic/one", { opponent: "synthetic/two" }).length, 2);
  assert.ok(engine.pairModelConcepts(key, { opponent: "missing" }).every(row => row.total === 0 && row.greaterRate === null && row.meanSignedActivation === null));
  const source = engine.concepts.pair.find(row => row.key === key).choice.source;
  let reads = 0;
  for (const row of source.view.values) { const value = row[0]; Object.defineProperty(row, 0, { get() { reads++; return value; } }); }
  const edited = engine.pairModelConcepts(key); edited[0].greater = -1; edited.pop();
  assert.deepEqual(engine.pairModelConcepts(key), all);
  assert.equal(reads, 0, "revisiting a cached concept must not rescan battles");
  const changed = engine.pairModelConcepts(key, { opponent: "synthetic/third" });
  reads = 0; changed[0].total = 99;
  assert.deepEqual(engine.pairModelConcepts(key, { opponent: "synthetic/third" }), rows);
  assert.equal(reads, 0, "repeating the last opponent cohort must reuse its result");
});

test("pair comparison analytics exclude self-pairs and missing participants; win-tie scores require explicit labels", async () => {
  const data = differenceFixture();
  data.row_metadata.model_b[0] = data.row_metadata.model_a[0];
  data.row_metadata.model_b[1] = "  ";
  data.row_metadata.winner = ["a", "tie", "b"];
  const engine = await open(artifacts(data));
  const one = engine.pairModelConcepts("pair:3:positive").find(row => row.rawId === "synthetic/one");
  assert.deepEqual([one.total, one.greater, one.meanSignedActivation], [1, 1, 4]);
  assert.deepEqual(engine.pairModelEvidence("pair:3:positive", one.rawId).map(row => row.rowIndex), [2]);
  const score = engine.battleStats({ modelId: one.rawId })[0];
  assert.deepEqual([score.battles, score.hardN, score.winTieScore, score.meanPreference], [1, 1, 1, 0]);
  delete data.row_metadata.winner;
  const probabilityOnly = await open(artifacts(data));
  const unlabelled = probabilityOnly.battleStats({ modelId: one.rawId })[0];
  assert.deepEqual([unlabelled.hardN, unlabelled.winTieScore, unlabelled.meanPreference], [0, null, 0]);
});

test("pair evidence exposes only supplied participant-relative results and probabilities", async () => {
  const data = differenceFixture();
  data.row_metadata.winner = ["a", "tie", "a"];
  const engine = await open(artifacts(data));
  const outcomes = engine.pairModelEvidence("pair:3:positive", "synthetic/one").map(({ winner, preference }) => ({ winner, preference }));
  assert.deepEqual(outcomes, [{ winner: "win", preference: 0 }, { winner: "tie", preference: null }, { winner: "loss", preference: 0 }]);
  delete data.row_metadata.winner;
  const unlabelled = await open(artifacts(data));
  assert.deepEqual(unlabelled.pairModelEvidence("pair:3:positive", "synthetic/one").map(row => row.winner), [null, null, null]);
  delete data.row_metadata.preference_probability;
  const unscored = await open(artifacts(data));
  assert.ok(unscored.pairModelEvidence("pair:3:positive", "synthetic/one").every(row => row.winner === null && row.preference === null));
});

test("difference model registry and battle scopes follow twenty rotating participants", async () => {
  const data = differenceFixture(), count = 20;
  data.row_ids = Array.from({ length: count }, (_, row) => `synthetic-battle-${row}`);
  data.prompt.row_ids = [...data.row_ids];
  for (const view of Object.values(data.prompt.views)) view.values = data.row_ids.map((_, row) => view.values[row % 3]);
  for (const [key, values] of Object.entries(data.row_metadata)) data.row_metadata[key] = data.row_ids.map((_, row) => values[row % 3]);
  data.row_metadata.model_a = data.row_ids.map((_, row) => `model-${row}`);
  data.row_metadata.model_b = data.row_ids.map((_, row) => `model-${(row + 1) % count}`);
  data.row_metadata.preference_probability = data.row_ids.map((_, row) => row % 2 ? null : 0.75);
  data.views.difference_vectors.values = data.row_ids.map((_, row) => [row % 2 ? -1 : 1, 0]);
  const engine = await open(artifacts(data));
  assert.equal(engine.modelRegistry.length, count);
  assert.deepEqual(engine.answerModels, []);
  assert.ok(engine.battleStats().every(model => model.battles === 2 && model.scored === 1));
  assert.equal(engine.battleStats({ modelId: "model-0" })[0].meanPreference, 0.75);
  assert.equal(engine.battleStats({ modelId: "model-1" })[0].meanPreference, 0.25);
  for (const model of engine.modelRegistry) {
    const scope = `model:${model.rawId}`;
    assert.equal(engine.filterPairs(["pair:3:positive"], scope).length, 1);
    assert.equal(engine.filterPairs(["pair:3:negative"], scope).length, 1);
    assert.equal(engine.pairConceptDistribution("pair:3:positive", null, scope).population.total, 2);
  }
});

test("two-model distributions compare every owned sample or only direct battles across all three lenses", async () => {
  const data = differenceFixture({ mixed: true });
  data.row_metadata.model_a = ["synthetic/one", "synthetic/one", "synthetic/three"];
  data.row_metadata.model_b = ["synthetic/two", "synthetic/three", "synthetic/two"];
  const engine = await open(artifacts(data));
  const compare = (source, scope, key) => engine.modelConceptComparison("synthetic/one", "synthetic/two", { source, scope }).rows.find(row => row.key === key);
  const metrics = row => [row.first.active, row.first.total, row.first.share, row.first.mean,
    row.second.active, row.second.total, row.second.share, row.second.mean, row.gap];
  assert.deepEqual(metrics(compare("answer", "all", "answer:3")), [1, 2, .5, .5, 0, 2, 0, 0, .5]);
  assert.deepEqual(metrics(compare("answer", "headToHead", "answer:3")), [1, 1, 1, 1, 0, 1, 0, 0, 1]);
  assert.deepEqual(metrics(compare("prompt", "all", "prompt:12:positive")), [1, 2, .5, 1, 0, 2, 0, 0, .5]);
  assert.deepEqual(metrics(compare("prompt", "headToHead", "prompt:12:positive")), [0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const pair = compare("pair", "all", "pair:3:positive");
  assert.deepEqual(metrics(pair), [1, 2, 1, 1, 1, 2, .5, 1, .5]);
  assert.equal(pair.first.nonzero, 1, "equality remains in total and mean, not directional share");
  assert.equal(pair.first.equal, 1);
  assert.deepEqual(metrics(compare("pair", "headToHead", "pair:3:positive")), [1, 1, 1, 2, 0, 1, 0, -2, 1]);
  const reversed = engine.modelConceptComparison("synthetic/two", "synthetic/one", { source: "pair" }).rows.find(row => row.key === pair.key);
  assert.deepEqual(reversed.first, pair.second);
  assert.deepEqual(reversed.second, pair.first);
  assert.equal(reversed.gap, -pair.gap);
});

test("generic comparison preserves multiple owned answers while prompt cohorts deduplicate stable identities", async () => {
  const data = genericFixture();
  data.row_metadata.prompt_id = [9, 9, 9];
  data.schema_version = 2;
  data.prompt = pairedFixture().prompt;
  const engine = await open(artifacts(data));
  const answers = engine.modelConceptComparison("synthetic/one", "synthetic/two").rows.find(row => row.key === "answer:3");
  assert.deepEqual([answers.first.active, answers.first.total, answers.first.mean], [2, 2, 2]);
  const prompts = engine.modelConceptComparison("synthetic/one", "synthetic/two", { source: "prompt" }).rows;
  const negative = prompts.find(row => row.key === "prompt:12:negative");
  assert.deepEqual([negative.first.active, negative.first.total, negative.first.mean, negative.first.unit], [1, 1, 3, "prompts"]);
  assert.deepEqual([negative.second.active, negative.second.total], [0, 1]);
  const direct = engine.modelConceptComparison("synthetic/one", "synthetic/two", { scope: "headToHead" });
  assert.ok(direct.rows.every(row => row.first.total === 0 && row.second.total === 0 && row.gap === null));
  assert.deepEqual(engine.modelBattleEvidence("synthetic/one"), []);
  assert.deepEqual(engine.modelConceptComparison("synthetic/one", "synthetic/two", { source: "pair" }).rows, []);
  data.row_metadata.prompt_id[2] = null;
  const missing = await open(artifacts(data));
  const fallback = missing.modelConceptComparison("synthetic/one", "synthetic/two", { source: "prompt" }).rows.find(row => row.key === negative.key);
  assert.deepEqual([fallback.first.total, fallback.first.unit, fallback.first.mean], [2, "rows", 2]);
  data.prompt.row_metadata.prompt_id = [90, 90, 90];
  const nested = await open(artifacts(data));
  assert.equal(nested.modelConceptComparison("synthetic/one", "synthetic/two", { source: "prompt" }).rows[0].first.total, 2,
    "top-level id 9 and nested id 90 are distinct; nested id precedes text");
});

test("difference comparisons honor source orientation and pole with missing outcomes and no individual source", async () => {
  for (const orientation of ["a_minus_b", "b_minus_a"]) {
    const data = differenceFixture({ orientation });
    delete data.row_metadata.preference_probability;
    const engine = await open(artifacts(data));
    const result = engine.modelConceptComparison("synthetic/one", "synthetic/two", { source: "pair" });
    for (const row of result.rows) {
      const expected = engine.pairModelConcepts(row.key).find(model => model.rawId === "synthetic/one");
      assert.deepEqual([row.first.total, row.first.nonzero, row.first.share, row.first.mean],
        [expected.total, expected.nonzero, expected.greaterRate, expected.meanSignedActivation]);
    }
    const positive = result.rows.find(row => row.key === "pair:3:positive");
    const negative = result.rows.find(row => row.key === "pair:3:negative");
    assert.equal(positive.first.mean, orientation === "a_minus_b" ? 2 : -2);
    assert.equal(positive.first.mean, -negative.first.mean);
    assert.deepEqual(engine.modelConceptComparison("synthetic/one", "synthetic/two", { source: "answer" }).rows, []);
    assert.ok(engine.modelBattleEvidence("synthetic/one").every(row => row.lens === "pair" && row.side === null && row.winner === null && row.preference === null));
  }
});

test("raw battle evidence remains concept-independent, source-correct, and excludes self-pairs", async () => {
  for (const difference of [false, true]) {
    const data = difference ? differenceFixture() : pairedFixture();
    data.row_metadata.model_b[1] = "synthetic/three";
    data.row_metadata.winner = ["a", "tie", "a"];
    const engine = await open(artifacts(data));
    const evidence = engine.modelBattleEvidence("synthetic/one");
    assert.deepEqual(evidence.map(({ rowIndex, winner, preference, opponentModelId }) => [rowIndex, winner, preference, opponentModelId]),
      [[0, "win", 0, "synthetic/two"], [1, "tie", null, "synthetic/three"], [2, "loss", 0, "synthetic/two"]]);
    assert.deepEqual(evidence.map(row => row.side), difference ? [null, null, null] : ["a", "a", "b"]);
    assert.ok(evidence.every(row => row.cursor.row_id === row.rowId && row.cursor.source === row.sourceKey));
    assert.deepEqual(engine.modelBattleEvidence("synthetic/one", { opponent: "synthetic/two" }).map(row => row.rowIndex), [0, 2]);
    assert.equal(engine.record(evidence[2].rowIndex).answerB, "Synthetic B three.");
    data.row_metadata.model_b[0] = "synthetic/one";
    data.row_metadata.model_b[1] = " ";
    const invalid = await open(artifacts(data));
    assert.deepEqual(invalid.modelBattleEvidence("synthetic/one").map(row => row.rowIndex), [2]);
    const direct = invalid.modelConceptComparison("synthetic/one", "synthetic/two", { source: difference ? "pair" : "answer", scope: "headToHead" });
    assert.ok(direct.rows.every(row => row.first.total === 1 && row.second.total === 1));
    assert.deepEqual(invalid.modelBattleEvidence("missing"), []);
  }
});

test("comparison retains only its last cohort and returns independent metrics without rescanning", async () => {
  const engine = await open(artifacts(pairedFixture()));
  const first = "synthetic/one", second = "synthetic/two";
  const expected = engine.modelConceptComparison(first, second);
  let reads = 0;
  const source = engine.concepts.answer[0].choice.source;
  for (const row of source.view.values) { const value = row[0]; Object.defineProperty(row, 0, { get() { reads++; return value; } }); }
  const edited = engine.modelConceptComparison(first, second);
  edited.first.name = "edited"; edited.rows[0].first.active = -100; edited.rows.pop();
  assert.deepEqual(engine.modelConceptComparison(first, second), expected);
  assert.equal(reads, 0);
  engine.modelConceptComparison(first, second, { scope: "headToHead" });
  assert.ok(reads > 0);
  reads = 0;
  assert.deepEqual(engine.modelConceptComparison(first, second), expected);
  assert.ok(reads > 0, "changing cohorts replaces the previous cache rather than retaining every model pair");
  for (const [a, b, options] of [[first, first, {}], ["missing", second, {}], [first, second, { scope: "bad" }], [first, second, { source: "bad" }]])
    assert.deepEqual(engine.modelConceptComparison(a, b, options).rows, []);
});

test("unified generic activity profiles compare actual peer observations without fabricating battle scores", async () => {
  const engine = await open(artifacts(genericFixture()));
  const row = engine.modelConceptProfile("synthetic/one", { source: "answer", conceptKey: "answer:3" })[0];
  assert.deepEqual([row.active, row.total, row.share, row.baselineActive, row.baselineTotal, row.baselineShare, row.shareGap], [2, 2, 1, 0, 1, 0, 1]);
  assert.deepEqual([row.scoreKind, row.score, row.baselineScore, row.scoreGap, row.moreN, row.lessN, row.associationGap, row.meanGap], [null, null, null, null, 0, 0, null, null]);
  const evidence = engine.modelProfileEvidence(row.key, "synthetic/one");
  assert.deepEqual(evidence.map(item => item.rowIndex), [0, 2]);
  assert.ok(evidence.every(item => item.modelId === "synthetic/one" && item.group === "unpaired" && item.score === null && item.relativeActivation === null));
  assert.deepEqual(engine.modelProfileEvidence(row.key, "synthetic/one", { group: "more" }), []);
  assert.deepEqual(engine.modelConceptProfile("synthetic/one", { source: "pair" }), []);
  assert.equal(engine.modelConceptProfile("synthetic/one", { opponent: "synthetic/two" })[0].total, 0);
});

test("prompt-conditioned scores use explicit overall battle baselines while prevalence counts distinct prompts", async () => {
  const data = pairedFixture();
  data.row_metadata.winner = ["a", "b", "b"];
  data.row_metadata.prompt_id = [8, 9, 8];
  const engine = await open(artifacts(data));
  const rows = engine.modelConceptProfile("synthetic/one", { source: "prompt" });
  const positive = rows.find(row => row.key === "prompt:12:positive"), negative = rows.find(row => row.key === "prompt:12:negative");
  assert.deepEqual([positive.active, positive.total, positive.share, positive.scoreKind, positive.score, positive.scored, positive.baselineScore, positive.baselineScored], [1, 2, .5, "hard", 0, 1, 2 / 3, 3]);
  assert.equal(positive.scoreGap, -2 / 3);
  assert.deepEqual([negative.active, negative.total, negative.score, negative.scored], [1, 2, 1, 2]);
  assert.equal(negative.scoreGap, 1 - 2 / 3);
  assert.equal(negative.baselineKind, "overall");
  const evidence = engine.modelProfileEvidence(negative.key, "synthetic/one");
  assert.deepEqual(evidence.map(item => item.rowIndex), [0, 2], "distinct prompt prevalence does not discard separately recorded battle outcomes");
  assert.ok(evidence.every(item => item.lens === "prompt" && item.side === null && item.score === 1 && item.cursor.source === item.sourceKey));
  assert.deepEqual(engine.modelProfileEvidence(positive.key, "synthetic/one", { group: "less" }), []);
});

test("individual more-less associations use compatible matched answers, ties and one honest outcome kind", async () => {
  const data = pairedFixture();
  data.row_metadata.winner = ["a", "tie", "a"];
  const engine = await open(artifacts(data));
  const row = engine.modelConceptProfile("synthetic/one", { conceptKey: "answer:3" })[0];
  assert.deepEqual([row.moreTotal, row.lessTotal, row.equalTotal, row.moreN, row.lessN, row.moreScore, row.lessScore, row.associationGap, row.meanGap], [1, 2, 0, 1, 2, 1, .25, .75, -4 / 3]);
  assert.deepEqual([row.share, row.baselineShare, row.shareGap, row.score, row.baselineScore, row.scoreGap], [1 / 3, 2 / 3, -1 / 3, 1, .5, .5]);
  const less = engine.modelProfileEvidence(row.key, "synthetic/one", { group: "less" });
  assert.deepEqual(less.map(item => [item.rowIndex, item.side, item.relativeActivation, item.score]), [[1, "a", -2, .5], [2, "b", -3, 0]]);
  assert.ok(less.every(item => item.modelId === "synthetic/one" && item.lens === "answer"));
  data.row_metadata.winner = ["a", null, null];
  data.row_metadata.preference_probability = [0, .8, 1];
  const partial = await open(artifacts(data));
  const hard = partial.modelConceptProfile("synthetic/one", { conceptKey: row.key })[0];
  assert.deepEqual([hard.scoreKind, hard.moreScore, hard.lessScore, hard.lessN, hard.lessTotal, hard.associationGap], ["hard", 1, null, 0, 2, null]);
  assert.ok(partial.modelProfileEvidence(row.key, "synthetic/one", { group: "less" }).every(item => item.score === null && item.preference !== null));
  delete data.row_metadata.winner;
  const soft = await open(artifacts(data));
  const probabilities = soft.modelConceptProfile("synthetic/one", { conceptKey: row.key })[0];
  assert.deepEqual([probabilities.scoreKind, probabilities.moreScore, probabilities.lessScore, probabilities.associationGap], ["soft", 0, .4, -.4]);
  data.row_metadata.model_b[1] = "synthetic/three";
  const scoped = await open(artifacts(data));
  const direct = scoped.modelConceptProfile("synthetic/one", { opponent: "synthetic/two", conceptKey: row.key })[0];
  assert.deepEqual([direct.total, direct.baselineTotal, direct.lessTotal, direct.lessScore], [2, 2, 1, 0]);
});

test("pair profiles remain directional across orientations, exclude equality from evidence, and never invent absolute activity", async () => {
  for (const orientation of ["a_minus_b", "b_minus_a"]) {
    const data = differenceFixture({ orientation });
    data.views.difference_vectors.values = [[2, 0], [3, 0], [4, 0]];
    data.row_metadata.winner = ["a", "tie", "a"];
    const engine = await open(artifacts(data));
    assert.deepEqual(engine.modelConceptProfile("synthetic/one", { source: "answer" }), []);
    const row = engine.modelConceptProfile("synthetic/one", { source: "pair", conceptKey: "pair:3:positive" })[0];
    const forward = orientation === "a_minus_b";
    assert.deepEqual([row.total, row.nonzero, row.moreTotal, row.lessTotal, row.moreScore, row.lessScore, row.associationGap],
      [3, 3, forward ? 2 : 1, forward ? 1 : 2, forward ? .75 : 0, forward ? 0 : .75, forward ? .75 : -.75]);
    const evidence = engine.modelProfileEvidence(row.key, "synthetic/one", { group: "more" });
    assert.equal(evidence.length, row.moreTotal);
    assert.ok(evidence.every(item => item.lens === "pair" && item.side === null && item.modelId === null && item.relativeActivation > 0));
    const opposite = engine.modelConceptProfile("synthetic/one", { source: "pair", conceptKey: "pair:3:negative" })[0];
    assert.equal(opposite.associationGap, -row.associationGap);
    assert.equal(opposite.meanGap, -row.meanGap);
    const equal = engine.modelConceptProfile("synthetic/one", { source: "pair", conceptKey: "pair:7:positive" })[0];
    assert.deepEqual([equal.total, equal.equalTotal, equal.nonzero, equal.share, equal.associationGap], [3, 3, 0, null, null]);
    assert.deepEqual(engine.modelProfileEvidence(equal.key, "synthetic/one"), []);
    data.row_metadata.model_b[0] = "synthetic/one";
    data.row_metadata.model_b[1] = " ";
    const invalid = await open(artifacts(data));
    assert.equal(invalid.modelConceptProfile("synthetic/one", { source: "pair", conceptKey: row.key })[0].total, 1);
    assert.deepEqual(invalid.modelProfileEvidence(row.key, "synthetic/one").map(item => item.rowIndex), [2]);
  }
});

test("single-concept profiles read only the requested feature and cache independent result rows", async () => {
  const engine = await open(artifacts(pairedFixture()));
  let selectedReads = 0;
  for (const source of engine.concepts.answer[0].choice.sources) for (const row of source.view.values) {
    const value = row[0];
    Object.defineProperty(row, 0, { get() { selectedReads++; return value; } });
    Object.defineProperty(row, 1, { get() { throw new Error("Unrequested feature was read"); } });
  }
  const options = { source: "answer", conceptKey: "answer:3" };
  const expected = engine.modelConceptProfile("synthetic/one", options);
  assert.equal(expected.length, 1);
  assert.ok(selectedReads > 0);
  selectedReads = 0;
  const edited = engine.modelConceptProfile("synthetic/one", options); edited[0].share = -1; edited.pop();
  assert.deepEqual(engine.modelConceptProfile("synthetic/one", options), expected);
  assert.equal(selectedReads, 0);
  for (const options of [{ source: "missing" }, { opponent: "missing" }, { opponent: "synthetic/one" }, { source: "pair", conceptKey: "answer:3" }])
    assert.deepEqual(engine.modelConceptProfile("synthetic/one", options), []);
  assert.deepEqual(engine.modelProfileEvidence("answer:3", "synthetic/one", { group: "invalid" }), []);
});

test("forced profile score kinds stay consistent across models, baselines and evidence without fallback", async () => {
  const data = pairedFixture();
  data.row_metadata.winner = ["a", "tie", "a"];
  const engine = await open(artifacts(data));
  const options = { conceptKey: "answer:3" };
  const hard = engine.modelConceptProfile("synthetic/one", { ...options, scoreKind: "hard" })[0];
  const soft = engine.modelConceptProfile("synthetic/one", { ...options, scoreKind: "soft" })[0];
  assert.deepEqual([hard.scoreKind, hard.score, hard.baselineScore, hard.moreScore, hard.lessScore, hard.lessN], ["hard", 1, .5, 1, .25, 2]);
  assert.deepEqual([soft.scoreKind, soft.score, soft.baselineScore, soft.moreScore, soft.lessScore, soft.lessN], ["soft", 0, 0, 0, 0, 1]);
  assert.deepEqual(engine.modelConceptProfile("synthetic/one", { ...options, scoreKind: "hard" })[0], hard, "score kind must be part of the cache key");
  assert.deepEqual(engine.modelConceptProfile("synthetic/one", options)[0], hard);
  assert.deepEqual(engine.modelConceptProfile("synthetic/one", { ...options, scoreKind: "invalid" })[0], hard, "invalid overrides retain automatic selection");
  const evidence = engine.modelProfileEvidence("answer:3", "synthetic/one", { group: "less", scoreKind: "soft" });
  assert.deepEqual(evidence.map(row => [row.scoreKind, row.score]), [["soft", null], ["soft", 0]]);
  delete data.row_metadata.winner;
  const softOnly = await open(artifacts(data));
  const forcedHard = softOnly.modelConceptProfile("synthetic/one", { ...options, scoreKind: "hard" })[0];
  assert.deepEqual([forcedHard.scoreKind, forcedHard.score, forcedHard.scored, forcedHard.baselineScore, forcedHard.baselineScored, forcedHard.associationGap], ["hard", null, 0, null, 0, null]);
  assert.ok(softOnly.modelProfileEvidence("answer:3", "synthetic/one", { scoreKind: "hard" }).every(row => row.scoreKind === "hard" && row.score === null));
  data.row_metadata.winner = ["a", "tie", "a"];
  delete data.row_metadata.preference_probability;
  const hardOnly = await open(artifacts(data));
  const forcedSoft = hardOnly.modelConceptProfile("synthetic/one", { ...options, scoreKind: "soft" })[0];
  assert.deepEqual([forcedSoft.scoreKind, forcedSoft.score, forcedSoft.scored, forcedSoft.baselineScore, forcedSoft.baselineScored, forcedSoft.associationGap], ["soft", null, 0, null, 0, null]);
  assert.ok(hardOnly.modelProfileEvidence("answer:3", "synthetic/one", { scoreKind: "soft" }).every(row => row.scoreKind === "soft" && row.score === null));
});
