/**
 * The prototype's switches (/proto): the choices that are still open, so they
 * can be flipped on a phone and compared rather than argued about. Kept in
 * this browser's localStorage, which may be empty or refuse (a private
 * window): the defaults are the proposal.
 */
import { createContext, useContext, useEffect, useState } from "react";

export interface ProtoOptions {
  /** Whether the reader has an account: the main menu and the admin actions. */
  signedIn: boolean;
  /** What a form's leading control is: the word Cancel, or the back chevron. */
  formLeading: "cancel" | "back";
  /** Separate glass pills over the page, or one solid bar across it. */
  chrome: "pills" | "solid";
}

export const DEFAULT_OPTIONS: ProtoOptions = {
  signedIn: true,
  formLeading: "cancel",
  chrome: "pills",
};

const KEY = "glidecomp.proto.options";

function read(): ProtoOptions {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_OPTIONS, ...(JSON.parse(raw) as Partial<ProtoOptions>) } : DEFAULT_OPTIONS;
  } catch {
    return DEFAULT_OPTIONS;
  }
}

const OptionsContext = createContext<{
  options: ProtoOptions;
  setOption: <K extends keyof ProtoOptions>(key: K, value: ProtoOptions[K]) => void;
}>({ options: DEFAULT_OPTIONS, setOption: () => {} });

export function OptionsProvider({ children }: { children: React.ReactNode }) {
  const [options, setOptions] = useState<ProtoOptions>(DEFAULT_OPTIONS);
  // Read after mount, so the first render is the same with or without storage.
  useEffect(() => setOptions(read()), []);
  const setOption = <K extends keyof ProtoOptions>(key: K, value: ProtoOptions[K]) =>
    setOptions((prev) => {
      const next = { ...prev, [key]: value };
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Kept for this visit only.
      }
      return next;
    });
  return <OptionsContext.Provider value={{ options, setOption }}>{children}</OptionsContext.Provider>;
}

export function useProtoOptions() {
  return useContext(OptionsContext);
}
