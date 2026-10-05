import React from "react";
import ReactDOM from "react-dom/client";
import StandaloneApp from "./StandaloneApp";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StandaloneApp
      bundleMode={__PREFSCOPE_BUNDLE_MODE__}
      viewerVersion={__PREFSCOPE_VIEWER_VERSION__}
      dataBaseUrl={
        __PREFSCOPE_BUNDLE_MODE__
          ? undefined
          : import.meta.env.VITE_PREFSCOPE_DATA_URL
      }
    />
  </React.StrictMode>
);
