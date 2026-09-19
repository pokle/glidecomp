import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PrefsProvider, usePrefs } from "@/state/prefs";
import App from "@/App";

import "@ionic/react/css/core.css";
import "@ionic/react/css/normalize.css";
import "@ionic/react/css/structure.css";
import "@ionic/react/css/typography.css";
import "@ionic/react/css/padding.css";
import "@ionic/react/css/float-elements.css";
import "@ionic/react/css/text-alignment.css";
import "@ionic/react/css/text-transformation.css";
import "@ionic/react/css/flex-utils.css";
import "@ionic/react/css/display.css";
import "@fontsource-variable/atkinson-hyperlegible-next";
import "@/theme/variables.css";

function Shell() {
  const { mode, setMode, theme, setTheme, role, setRole } = usePrefs();

  return (
    <div className="poc-shell">
      <div className="poc-controls" role="region" aria-label="Proof of concept controls">
        <strong>GlideComp · Ionic POC</strong>
        <span className="poc-seg" role="group" aria-label="Platform look">
          <button type="button" aria-pressed={mode === "ios"} onClick={() => setMode("ios")}>
            iOS
          </button>
          <button type="button" aria-pressed={mode === "md"} onClick={() => setMode("md")}>
            Material
          </button>
        </span>
        <span className="poc-seg" role="group" aria-label="Theme">
          <button type="button" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>
            Light
          </button>
          <button type="button" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>
            Dark
          </button>
          <button type="button" aria-pressed={theme === "auto"} onClick={() => setTheme("auto")}>
            Auto
          </button>
        </span>
        <span className="poc-seg" role="group" aria-label="Role">
          <button type="button" aria-pressed={role === "pilot"} onClick={() => setRole("pilot")}>
            Pilot
          </button>
          <button
            type="button"
            aria-pressed={role === "organiser"}
            onClick={() => setRole("organiser")}
          >
            Organiser
          </button>
        </span>
        <span className="poc-note">Mocked data · no APIs</span>
      </div>
      <div className="poc-stage">
        <div className="poc-phone">
          <App />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PrefsProvider>
      <Shell />
    </PrefsProvider>
  </StrictMode>
);
