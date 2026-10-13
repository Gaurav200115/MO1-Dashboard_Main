"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

type Mode = "light" | "system" | "dark";

const STORAGE_KEY = "n200-theme";

/** Dark unless something stored says otherwise — see globals.css and layout.tsx. */
const DEFAULT_MODE: Mode = "dark";

const OPTIONS: { mode: Mode; label: string; Icon: typeof Sun }[] = [
  { mode: "light", label: "Light", Icon: Sun },
  { mode: "system", label: "System", Icon: Monitor },
  { mode: "dark", label: "Dark", Icon: Moon },
];

function readStored(): Mode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "system" || stored === "dark") return stored;
  } catch {
    /* private mode / blocked storage — take the default */
  }
  return DEFAULT_MODE;
}

export default function ThemeToggle() {
  const [mode, setMode] = useState<Mode>(DEFAULT_MODE);

  useEffect(() => {
    const stored = readStored();
    setMode(stored);
    /*
     * The attribute is re-asserted here, not just mirrored into state.
     * layout.tsx stamps it before first paint, but that script was the only
     * writer: any load where its read came up empty left the ground light while
     * this toggle still showed "Dark" selected, with nothing to correct it for
     * the rest of the session. Writing it again on mount closes that gap.
     */
    document.documentElement.setAttribute("data-theme", stored);
  }, []);

  function apply(next: Mode) {
    setMode(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* not fatal — the attribute is already applied */
    }
  }

  return (
    <div
      className="flex overflow-hidden rounded-md border border-line"
      role="group"
      aria-label="Colour theme"
    >
      {OPTIONS.map(({ mode: m, label, Icon }) => (
        <button
          key={m}
          type="button"
          onClick={() => apply(m)}
          aria-pressed={mode === m}
          title={label}
          className={
            mode === m
              ? "bg-accent px-2.5 py-1.5 text-accentink"
              : "bg-sunken px-2.5 py-1.5 text-muted hover:text-ink"
          }
        >
          <Icon size={13} strokeWidth={2.2} aria-hidden />
          <span className="sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
