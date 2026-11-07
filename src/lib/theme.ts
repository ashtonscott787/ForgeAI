/** Theme: light, dark, or follow the OS. Persisted, and safe when storage throws. */
import { useCallback, useEffect, useState } from "react";

export type ThemePref = "light" | "dark" | "system";
const KEY = "forge-theme";

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage can throw in some contexts; a default is fine */
  }
  return "system";
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(read);

  const apply = useCallback((p: ThemePref) => {
    const light = window.matchMedia("(prefers-color-scheme: light)").matches;
    const resolved = p === "system" ? (light ? "light" : "dark") : p;
    document.documentElement.dataset.theme = resolved;
  }, []);

  useEffect(() => {
    apply(pref);
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      /* ignore */
    }
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref, apply]);

  return { pref, setPref };
}
