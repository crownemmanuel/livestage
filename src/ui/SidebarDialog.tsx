import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface SidebarSection<T extends string> {
  id: T;
  label: string;
  icon: ReactNode;
  /** One line under the section's title. */
  blurb: string;
  /** Heading the section is listed under (sections without one sit at the top). */
  group?: string;
  /** A small status light next to the label. */
  status?: ReactNode;
}

/** A settings window: the sections listed on the left, the chosen one on the right (Settings, Screens). */
export function SidebarDialog<T extends string>({
  open,
  onOpenChange,
  title,
  sections,
  section,
  onSection,
  children,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  sections: SidebarSection<T>[];
  section: T;
  onSection: (s: T) => void;
  /** The chosen section's content. */
  children: ReactNode;
}) {
  const cur = sections.find((x) => x.id === section) ?? sections[0];
  const groups = [...new Set(sections.map((x) => x.group))];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(720px,88vh)] gap-0 overflow-hidden p-0 sm:max-w-[980px]">
        <nav className="flex w-[220px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-black/20 p-3">
          <DialogTitle className="px-2 pt-1 text-[15px]">{title}</DialogTitle>
          {groups.map((g) => (
            <div key={g ?? ""} className="space-y-0.5">
              {g && <div className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70">{g}</div>}
              {sections
                .filter((x) => x.group === g)
                .map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    onClick={() => onSection(x.id)}
                    className={cn(
                      "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors [&_svg]:size-4 [&_svg]:shrink-0",
                      section === x.id ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    )}
                  >
                    {x.icon}
                    <span className="min-w-0 flex-1 truncate">{x.label}</span>
                    {x.status}
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="border-b border-border px-6 pt-5 pb-4 pr-12">
            <h2 className="flex items-center gap-2.5 text-[17px] font-semibold [&_svg]:size-5 [&_svg]:text-muted-foreground">
              {cur.icon} {cur.label}
            </h2>
            <DialogDescription className="mt-1 text-[12.5px]">{cur.blurb}</DialogDescription>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
