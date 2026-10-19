// One font picker for every text setting: the show's four font stacks plus every font
// installed on this computer (listed by the desktop app; Chrome can list them too, with permission).

import { useEffect, useState } from "react";
import { create } from "zustand";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { isTauri } from "@/core/platform";
import type { TextFont } from "@/core/types";
import { fontFamily } from "@/render/layers/canvasTex";

const BUILT_IN: { value: TextFont; label: string }[] = [
  { value: "serif", label: "Serif (storybook)" },
  { value: "display", label: "Display capitals" },
  { value: "sans", label: "Sans (simple white letters)" },
  { value: "mono", label: "Mono" },
];

const useFonts = create<{ list: string[] | null }>(() => ({ list: null }));
let loading = false;

async function loadFonts() {
  if (loading) return;
  loading = true;
  try {
    let names: string[] = [];
    if (isTauri) {
      const { invoke } = await import("@tauri-apps/api/core");
      names = await invoke<string[]>("system_fonts");
    } else if ("queryLocalFonts" in window) {
      const fonts = await (window as unknown as { queryLocalFonts: () => Promise<{ family: string }[]> }).queryLocalFonts();
      names = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
    }
    useFonts.setState({ list: names });
  } catch {
    useFonts.setState({ list: [] });
  }
}

/** Installed font families (empty until listed, or where the platform can't list them). */
export function useSystemFonts(): string[] {
  const list = useFonts((s) => s.list);
  useEffect(() => {
    if (list === null) void loadFonts();
  }, [list]);
  return list ?? [];
}

export function FontPicker({ value, onChange, className }: { value: TextFont; onChange: (f: TextFont) => void; className?: string }) {
  const fonts = useSystemFonts();
  const [open, setOpen] = useState(false);
  const custom = !BUILT_IN.some((b) => b.value === value);
  return (
    <Select value={value} onValueChange={(v) => onChange(v)} open={open} onOpenChange={setOpen}>
      <SelectTrigger size="sm" className={cn("h-7 w-full text-[12px]", className)} style={{ fontFamily: fontFamily(value) }}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-[50vh]">
        <SelectGroup>
          <SelectLabel className="text-[10.5px]">Show fonts</SelectLabel>
          {BUILT_IN.map((f) => (
            <SelectItem key={f.value} value={f.value} className="text-[13px]" style={{ fontFamily: fontFamily(f.value) }}>
              {f.label}
            </SelectItem>
          ))}
        </SelectGroup>
        {(fonts.length > 0 || custom) && <SelectSeparator />}
        <SelectGroup>
          <SelectLabel className="text-[10.5px]">On this computer</SelectLabel>
          {custom && !fonts.includes(value) && (
            <SelectItem value={value} className="text-[13px]" style={{ fontFamily: fontFamily(value) }}>
              {value}
            </SelectItem>
          )}
          {/* Render the long list only while open: hundreds of faces are slow to lay out. */}
          {(open ? fonts : fonts.filter((f) => f === value)).map((f) => (
            <SelectItem key={f} value={f} className="text-[13px]" style={{ fontFamily: fontFamily(f) }}>
              {f}
            </SelectItem>
          ))}
          {fonts.length === 0 && !custom && <div className="px-2 py-1.5 text-[11px] text-muted-foreground">Installed fonts are listed in the desktop app.</div>}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
