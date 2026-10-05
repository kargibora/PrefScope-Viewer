import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createEngine } from "../src/modern/shared/engine.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const inside = (path, parent) => { const suffix = relative(parent, path); return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix)); };
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
async function tree(folder, prefix = "") {
  const entries = [];
  for (const item of await readdir(folder, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) throw new Error(`Unsupported file or symlink: ${path}`);
    if (item.isDirectory()) entries.push(...await tree(join(folder, item.name), path));
    else entries.push(path);
  }
  return entries.sort();
}
async function directory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected a directory without symlinks: ${path}`);
  return realpath(path);
}
async function destination(path) {
  if (await exists(path)) throw new Error(`Destination already exists: ${path}`);
  let ancestor = dirname(path), suffix = relative(ancestor, path);
  while (!await exists(ancestor)) { suffix = join(relative(dirname(ancestor), ancestor), suffix); ancestor = dirname(ancestor); }
  return join(await realpath(ancestor), suffix);
}
async function publish(source, destination) {
  // Reserve a new empty destination exclusively. Other invocations cannot claim it;
  // the completed staging tree replaces only this invocation's reservation.
  await mkdir(destination);
  try { await rename(source, destination); }
  catch (error) { await rmdir(destination); throw error; }
}
async function inventory(folder, paths) {
  return Promise.all(paths.map(async path => { const bytes = await readFile(join(folder, path)); return { path, sha256: hash(bytes), size_bytes: bytes.length }; }));
}
const localFetcher = files => async path => {
  const bytes = files.get(path);
  return bytes ? { ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer } : { ok: false, status: 404, statusText: `Missing ${path}` };
};

export async function packageViewer({ bundle, out, dist = join(root, "dist") }) {
  if (!bundle || !out) throw new Error("Usage: node scripts/package-viewer.mjs --bundle <existing-export> --out <new-directory> [--dist <build>]");
  const input = await directory(resolve(bundle)), buildRoot = await directory(resolve(dist));
  const output = await destination(resolve(out));
  if (inside(output, input) || inside(output, buildRoot)) throw new Error("Destination must be outside the input bundle and Viewer build");
  await tree(input);
  const viewerPaths = await tree(buildRoot);
  for (const path of ["data", "viewer-bundle.json", "viewer-data.json", "bundle_manifest.json"])
    if (await exists(join(buildRoot, path))) throw new Error(`Viewer build contains reserved path ${path}; use a dataset-free build`);
  const sourceFiles = new Map(await Promise.all(["data/viewer-data.json", "viewer-build.json", "viewer-bundle.json"].map(async path => [path, await readFile(join(input, path))])));
  const engine = await createEngine({ dataUrl: "data/viewer-data.json", buildUrl: "viewer-build.json", bundleUrl: "viewer-bundle.json", fetcher: localFetcher(sourceFiles) });
  const original = engine.dataset.bundle;
  // The engine has validated the descriptor and every manifest path. Retain the
  // exact verified bytes so packaging cannot omit or rewrite lazy answer text.
  const shardPaths = (JSON.parse(sourceFiles.get(original.data.path)).answer_text_shards?.files ?? []).map(file => file.path);
  for (const path of shardPaths) sourceFiles.set(path, await readFile(join(input, path)));
  await engine.ensureAllAnswerTexts();
  const dataPaths = [original.data.path, ...shardPaths];
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), `.${output.split(sep).at(-1)}.staging-`));
  try {
    for (const path of viewerPaths) { await mkdir(dirname(join(staging, path)), { recursive: true }); await copyFile(join(buildRoot, path), join(staging, path)); }
    const viewerFiles = await inventory(staging, await tree(staging));
    const buildBytes = await readFile(join(staging, "viewer-build.json")), build = JSON.parse(buildBytes);
    const manifest = { schema: "prefscope.viewer_bundle", schema_version: 1, producer: original.producer,
      viewer: { package: build.package, version: build.version,
        build: { path: "viewer-build.json", schema: build.schema, schema_version: build.schema_version, supported_data_schemas: build.supported_data_schemas },
        build_sha256: hash(Buffer.from(JSON.stringify(viewerFiles))) },
      data: original.data,
      files: [...viewerFiles, ...dataPaths.map(path => ({ path, sha256: hash(sourceFiles.get(path)), size_bytes: sourceFiles.get(path).length }))].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    // Reuse the engine's complete build/schema and byte-integrity validation before publishing.
    await createEngine({ dataUrl: original.data.path, buildUrl: "viewer-build.json", bundleUrl: "viewer-bundle.json", expectedViewerVersion: build.version,
      fetcher: localFetcher(new Map([...sourceFiles, ["viewer-build.json", buildBytes], ["viewer-bundle.json", manifestBytes]])) });
    for (const path of dataPaths) {
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await writeFile(join(staging, path), sourceFiles.get(path));
    }
    await writeFile(join(staging, "viewer-bundle.json"), manifestBytes);
    await publish(staging, output);
    return output;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { bundle: { type: "string" }, out: { type: "string" }, dist: { type: "string" } } });
    console.log(`Packaged modern Viewer: ${await packageViewer(values)}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
