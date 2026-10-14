import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { windowRole } from "@/core/platform";
import { OutputApp } from "@/app/OutputApp";
import { OperatorApp } from "@/app/OperatorApp";

document.documentElement.classList.add("dark");
document.title = windowRole === "output" ? "Salvation Live Studio — Output" : "Salvation Live Studio";

createRoot(document.getElementById("root")!).render(
  <StrictMode>{windowRole === "output" ? <OutputApp /> : <OperatorApp />}</StrictMode>,
);

if (import.meta.env.DEV) {
  // Dev-only handle for inspecting state from the console.
  void Promise.all([import("@/store/show"), import("@/store/project")]).then(([s, p]) => {
    (window as unknown as Record<string, unknown>).__sls = { show: s.useShow, project: p.useProject };
  });
}
