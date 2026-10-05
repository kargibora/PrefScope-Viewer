import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Analysis bundles can contain hundreds of MB of model outputs. They belong in the
  // standalone deployment/object storage, never in the reusable npm package.
  publicDir: false,
  build: {
    outDir: "lib",
    emptyOutDir: true,
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
      cssFileName: "style",
    },
    rollupOptions: {
      external: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "lucide-react",
        "recharts",
      ],
    },
  },
});
