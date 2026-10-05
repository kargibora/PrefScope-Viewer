import { rmSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const staging = join(root, `.dist-bundle-staging-${process.pid}`);

function run(script, args) {
  const result = spawnSync(process.execPath, [join(root, script), ...args], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${script} exited with status ${result.status ?? "unknown"}`);
}

rmSync(dist, { recursive: true, force: true });
rmSync(staging, { recursive: true, force: true });
try {
  run("node_modules/typescript/bin/tsc", ["-b"]);
  run("node_modules/vite/bin/vite.js", [
    "build",
    "--mode", "bundle",
    "--outDir", staging,
    "--emptyOutDir",
  ]);
  renameSync(staging, dist);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
