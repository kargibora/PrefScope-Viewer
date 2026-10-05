import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { packageViewer } from "../scripts/package-viewer.mjs";
import { createEngine } from "../src/modern/shared/engine.js";
import { artifacts, pairedFixture, jsonBytes, sha256 } from "./modern-fixture.mjs";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "prefscope-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "original"), dist = join(root, "dist"), out = join(root, "output");
  await mkdir(join(bundle, "data"), { recursive: true });
  await mkdir(join(dist, "assets"), { recursive: true });
  const fixture = artifacts(pairedFixture());
  // Input can originate from an earlier compatible Viewer version; the new build owns its version.
  fixture.bundle.viewer.version = fixture.build.version = "0.0.9";
  fixture.files.set("viewer-build.json", jsonBytes(fixture.build));
  const dataBytes = Buffer.from(`${JSON.stringify(fixture.data, null, 3)}\n\n`);
  fixture.files.set("data/viewer-data.json", dataBytes);
  fixture.bundle.files = [...fixture.files].map(([path, bytes]) => ({ path, size_bytes: bytes.length, sha256: sha256(bytes) }));
  for (const [path, bytes] of fixture.files) await writeFile(join(bundle, path), bytes);
  await writeFile(join(bundle, "viewer-bundle.json"), jsonBytes(fixture.bundle));
  const build = { ...fixture.build, version: "0.1.0" };
  await writeFile(join(dist, "viewer-build.json"), jsonBytes(build));
  await writeFile(join(dist, "index.html"), '<!doctype html><script src="./assets/new.js"></script>');
  await writeFile(join(dist, "assets/new.js"), '// Synthetic Viewer build asset.\n');
  return { root, bundle, dist, out, dataBytes, build };
}
async function open(folder) {
  return createEngine({ dataUrl: "data/viewer-data.json", bundleUrl: "viewer-bundle.json", buildUrl: "viewer-build.json", expectedViewerVersion: "0.1.0",
    fetcher: async path => { const bytes = await readFile(join(folder, path)); return { ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer }; } });
}
async function absent(path) { await assert.rejects(readFile(path), error => error.code === "ENOENT"); }
async function noStaging(root) { assert.ok((await readdir(root)).every(name => !name.includes(".staging-"))); }

async function shardedSetup(t) {
  const fixture = await setup(t), data = JSON.parse(fixture.dataBytes);
  const shardPath = "data/answer-text/0000.json", texts = [...data.row_metadata.response_a];
  data.row_metadata.response_a.fill(null);
  data.answer_text_shards = { schema: "prefscope.viewer_answer_text_shards", schema_version: 1,
    files: [{ start: 0, end: data.row_ids.length, path: shardPath }] };
  const dataBytes = Buffer.from(jsonBytes(data)), shardBytes = Buffer.from(`${JSON.stringify({ start: 0, row_ids: data.row_ids, texts }, null, 3)}\n\n`);
  const manifest = JSON.parse(await readFile(join(fixture.bundle, "viewer-bundle.json")));
  Object.assign(manifest.files.find(file => file.path === "data/viewer-data.json"), { size_bytes: dataBytes.length, sha256: sha256(dataBytes) });
  manifest.files.push({ path: shardPath, size_bytes: shardBytes.length, sha256: sha256(shardBytes) });
  await mkdir(join(fixture.bundle, "data/answer-text"));
  await writeFile(join(fixture.bundle, shardPath), shardBytes);
  await writeFile(join(fixture.bundle, "data/viewer-data.json"), dataBytes);
  await writeFile(join(fixture.bundle, "viewer-bundle.json"), jsonBytes(manifest));
  return { ...fixture, dataBytes, shardPath, shardBytes, texts, manifest };
}

test("packaging preserves lazy shard bytes, descriptors, hashes and exact owned answers", async t => {
  const fixture = await shardedSetup(t);
  await packageViewer(fixture);
  assert.deepEqual(await readFile(join(fixture.out, "data/viewer-data.json")), fixture.dataBytes);
  assert.deepEqual(await readFile(join(fixture.out, fixture.shardPath)), fixture.shardBytes);
  const engine = await open(fixture.out);
  assert.equal(engine.record(0).answerA, undefined);
  assert.deepEqual(engine.dataset.bundle.files.find(file => file.path === fixture.shardPath),
    fixture.manifest.files.find(file => file.path === fixture.shardPath));
  await engine.ensureAllAnswerTexts();
  assert.deepEqual(fixture.texts.map((_, row) => engine.record(row).answerA), fixture.texts);
  await noStaging(fixture.root);
});

test("missing, corrupt, misowned and unsafe shards fail before publishing", async t => {
  for (const failure of ["missing", "corrupt", "wrong-row", "traversal"]) {
    const fixture = await shardedSetup(t), path = join(fixture.bundle, fixture.shardPath);
    if (failure === "missing") await rm(path);
    if (failure === "corrupt") await writeFile(path, Buffer.concat([fixture.shardBytes, Buffer.from(" ")]));
    if (failure === "wrong-row") {
      const shard = JSON.parse(fixture.shardBytes); shard.row_ids[0] = "another-record";
      const bytes = jsonBytes(shard);
      await writeFile(path, bytes);
      Object.assign(fixture.manifest.files.find(file => file.path === fixture.shardPath), { size_bytes: bytes.length, sha256: sha256(bytes) });
    }
    if (failure === "traversal") fixture.manifest.files.find(file => file.path === fixture.shardPath).path = "data/answer-text/../../escape.json";
    await writeFile(join(fixture.bundle, "viewer-bundle.json"), jsonBytes(fixture.manifest));
    await assert.rejects(packageViewer(fixture));
    await absent(fixture.out); await noStaging(fixture.root);
  }
});

test("local preview serves only declared shards inside the export", async t => {
  const fixture = await shardedSetup(t), secret = join(fixture.root, "secret.json");
  await writeFile(secret, "private external bytes");
  await symlink(secret, join(fixture.bundle, "data/answer-text/escape.json"));
  fixture.manifest.files.push({ path: "data/answer-text/escape.json" }, { path: "data/answer-text/../../../secret.json" });
  await writeFile(join(fixture.bundle, "viewer-bundle.json"), jsonBytes(fixture.manifest));
  const { createServer } = await import("vite"), saved = process.env.PREFSCOPE_VIEWER_BUNDLE;
  let server;
  try {
    process.env.PREFSCOPE_VIEWER_BUNDLE = fixture.bundle;
    server = await createServer({ configFile: new URL("../vite.config.ts", import.meta.url).pathname,
      root: fixture.dist, logLevel: "silent", server: { host: "127.0.0.1", port: 0, open: false, watch: null } });
  } finally {
    if (saved === undefined) delete process.env.PREFSCOPE_VIEWER_BUNDLE;
    else process.env.PREFSCOPE_VIEWER_BUNDLE = saved;
  }
  t.after(() => server.close());
  await server.listen();
  const port = server.httpServer.address().port;
  const get = path => new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, bytes: Buffer.concat(chunks) }));
    }).on("error", reject).end();
  });
  const loaded = await get(`/${fixture.shardPath}?preview=1`);
  assert.equal(loaded.status, 200); assert.deepEqual(loaded.bytes, fixture.shardBytes);
  for (const path of ["missing.json", "escape.json", "../../../secret.json", "%2e%2e/%2e%2e/%2e%2e/secret.json"])
    assert.equal((await get(`/data/answer-text/${path}`)).status, 404, path);
});

test("CLI packages a new build with exact original data and canonical viewer inventory", async t => {
  const fixture = await setup(t);
  const before = await readFile(join(fixture.bundle, "viewer-bundle.json"));
  const result = spawnSync(process.execPath, ["scripts/package-viewer.mjs", "--bundle", fixture.bundle, "--out", fixture.out, "--dist", fixture.dist], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readFile(join(fixture.out, "data/viewer-data.json")), fixture.dataBytes);
  assert.deepEqual(await readFile(join(fixture.bundle, "viewer-bundle.json")), before);
  const engine = await open(fixture.out), manifest = engine.dataset.bundle;
  assert.equal(manifest.viewer.version, "0.1.0");
  assert.deepEqual(manifest.producer, JSON.parse(before).producer);
  assert.deepEqual(manifest.data, JSON.parse(before).data);
  assert.deepEqual(manifest.files.map(file => file.path), ["assets/new.js", "data/viewer-data.json", "index.html", "viewer-build.json"]);
  const canonical = [];
  for (const file of manifest.files) {
    const bytes = await readFile(join(fixture.out, file.path));
    assert.equal(file.sha256, sha256(bytes)); assert.equal(file.size_bytes, bytes.length);
    if (!file.path.startsWith("data/")) canonical.push({ path: file.path, sha256: file.sha256, size_bytes: file.size_bytes });
  }
  assert.equal(manifest.viewer.build_sha256, sha256(Buffer.from(JSON.stringify(canonical))));
  assert.deepEqual(await readFile(join(fixture.out, "assets/new.js")), await readFile(join(fixture.dist, "assets/new.js")));
  await absent(join(fixture.dist, "data/viewer-data.json"));
  await noStaging(fixture.root);
});

test("existing output and input/build descendants are never overwritten", async t => {
  const fixture = await setup(t);
  await mkdir(fixture.out); await writeFile(join(fixture.out, "keep.txt"), "keep");
  await assert.rejects(packageViewer(fixture), /already exists/);
  assert.equal(await readFile(join(fixture.out, "keep.txt"), "utf8"), "keep");
  for (const folder of [fixture.bundle, fixture.dist]) {
    await assert.rejects(packageViewer({ ...fixture, out: join(folder, "new", "nested") }), /outside/);
    assert.ok(!(await readdir(folder)).includes("new"));
  }
  await noStaging(fixture.root);
});

test("stale dataset and reserved manifest files are rejected in Viewer builds", async t => {
  for (const path of ["data", "viewer-bundle.json", "viewer-data.json", "bundle_manifest.json"]) {
    const fixture = await setup(t);
    if (path === "data") await mkdir(join(fixture.dist, path));
    else await writeFile(join(fixture.dist, path), "stale");
    await assert.rejects(packageViewer(fixture), /reserved path/);
    await absent(fixture.out); await noStaging(fixture.root);
  }
});

test("input and build symlinks plus dangling output links are rejected", async t => {
  for (const kind of ["input-root", "build-root", "input-entry", "build-entry", "output"]) {
    const fixture = await setup(t);
    if (kind.endsWith("root")) {
      const path = join(fixture.root, "alias"), key = kind === "input-root" ? "bundle" : "dist";
      await symlink(fixture[key], path); fixture[key] = path;
    } else if (kind === "output") await symlink(join(fixture.root, "nonexistent"), fixture.out);
    else await symlink(join(fixture.root, "nonexistent"), join(kind === "input-entry" ? fixture.bundle : fixture.dist, "symlink"));
    await assert.rejects(packageViewer(fixture), /symlink|already exists/);
    await noStaging(fixture.root);
  }
});

test("invalid source bytes and incompatible new builds leave no output or staging", async t => {
  for (const failure of ["input-checksum", "unsupported-schema", "wrong-package", "missing-index", "missing-build"]) {
    const fixture = await setup(t), before = await readFile(join(fixture.bundle, "viewer-bundle.json"));
    if (failure === "input-checksum") await writeFile(join(fixture.bundle, "data/viewer-data.json"), Buffer.concat([fixture.dataBytes, Buffer.from(" ")]));
    if (failure === "unsupported-schema") await writeFile(join(fixture.dist, "viewer-build.json"), jsonBytes({ ...fixture.build, supported_data_schemas: [{ schema: "prefscope.viewer_data", versions: [1] }] }));
    if (failure === "wrong-package") await writeFile(join(fixture.dist, "viewer-build.json"), jsonBytes({ ...fixture.build, package: "other" }));
    if (failure === "missing-index") await rm(join(fixture.dist, "index.html"));
    if (failure === "missing-build") await rm(join(fixture.dist, "viewer-build.json"));
    await assert.rejects(packageViewer(fixture));
    await absent(fixture.out); await noStaging(fixture.root);
    assert.deepEqual(await readFile(join(fixture.bundle, "viewer-bundle.json")), before);
  }
});

test("concurrent packaging reserves one new output and leaves a complete valid bundle", async t => {
  const fixture = await setup(t);
  const results = await Promise.allSettled([packageViewer(fixture), packageViewer(fixture)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  await open(fixture.out);
  await noStaging(fixture.root);
});
