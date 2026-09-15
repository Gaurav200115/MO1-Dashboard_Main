"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

type Mode = "light" | "system" | "dark";

const OPTIONS: { mode: Mode; label: string; Icon: typeof Sun }[] = [
  { mode: "light", label: "Light", Icon: Sun },
  { mode: "system", label: "System", Icon: Monitor },
  { mode: "dark", label: "Dark", Icon: Moon },
];

export default function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("system");

  useEffect(() => {
    try {
      const stored = localStorage.getItem("n200-theme");
      if (stored === "light" || stored === "dark") setMode(stored);
    } catch {
      /* private mode / blocked storage — stay on system */
    }
  }, []);

  function apply(next: Mode) {
    setMode(next);
    const root = document.documentElement;
    if (next === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next);
    try {
      if (next === "system") localStorage.removeItem("n200-theme");
      else localStorage.setItem("n200-theme", next);
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
