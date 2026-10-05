/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // The same CSS is published as a library asset. Prefix every utility and disable the
  // global reset so embedding PrefScope cannot restyle the host application.
  important: ".prefscope-viewer",
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        ink: "#080b12",
        panel: "#111827",
        edge: "#253146",
        accent: "#7667f5",
        "accent-soft": "#a5b4fc",
        good: "#34d399",
        bad: "#f87171",
      },
      backgroundImage: {
        hero: "radial-gradient(circle at 12% 0%, rgba(118,103,245,.18), transparent 42%), linear-gradient(145deg, rgba(17,24,39,.96), rgba(8,11,18,.98))",
      },
      boxShadow: {
        glow: "0 0 32px rgba(118,103,245,.16)",
      },
    },
  },
  plugins: [],
};
