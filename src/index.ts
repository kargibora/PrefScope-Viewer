import "./index.css";

export { default as PrefScopeViewer } from "./App";
export type { PrefScopeViewerProps, ViewId } from "./App";
export {
  configureDataSource,
  currentDataSource,
  loadBundle,
  loadDatasets,
  PrefScopeDataClient,
} from "./data";
export type { DatasetInfo } from "./data";
export * from "./types";

export { default as BridgeViewer } from "./BridgeViewer";
export type { BridgeViewerProps } from "./BridgeViewer";
export { decodeSplitTable, validateViewerData } from "./bridgeData";
export {
  validateViewerBundleManifest,
  verifyViewerDataBytes,
} from "./bundleManifest";
export type { ViewerBundleFile, ViewerBundleManifest } from "./bundleManifest";
export type {
  AxisValue,
  DecodedSplitTable,
  DecodedTableRow,
  JsonPrimitive,
  JsonValue,
  ViewerCatalog,
  ViewerData,
  ViewerFeatureSpace,
  ViewerFeatureView,
  ViewerSplitTable,
} from "./bridgeData";
