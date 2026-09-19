import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { setupIonicReact } from "@ionic/react";

export type Role = "pilot" | "organiser";
export type ThemePref = "light" | "dark" | "auto";
export type Mode = "ios" | "md";
export type Units = {
  speed: "km/h" | "mph" | "knots";
  altitude: "m" | "ft";
  climbRate: "m/s" | "ft/min" | "knots";
  distance: "km" | "mi" | "nmi";
};

interface Prefs {
  mode: Mode;
  theme: ThemePref;
  role: Role;
  signedIn: boolean;
  units: Units;
  setMode: (mode: Mode) => void;
  setTheme: (theme: ThemePref) => void;
  setRole: (role: Role) => void;
  setSignedIn: (v: boolean) => void;
  setUnit: <K extends keyof Units>(key: K, value: Units[K]) => void;
  formatAltitude: (metres: number) => string;
  formatDistance: (km: number) => string;
}

const DEFAULT_UNITS: Units = {
  speed: "km/h",
  altitude: "m",
  climbRate: "m/s",
  distance: "km",
};

const PrefsContext = createContext<Prefs | null>(null);

function applyTheme(theme: ThemePref) {
  const dark =
    theme === "dark" ||
    (theme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("ion-palette-dark", dark);
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>("ios");
  const [theme, setThemeState] = useState<ThemePref>("light");
  const [role, setRole] = useState<Role>("pilot");
  const [signedIn, setSignedIn] = useState(true);
  const [units, setUnits] = useState<Units>(DEFAULT_UNITS);

  const setMode = useCallback((next: Mode) => {
    setModeState(next);
    setupIonicReact({ mode: next });
    document.documentElement.setAttribute("mode", next);
    const app = document.querySelector("ion-app");
    if (app) app.setAttribute("mode", next);
  }, []);

  const setTheme = useCallback((next: ThemePref) => {
    setThemeState(next);
    applyTheme(next);
  }, []);

  useEffect(() => {
    applyTheme(theme);
    if (theme !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("auto");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setUnit = useCallback(<K extends keyof Units>(key: K, value: Units[K]) => {
    setUnits((prev) => ({ ...prev, [key]: value }));
  }, []);

  const formatAltitude = useCallback(
    (metres: number) =>
      units.altitude === "ft" ? `${Math.round(metres * 3.28084)} ft` : `${Math.round(metres)} m`,
    [units.altitude]
  );

  const formatDistance = useCallback(
    (km: number) => {
      if (units.distance === "mi") return `${(km * 0.621371).toFixed(1)} mi`;
      if (units.distance === "nmi") return `${(km * 0.539957).toFixed(1)} NM`;
      return `${km.toFixed(1)} km`;
    },
    [units.distance]
  );

  const value = useMemo<Prefs>(
    () => ({
      mode,
      theme,
      role,
      signedIn,
      units,
      setMode,
      setTheme,
      setRole,
      setSignedIn,
      setUnit,
      formatAltitude,
      formatDistance,
    }),
    [
      mode,
      theme,
      role,
      signedIn,
      units,
      setMode,
      setTheme,
      setUnit,
      formatAltitude,
      formatDistance,
    ]
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): Prefs {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error("usePrefs must be used inside PrefsProvider");
  return ctx;
}
