import { useState } from "react";
import { AlertTriangle, Check, Loader2, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { describeProbe } from "@/core/mediaCheck";
import type { Asset } from "@/core/types";
import { assetProblems, optimiseAsset, useMediaJobs } from "@/engine/media";
import { useProject } from "@/store/project";

/**
 * What the wall thinks of a video: a running probe / re-encode with its progress, a red badge when
 * the file will not play right, an amber one when it plays but costs, and an "Optimise" action when
 * a re-encode would fix it. Nothing for a file that is fine (the format sits in the tooltip).
 */
export function MediaBadge({ asset, detail = false }: { asset: Asset; detail?: boolean }) {
  const job = useMediaJobs((s) => s.jobs[asset.id]);
  const wall = useProject((s) => s.project.output);
  const [err, setErr] = useState<string | null>(null);
  if (asset.type !== "video") return null;
  const problems = assetProblems(asset, { canvasWidth: wall.canvasWidth, canvasHeight: wall.canvasHeight });
  const format = describeProbe(asset.probe);

  if (job && (job.state === "probing" || job.state === "optimising")) {
    const pct = Math.round(job.fraction * 100);
    return (
      <span className="inline-flex items-center gap-1 text-[9.5px] text-preview" title={job.state === "probing" ? "Reading the file" : `Re-encoding for the wall · ${pct}%`}>
        <Loader2 className="size-3 animate-spin" />
        {job.state === "probing" ? "reading" : `optimising ${pct}%`}
      </span>
    );
  }
  if (job?.state === "error" || err) {
    return (
      <span className="inline-flex max-w-[180px] items-center gap-1 truncate text-[9.5px] text-destructive" title={job?.error ?? err ?? ""}>
        <AlertTriangle className="size-3 shrink-0" /> optimise failed
      </span>
    );
  }
  if (job?.state === "done") {
    return (
      <span className="inline-flex items-center gap-1 text-[9.5px] text-preview" title={format}>
        <Check className="size-3" /> ready for the wall
      </span>
    );
  }
  if (!problems.length) {
    return detail && format ? <span className="truncate text-[10px] text-muted-foreground/70" title={format}>· {format}</span> : null;
  }
  const worst = problems[0];
  const fixable = problems.some((p) => p.fixable) && !!asset.path && !asset.builtIn && !asset.hasAlpha;
  const tip = [format, ...problems.map((p) => `${p.severity === "error" ? "✖" : "▲"} ${p.message}`)].filter(Boolean).join("\n");
  const run = (e: React.MouseEvent) => {
    e.stopPropagation();
    setErr(null);
    void optimiseAsset(asset.id, { force: true }).catch((x) => setErr(x instanceof Error ? x.message : String(x)));
  };
  return (
    <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <span className={cn("inline-flex items-center gap-1 text-[9.5px]", worst.severity === "error" ? "text-destructive" : "text-armed")} title={tip}>
        <AlertTriangle className="size-3" /> {worst.severity === "error" ? "won't play right" : "check"}
      </span>
      {fixable && (
        <button type="button" className="inline-flex items-center gap-0.5 rounded border border-border px-1 text-[9.5px] text-foreground hover:bg-accent" title="Re-encode into the wall format (H.264, fitted to the wall, keyframe every ½ s)" onClick={run}>
          <Wand2 className="size-3" /> Optimise
        </button>
      )}
    </span>
  );
}
