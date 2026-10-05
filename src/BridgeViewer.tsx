import { useMemo, useState } from "react";
import { Braces, Database, Grid3X3, Library, Search } from "lucide-react";
import { decodeSplitTable, type AxisValue, type JsonValue, type ViewerData, type ViewerSplitTable } from "./bridgeData";

export interface BridgeViewerProps {
  data: ViewerData;
  className?: string;
  layout?: "standalone" | "embedded";
}

type Section = "overview" | "catalog" | `table:${string}`;

function axisText(value: AxisValue): string {
  const partText = (part: AxisValue): string => {
    if (part === null) return "—";
    if (Array.isArray(part)) return part.map(partText).join(" / ");
    return typeof part === "object" ? JSON.stringify(part) : String(part);
  };
  return partText(value);
}

function valueText(value: JsonValue): string {
  if (value === null) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function displayName(name: string): string {
  return name.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-edge/80 bg-panel/65 p-5 ${className}`}>{children}</section>;
}

function OverviewSection({ data }: { data: ViewerData }) {
  const views = Object.entries(data.views);
  const metadata = Object.keys(data.row_metadata);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          [data.row_ids.length, "Rows"],
          [data.feature_ids.length, "Features"],
          [views.length, "Feature views"],
          [Object.keys(data.tables).length, "Result tables"],
        ].map(([value, label]) => (
          <Panel key={String(label)}>
            <div className="text-2xl font-semibold tabular-nums text-slate-50">{Number(value).toLocaleString()}</div>
            <div className="mt-1 text-xs uppercase tracking-[0.14em] text-slate-500">{label}</div>
          </Panel>
        ))}
      </div>
      <Panel className="bg-hero">
        <div className="flex items-start gap-3">
          <Grid3X3 className="mt-0.5 shrink-0 text-accent-soft" size={20} />
          <div>
            <h2 className="text-base font-semibold text-slate-100">Feature matrices</h2>
            <p className="mt-1 text-sm text-slate-400">Aligned existing feature values. This bridge does not calculate new analyses.</p>
          </div>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {views.map(([name, view]) => (
            <div key={name} className="rounded-xl border border-edge/70 bg-ink/50 p-4">
              <div className="flex items-center justify-between gap-4">
                <h3 className="truncate font-mono text-sm font-semibold text-slate-100">{name}</h3>
                <span className="rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent-soft">{view.role}</span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <dt className="text-slate-500">Shape</dt><dd className="text-right tabular-nums text-slate-300">{data.row_ids.length.toLocaleString()} × {data.feature_ids.length.toLocaleString()}</dd>
                <dt className="text-slate-500">Orientation</dt><dd className="truncate text-right text-slate-300" title={view.orientation}>{view.orientation}</dd>
                <dt className="text-slate-500">Polarity</dt><dd className="truncate text-right text-slate-300" title={view.activation_polarity}>{view.activation_polarity}</dd>
                <dt className="text-slate-500">Semantics</dt><dd className="truncate text-right text-slate-300" title={view.code_semantics}>{view.code_semantics}</dd>
              </dl>
            </div>
          ))}
        </div>
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <h2 className="text-sm font-semibold text-slate-200">Row metadata</h2>
          {metadata.length ? <div className="mt-3 flex flex-wrap gap-2">{metadata.map((name) => <span key={name} className="rounded-lg bg-ink px-2.5 py-1 font-mono text-xs text-slate-400">{name}</span>)}</div> : <p className="mt-2 text-sm text-slate-500">No row metadata was supplied.</p>}
        </Panel>
        <Panel>
          <h2 className="text-sm font-semibold text-slate-200">Feature catalog</h2>
          <p className="mt-2 text-sm text-slate-400">{data.catalog ? `${data.catalog.table.data.length.toLocaleString()} feature annotations are available.` : "No feature catalog was supplied."}</p>
        </Panel>
      </div>
    </div>
  );
}

function CatalogSection({ data }: { data: ViewerData }) {
  const [query, setQuery] = useState("");
  const decoded = useMemo(() => data.catalog ? decodeSplitTable(data.catalog.table) : null, [data.catalog]);
  const columns = decoded?.columns.map(axisText) ?? [];
  const idIndex = columns.indexOf("feature_id");
  const annotationIndexes = columns.map((column, index) => ({ column, index })).filter(({ column }) => column !== "feature_id");
  const titleIndexes = ["name", "description", ...columns.filter((column) => column !== "feature_id" && column !== "name" && column !== "description")]
    .map((column) => ({ column, index: columns.indexOf(column) }));
  const filtered = useMemo(() => {
    if (!decoded) return [];
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return decoded.rows;
    return decoded.rows.filter((row) => row.values.some((value) => valueText(value).toLocaleLowerCase().includes(needle)));
  }, [decoded, query]);
  if (!decoded) return <Panel><h2 className="text-base font-semibold text-slate-100">No catalog supplied</h2><p className="mt-2 text-sm text-slate-400">Add a <code>FeatureCatalog</code> when exporting to browse feature annotations.</p></Panel>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h2 className="text-xl font-semibold text-slate-100">Feature catalog</h2><p className="mt-1 text-sm text-slate-400">Search caller-supplied proposed annotations. Labels are not verified feature meanings.</p></div>
        <label className="flex w-full max-w-sm items-center gap-2 rounded-xl border border-edge bg-panel px-3 py-2 text-sm focus-within:border-accent/60">
          <Search size={16} className="shrink-0 text-slate-500" />
          <span className="sr-only">Search feature annotations</span>
          <input className="w-full bg-transparent outline-none placeholder:text-slate-600" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search feature annotations…" />
        </label>
      </div>
      <div className="text-xs text-slate-500">{filtered.length.toLocaleString()} result{filtered.length === 1 ? "" : "s"}{filtered.length > 250 ? " · showing first 250" : ""}</div>
      <div className="grid gap-3 lg:grid-cols-2">
        {filtered.slice(0, 250).map((row, rowNumber) => {
          const featureId = idIndex >= 0 ? row.values[idIndex] : row.index;
          const title = titleIndexes.find(({ index }) => typeof row.values[index] === "string" && (row.values[index] as string).trim());
          const primary = title ? row.values[title.index] : `Feature ${valueText(featureId)}`;
          return <Panel key={`${axisText(row.index)}:${rowNumber}`} className="p-4">
            <div className="flex items-start justify-between gap-4"><h3 className="text-sm font-semibold text-slate-100">{valueText(primary)}</h3><span className="shrink-0 font-mono text-[11px] text-accent-soft">#{valueText(featureId)}</span></div>
            <dl className="mt-3 space-y-1.5">{annotationIndexes.filter(({ index }) => row.values[index] !== null && index !== title?.index).map(({ column, index }) => <div key={column} className="grid grid-cols-[7rem_1fr] gap-3 text-xs"><dt className="truncate text-slate-500" title={column}>{displayName(column)}</dt><dd className="break-words text-slate-300">{valueText(row.values[index])}</dd></div>)}</dl>
          </Panel>;
        })}
      </div>
      {!filtered.length && <Panel><p className="text-sm text-slate-400">No feature annotations match “{query}”.</p></Panel>}
    </div>
  );
}

function GenericTable({ name, table }: { name: string; table: ViewerSplitTable }) {
  const decoded = useMemo(() => decodeSplitTable(table), [table]);
  const rows = decoded.rows.slice(0, 200);
  return <div className="space-y-4">
    <div><h2 className="text-xl font-semibold text-slate-100">{displayName(name)}</h2><p className="mt-1 text-sm text-slate-400">{decoded.rows.length.toLocaleString()} rows · {decoded.columns.length.toLocaleString()} columns{decoded.rows.length > 200 ? " · showing first 200" : ""}</p></div>
    <Panel className="overflow-hidden p-0"><div className="overflow-auto"><table className="min-w-full border-collapse text-left text-xs"><thead className="sticky top-0 bg-ink"><tr><th className="border-b border-edge px-3 py-2 font-medium text-slate-500">{decoded.indexNames.map(axisText).filter((name) => name !== "—").join(" / ") || "Index"}</th>{decoded.columns.map((column, index) => <th key={`${axisText(column)}:${index}`} className="whitespace-nowrap border-b border-edge px-3 py-2 font-medium text-slate-400">{axisText(column)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={`${axisText(row.index)}:${rowIndex}`} className="border-b border-edge/50 last:border-0 hover:bg-ink/40"><th className="whitespace-nowrap px-3 py-2 font-mono font-normal text-slate-500">{axisText(row.index)}</th>{row.values.map((value, columnIndex) => <td key={columnIndex} className="max-w-xs whitespace-nowrap px-3 py-2 text-slate-300" title={valueText(value)}>{valueText(value)}</td>)}</tr>)}</tbody></table></div></Panel>
  </div>;
}

export default function BridgeViewer({ data, className = "", layout = "embedded" }: BridgeViewerProps) {
  const tableNames = Object.keys(data.tables);
  const [section, setSection] = useState<Section>("overview");
  const activeTable = section.startsWith("table:") ? section.slice(6) : null;
  const nav = [
    { id: "overview" as const, label: "Overview", icon: Database },
    ...(data.catalog ? [{ id: "catalog" as const, label: "Feature catalog", icon: Library }] : []),
    ...tableNames.map((name) => ({ id: `table:${name}` as const, label: displayName(name), icon: Grid3X3 })),
  ];
  return <div className={`prefscope-viewer ${layout === "standalone" ? "min-h-screen" : "min-h-[640px]"} ${className}`}>
    <div className="mx-auto flex min-h-[inherit] max-w-[1600px] flex-col lg:flex-row">
      <aside className="shrink-0 border-b border-edge/70 bg-ink/55 p-4 lg:w-72 lg:border-b-0 lg:border-r lg:p-5">
        <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl border border-accent/30 bg-accent/10 text-accent-soft"><Braces size={20} /></div><div><div className="font-semibold text-slate-50">PrefScope</div><div className="text-[10px] uppercase tracking-[0.17em] text-slate-500">Viewer data bridge</div></div></div>
        <nav className="mt-5 flex gap-1 overflow-x-auto lg:flex-col" aria-label="Bridge data views">{nav.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setSection(id)} aria-current={section === id ? "page" : undefined} className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition lg:w-full ${section === id ? "bg-accent/15 text-slate-50 ring-1 ring-inset ring-accent/25" : "text-slate-400 hover:bg-panel hover:text-slate-200"}`}><Icon size={16} className={section === id ? "text-accent-soft" : "text-slate-500"} /><span className="truncate">{label}</span></button>)}</nav>
        <div className="mt-5 hidden rounded-xl border border-edge/70 bg-panel/45 p-3 text-xs text-slate-500 lg:block"><div className="font-medium text-slate-300">Schema v{data.schema_version}</div><div className="mt-1">{data.row_ids.length.toLocaleString()} rows · {data.feature_ids.length.toLocaleString()} features</div></div>
      </aside>
      <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
        {section === "overview" && <OverviewSection data={data} />}
        {section === "catalog" && <CatalogSection data={data} />}
        {activeTable && data.tables[activeTable] && <GenericTable name={activeTable} table={data.tables[activeTable]} />}
      </main>
    </div>
  </div>;
}
