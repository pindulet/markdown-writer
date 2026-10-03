import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { platform } from "./backend";
import { initViewport } from "./viewport";
import "./styles.css";
import "./mobile.css";
import "./mobile-editor.css";

// bruges af mobile.css til regler, der gælder hele siden (html/body)
document.documentElement.dataset.platform = platform;
initViewport();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
