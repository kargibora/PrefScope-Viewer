# PrefScope Viewer

[PrefScope](https://github.com/kargibora/PrefScope) exports concept analyses as Viewer bundles. PrefScope Viewer renders those bundles.

## Install

Requires Node.js 22.

```sh
git clone https://github.com/kargibora/PrefScope-Viewer.git
cd PrefScope-Viewer
npm ci
```

## Run

Point to a PrefScope export directory containing `viewer-bundle.json`:

```sh
PREFSCOPE_VIEWER_BUNDLE=/path/to/export/site npm run dev
```

Run `npm test` to check the code or `npm run build` to build the Viewer.
