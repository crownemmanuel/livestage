import { useEffect, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { AssetType, Vec3 } from "@/core/types";
import { useProject } from "@/store/project";

export function Field({ label, children, className, hint }: { label: string; children: ReactNode; className?: string; hint?: string }) {
  return (
    <label className={cn("grid grid-cols-[96px_1fr] items-center gap-2 text-[12px]", className)} title={hint}>
      <span className="truncate text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </label>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="border-b border-border px-3 py-2.5">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</h3>
        {right}
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

/** Number input that only commits valid numbers (blur/enter), so typing "-" or "1." is safe. */
export function NumberInput({ value, onChange, step = 0.1, min, max, className }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; className?: string }) {
  const [text, setText] = useState(String(round(value)));
  useEffect(() => setText(String(round(value))), [value]);
  const commit = () => {
    let v = parseFloat(text);
    if (!Number.isFinite(v)) return setText(String(round(value)));
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    onChange(v);
  };
  return (
    <Input
      className={cn("h-7 px-2 text-[12px] tabular", className)}
      type="number"
      step={step}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

function round(v: number) {
  return Math.round(v * 1000) / 1000;
}

export function NumberField({ label, ...p }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number }) {
  return (
    <Field label={label}>
      <NumberInput {...p} />
    </Field>
  );
}

export function SliderField({ label, value, onChange, min, max, step, unit }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step: number; unit?: string }) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <Slider className="flex-1" value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0])} />
        <span className="w-12 text-right text-[11px] tabular text-muted-foreground">
          {round(value)}
          {unit ? ` ${unit}` : ""}
        </span>
      </div>
    </Field>
  );
}

export function TextField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <Field label={label}>
      <Input className="h-7 px-2 text-[12px]" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onChange(text)} onKeyDown={(e) => e.key === "Enter" && onChange(text)} />
    </Field>
  );
}

export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input type="color" className="h-7 w-10 cursor-pointer rounded border border-input bg-transparent" value={value} onChange={(e) => onChange(e.target.value)} />
        <span className="font-mono text-[11px] text-muted-foreground">{value}</span>
      </div>
    </Field>
  );
}

export function SwitchField({ label, value, onChange, hint }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <Switch checked={value} onCheckedChange={onChange} />
    </Field>
  );
}

export function SelectField<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <Field label={label}>
      <SelectBox value={value} onChange={onChange} options={options} />
    </Field>
  );
}

export function SelectBox<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger size="sm" className={cn("h-7 w-full text-[12px]", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-[12px]">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function Vec3Field({ label, value, onChange, step = 0.1 }: { label: string; value: Vec3; onChange: (v: Vec3) => void; step?: number }) {
  return (
    <Field label={label}>
      <div className="grid grid-cols-3 gap-1">
        {[0, 1, 2].map((i) => (
          <NumberInput
            key={i}
            step={step}
            value={value[i]}
            onChange={(v) => {
              const n = [...value] as Vec3;
              n[i] = v;
              onChange(n);
            }}
          />
        ))}
      </div>
    </Field>
  );
}

const NONE = "__none__";

export function AssetField({ label, type, value, onChange }: { label: string; type: AssetType | AssetType[]; value: string | null; onChange: (id: string | null) => void }) {
  const types = Array.isArray(type) ? type : [type];
  const assets = useProject((s) => s.project.assets).filter((a) => types.includes(a.type));
  const options = [{ value: NONE, label: "— none —" }, ...assets.map((a) => ({ value: a.id, label: a.name + (a.ephemeral ? " (session only)" : "") }))];
  return (
    <Field label={label}>
      <SelectBox value={value && assets.some((a) => a.id === value) ? value : NONE} onChange={(v) => onChange(v === NONE ? null : v)} options={options} />
    </Field>
  );
}
