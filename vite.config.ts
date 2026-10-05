import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const packageVersion = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;

function viewerBuildManifest(): Plugin {
  return {
    name: "prefscope-viewer-build-manifest",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "viewer-build.json",
        source: JSON.stringify({
          schema: "prefscope.viewer_build",
          schema_version: 1,
          package: "@prefscope/viewer",
          version: packageVersion,
          supported_data_schemas: [
            { schema: "prefscope.viewer_data", versions: [1, 2] },
          ],
        }),
      });
    },
  };
}

function previewDataset(directory: string): Plugin {
  return {
    name: "prefscope-local-preview-dataset",
    configureServer(server) {
      if (!directory) {
        server.config.logger.warn("No export selected. Set PREFSCOPE_VIEWER_BUNDLE to a viewer export directory.");
        return;
      }
      server.config.logger.info(`PrefScope export: ${resolve(directory)}`);
      const files = new Set(["/data/viewer-data.json", "/viewer-build.json", "/viewer-bundle.json"]);
      const root = realpathSync(directory);
      const manifest = JSON.parse(readFileSync(resolve(root, "viewer-bundle.json"), "utf8"));
      for (const file of manifest.files ?? []) {
        const path = file.path;
        if (typeof path === "string" && path.startsWith("data/answer-text/") &&
            !/[\\:\u0000-\u001f]/.test(path) && path.split("/").every(part => part && part !== "." && part !== ".."))
          files.add(`/${path}`);
      }
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0] || "";
        if (!files.has(path)) {
          if (!path.startsWith("/data/answer-text/")) return next();
          response.statusCode = 404; response.end("Dataset artifact unavailable"); return;
        }
        try {
          const target = realpathSync(resolve(root, path.slice(1)));
          if (!target.startsWith(root + sep)) throw new Error("Dataset artifact outside export");
          const bytes = readFileSync(target);
          response.setHeader("Content-Type", "application/json");
          response.setHeader("Cache-Control", "no-store");
          response.end(bytes);
        } catch { response.statusCode = 404; response.end("Dataset artifact unavailable"); }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
 const preview = loadEnv(mode, process.cwd(), "PREFSCOPE_").PREFSCOPE_VIEWER_BUNDLE || "";
 return ({
  // relative base so the build works under any path, incl. GitHub Pages
  // project sites served at https://<user>.github.io/<repo>/
  base: "./",
  define: {
    __PREFSCOPE_BUNDLE_MODE__: JSON.stringify(mode === "bundle"),
    __PREFSCOPE_VIEWER_VERSION__: JSON.stringify(packageVersion),
  },
  // Every standalone build is dataset-free. Local data is served only by the
  // development middleware; exports add one validated dataset after the build.
  publicDir: false,
  plugins: [react(), viewerBuildManifest(), previewDataset(preview)],
  server: { port: 5273, open: true },
});
});
