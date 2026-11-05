import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { installActivityFeedback } from "./lib/activity";
import { installTableLabels } from "./lib/tableLabels";

installActivityFeedback();
installTableLabels();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
