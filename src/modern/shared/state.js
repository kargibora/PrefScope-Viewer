const ROUTES = new Set(["discover", "distribution", "prompts", "behaviors", "relationships", "coactivation", "models", "reliability", "atlas"]);
const ROUTE_ALIASES = new Map([["answers", "behaviors"], ["map", "atlas"], ["dataset", "distribution"]]);
const MODEL_MODES = { profile: "activity", distributions: "activity", preference: "preference", compare: "compare" };
const DATASET_MODES = { overview: "summary", summary: "summary", concepts: "contents", checks: "health" };
const MAX_HASH = 24000;
const safeKey = key => key.length > 0 && key.length <= 180 && !/[\u0000-\u001f]/.test(key) && !["__proto__", "constructor", "prototype"].includes(key);
function validValue(value, depth = 0) {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 512;
  if (!value || typeof value !== "object" || depth >= 4) return false;
  if (Array.isArray(value)) return value.length <= 128 && value.every(item => typeof item === "string" && item.length <= 512);
  const entries = Object.entries(value);
  return Object.getPrototypeOf(value) === Object.prototype && entries.length <= 32 && entries.every(([key, item]) => safeKey(key) && (item === undefined || validValue(item, depth + 1)));
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}
export function datasetScope(baseUrl) {
  let hash = 2166136261;
  for (const char of baseUrl) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}
export function normalizeRoute(path, initialRoute = "prompts") {
  const [rawRoute = "", subroute = ""] = path.replace(/^#?\/?/, "").split("/");
  const route = ROUTE_ALIASES.get(rawRoute) ?? rawRoute;
  const result = { route: ROUTES.has(route) ? route : initialRoute, state: {} };
  if (route === "models" && MODEL_MODES[subroute]) result.state["models.task"] = MODEL_MODES[subroute];
  if (route === "distribution" && DATASET_MODES[subroute]) result.state["dataset.view"] = DATASET_MODES[subroute];
  return result;
}
export function decodeViewerState(hash, scope, initialRoute = "prompts") {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const normalized = normalizeRoute(path, initialRoute), fallback = { ...normalized.state, "app.view": normalized.route };
  if (hash.length > MAX_HASH) return fallback;
  try {
    const params = new URLSearchParams(query);
    if (params.get("d") !== scope || !params.has("s")) return fallback;
    const parsed = JSON.parse(params.get("s"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return fallback;
    const entries = Object.entries(parsed);
    if (entries.length > 128 || !entries.every(([key, value]) => safeKey(key) && validValue(value))) {
      return parsed["exploration.selection"] != null ? { ...fallback, "exploration.selection": false } : fallback;
    }
    return { ...Object.fromEntries(entries), ...fallback };
  } catch { return fallback; }
}
export function encodeViewerState(values, scope, initialRoute = "prompts") {
  const normalized = normalizeRoute(typeof values["app.view"] === "string" ? values["app.view"] : initialRoute, initialRoute);
  const entries = Object.entries({ ...normalized.state, ...values })
    .map(([key, value]) => [key, key === "exploration.selection" && value !== undefined && !validValue(value) ? false : value])
    .filter(([key, value]) => key !== "app.view" && safeKey(key) && validValue(value));
  const params = new URLSearchParams({ d: scope, s: JSON.stringify(stable(Object.fromEntries(entries))) });
  const hash = `#${normalized.route}?${params}`;
  if (hash.length > MAX_HASH) throw new Error("Viewer state exceeds the accepted URL limit");
  return hash;
}
export const viewerRoutes = Object.freeze([...ROUTES]);

export function resolveWorkspaceAliases(values, { hasPrompt = true, hasAnswer = true } = {}) {
  const next = { ...values };
  const route = next["app.view"];
  if (route === "relationships") next["app.view"] = "prompts";
  else if (route === "coactivation") next["app.view"] = "behaviors";
  else if (route === "reliability") { next["app.view"] = "distribution"; next["contents.section"] = "checks"; }
  else if (route === "discover") next["app.view"] = "prompts";
  if (!hasPrompt && !hasAnswer && ["prompts", "behaviors"].includes(next["app.view"])) next["app.view"] = "distribution";
  else if (!hasAnswer && next["app.view"] === "behaviors") next["app.view"] = "prompts";
  else if (!hasPrompt && next["app.view"] === "prompts") next["app.view"] = "behaviors";
  return next;
}
