# PrefScope Viewer

The default standalone application is the approved desktop Prompt/Answer viewer. Its
source is in `src/modern/app`, and its shared data engine is in `src/modern/shared`.
The existing React embedding API remains available as a separate library build.

Concept lists support name or exact `#ID` search, named-label filtering, and activity/name/ID
sorting. Full catalogs use 60-row pages. The map opens with a searchable concept list;
selecting a concept colors dots by activation strength. Its Examples tab shows text
excerpts, strongest/weakest sorting, and full scrollable text on selection. Both map
lists use 20-row pages. Gray inactive dots remain inspectable for comparison.
Double-click a dot, press Enter on a selected dot, or use Expand sample to open a
full-text reader with prompt context, activation strength, and Previous/Next controls.
Live panning, pointer-centered zoom, area selection, Fit active, and keyboard browsing
(arrows, Home/End) are supported. Concept changes preserve the camera and selected area;
each projection remembers its selected concepts. Combining concepts is an explicit AND filter.

Prompts and Answers always format Markdown, code blocks, and math; complete leading
`<think>` sections open separately. Source record drawers preserve the supplied text exactly. Concept explanations remember their
open/closed state while browsing, and activation/relationship filters stay visible above
the reader with individual removal controls.

The five workspaces are Prompts, Answers, Map, Models, and Dataset. Prompt and Answer
readers include concept activations, population distributions, source records, and a
searchable relationship explorer. Answer model selection uses actual model identities,
including models appearing on either side of a comparison. Missing preference scores
remain missing. Models can compare any two supplied model identities across all their
samples or their direct battles, with separate prompt, individual-answer, and pair
distributions when those measurements are available. Click table headers to cycle
descending, ascending, and original order (model names start alphabetically).

Models uses one navigation row: Performance, Concept breakdown, Model profile, and
Compare models. Prompt/answer source, measure, and sample scope are labeled fields
inside the analysis rather than additional navigation tabs. Performance shows recorded
outcomes; Concept breakdown compares a selected concept across models. Profiles show prompt-conditioned outcomes relative to
the model’s overall score, individual answer activity relative to other models, and
outcome associations for more/less pronounced matched answers. Tables sort directly from
their headers; examples retain the selected model, concept, and opponent scope.

Explicit outcomes use wins plus half ties; supplied preference probabilities remain a
separate metric. Profile associations select one outcome kind for the cohort and never
fill missing winner labels with probabilities. Difference-only lenses expose relative
comparisons against observed opponents, not absolute individual-answer activity.
Two-model comparisons also support prompt outcomes and answer outcome associations.
These are descriptive sample statistics, not causal effects or calibrated concept presence.

## Develop locally

```bash
npm ci
PREFSCOPE_VIEWER_BUNDLE=/absolute/path/to/a/viewer-export npm run dev
```

Alternatively set `PREFSCOPE_VIEWER_BUNDLE` in an ignored `.env.local`. The directory must
contain `viewer-bundle.json`, `viewer-build.json`, and `data/viewer-data.json`. The development middleware serves these artifacts and any declared answer-text shards. No dataset is copied into
source control or production builds. Open the URL printed by Vite (normally port 5273).
An explicit environment variable overrides `.env.local` for that run. Without an override,
repeated starts use the export saved in `.env.local`. Vite prints the selected export path
at startup. Point to the directory containing the artifacts (often `<export>/site`),
not just a `viewer-data.json` file. Stop the server and run the command again to switch.

Do not pass an export folder as a positional Vite argument (`npm run dev -- <export>`):
that runs the older application bundled inside the export. Select its data with
`PREFSCOPE_VIEWER_BUNDLE` instead, or refresh its bundled application with `package:viewer`.

Development uses the latest viewer source with the chosen export’s data. Serving an
export with `python3 -m http.server` instead uses the viewer files already inside that export.

## Build and export

```bash
npm run build
# Equivalent dataset-free export build:
npm run build:bundle
```

Both commands produce the modern application in `dist/`, with a `viewer-build.json`
compatible with `prefscope.viewer_data` versions 1 and 2. Assets use relative URLs, so an
export can be hosted beneath a nested path. `public/data`, legacy release artifacts,
configured remote data URLs, and review-only fixture switches are excluded.

For newly computed data, use the PrefScope exporter:

```bash
prefscope-export-viewer \
  --features /path/to/features \
  --viewer-dist /path/to/PrefScope-Viewer/dist \
  --catalog /path/to/catalog.json \
  --out /path/to/new-viewer-site
```

To replace the viewer in an existing **modern** export while retaining its exact data:

```bash
npm run package:viewer -- --bundle /path/to/existing-export --out /path/to/new-viewer-site
python3 -m http.server --bind 127.0.0.1 --directory /path/to/new-viewer-site 8000
```

The packager validates the input, copies the built application, preserves the dataset
bytes (including lazy answer-text shards), and regenerates the manifest and build identity. The output must be a new directory.
The viewer verifies data/build hashes and the executing package version before rendering.
Serve over HTTPS or loopback HTTP for Web Crypto. Missing or invalid artifacts display an
error and never fall back to a different dataset.

Concept explanations use the optional catalog `description` column. Prompt and answer
readers, Dataset concept details, and model evidence show an expandable “Evidence”
section when text is supplied. Signed concepts use their own pole description; a positive
explanation is never reused for the negative pole. Naming CSV `evidence_summary` values
should be exported as catalog `description` values.

Datasets without prompts open in Answers; absent maps display an explicit empty state.
The desktop layout supports widths of 1024 px and above. Independent measurement banks
are kept separate; the current standalone engine accepts one prompt and one answer bank.

## Checks

```bash
npm test                      # public bundle, React API, modern engine contracts
npm run test:modern:browser    # built app; uv and Playwright Chromium required
npm run test:performance       # long-text correctness and browser interaction timings
npm run test:scale             # synthetic individual exports: 2,048 concepts, 106 models
npm run test:models            # unified profiles, outcomes, source gating and evidence
npm run test:map               # map ownership, live pan, zoom, keyboard, degenerate projections
npm run build:lib             # existing React package
```

The production browser smoke uses temporary synthetic v1/v2 exports, exercises nested
paths and every workspace, and rejects missing, corrupted, or mismatched artifacts. Set
`APPROVED_VIEWER_DATA` to an external review payload to additionally verify its exact
counts and interactions. No real dataset is stored in the test suite. The performance check uses temporary
long-answer fixtures; set `PERFORMANCE_VIEWER_DATA` to a local `viewer-data.json`
to include your own dataset. It reports timings without machine-specific pass thresholds.

The scale check uses current-format nonnegative individual activations: 3,000 standalone
answers and a separate 1,500-battle export containing 3,000 individually measured answers.
It checks model selection, concept search, bounded tables, and all-sample versus
head-to-head comparisons without requiring preference scores. These are synthetic
compatibility checks, not Arena measurements or paper results. Activation matrices are
currently loaded in full; this test does not establish support for the old Arena report's
entire 241,509-battle corpus. Text sharding does not reduce activation-matrix memory.
Generate new exports through the current exporter; the test does not convert legacy data.

## GitHub Pages

This repository contains source code only. Pages is not enabled until a compatible
PrefScope Viewer export is approved for public release. Review its text, answer-text
shards, and licensing before packaging it with `npm run package:viewer`; do not deploy a
private or local review export. The older `completion_m2048-public.tar.gz` uses a legacy
format and is not compatible with this viewer.

## Embed as a React package

Build the package locally:

```bash
npm run build:lib
```

Then use it from another React application:

```tsx
import { PrefScopeViewer } from "@prefscope/viewer";
import "@prefscope/viewer/style.css";

export default function Analysis() {
  return (
    <PrefScopeViewer
      dataBaseUrl="https://example.org/my-analysis/"
      initialView="models"
      layout="embedded"
      syncUrl
    />
  );
}
```

The data URL must contain `meta.json`, `features.json`, and normally
`bundle_manifest.json`. Every mounted viewer owns an isolated data client, cache, manifest,
and in-flight request set, so multiple viewers may point at different bundles on one page.
The published stylesheet is scoped below `.prefscope-viewer` and does not apply Tailwind's
global reset to the host application.

Bridge consumers can validate untrusted JSON and render it directly:

```tsx
import { BridgeViewer, validateViewerData } from "@prefscope/viewer";

const data = validateViewerData(await response.json());
return <BridgeViewer data={data} />;
```

The package also exports the bridge TypeScript types and `decodeSplitTable`, which
preserves pandas split-table index and multi-level axis values.


## Individual and difference lenses

The standalone viewer supports individual response activations and oriented response-difference
activations in the same export. Answers exposes an Individual / Compare selector when both
are present. Difference observations show both responses and one pair-owned activation profile;
positive and negative poles follow the supplied `a_minus_b` or `b_minus_a` orientation, independently
of preference. Model filters match either participant. Quantiles, relationships, dataset coverage,
and supplied pair projections use pair populations. Missing preferences remain missing.

For multi-model comparison datasets, Models compares observed win scores (ties count as half)
and supplied preference, with opponent and support filters. Its Concepts view ranks how often
each model expresses the selected concept more strongly, and shows the mean signed gap.
Examples include both responses and can be filtered to more or less activation; zero-gap
examples are excluded from concept evidence. Model table headers sort by frequency, mean gap, or support; clicks cycle highest first,
lowest first, and default order. Model names cycle A–Z, Z–A, and default order.
Compare models selects any two participants and compares their full prompt and answer concept
distributions across all samples or only head-to-head battles. Direct battle outcomes and
responses remain separately inspectable, including battles without concept activity.
Reader cards mark the selected concept’s stronger side; text is always formatted, with exact
original text available in Source record drawers. No individual activations or map coordinates
are synthesized from differences. Exports currently support one measurement group per lens.

A reproducible Arena test export can be created from the sibling agreement repository:

```bash
../PrefScope-reporting-public/.venv/bin/python scripts/export-arena-viewer.py \
  --rows 2000 --out .viewer-preview/arena-test
PREFSCOPE_VIEWER_BUNDLE=.viewer-preview/arena-test npm run dev -- --port 5276
npm run test:difference
```

## Compatibility

The React package retains the existing `PrefScopeViewer`, `BridgeViewer`, validation,
and data-client exports. It continues to use its established artifact contracts; the
standalone redesign does not silently change those embedding APIs. Legacy React sources
remain in `src/` for existing consumers, while the web entry point imports the modern app.

MIT licensed.
