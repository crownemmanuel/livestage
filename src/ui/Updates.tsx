import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isTauri } from "@/core/platform";
import { checkForUpdate, installBlocker, installUpdate, useUpdater } from "@/engine/updater";
import { useShow } from "@/store/show";

const mb = (n: number) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0);

/** More → Check for updates: what version this is, whether a newer one is on GitHub, and Install and restart. */
export function UpdateDialog() {
  const { dialogOpen, phase, current, available, checkedAt, progress, error } = useUpdater();
  // Re-render when the wall goes live or back to standby: installing depends on it.
  useShow((s) => !!s.program.runtime && !s.program.standby);
  const blocker = installBlocker();
  const busy = phase === "checking" || phase === "downloading" || phase === "installing";
  const canInstall = !!available && !blocker && !busy;
  const close = (o: boolean) => phase !== "installing" && useUpdater.setState({ dialogOpen: o });

  return (
    <Dialog open={dialogOpen} onOpenChange={close}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>App updates</DialogTitle>
          <DialogDescription>
            New versions come from the project's GitHub releases. Nothing is downloaded or installed until you press Install, and never while a scene is live on the wall.
          </DialogDescription>
        </DialogHeader>

        {!isTauri ? (
          <p className="text-[12px] text-muted-foreground">Updates are for the desktop app.</p>
        ) : (
          <div className="space-y-3 text-[12px]">
            <p className="text-muted-foreground">
              This computer runs <b className="text-foreground">{current ? `version ${current}` : "…"}</b>
              {import.meta.env.DEV ? " (development build)" : ""}
              {checkedAt && phase !== "checking" ? ` · checked ${new Date(checkedAt).toLocaleTimeString()}` : ""}
            </p>

            {phase === "checking" && (
              <p className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Looking for a newer version…
              </p>
            )}
            {phase === "current" && (
              <p className="flex items-center gap-2 text-preview">
                <CheckCircle2 className="size-4" /> This is the latest version.
              </p>
            )}
            {available && phase !== "current" && phase !== "checking" && (
              <div className="space-y-2 rounded-md border border-preview/50 p-2.5">
                <div className="font-semibold">
                  Version {available.version} is available{available.date ? `, released ${new Date(available.date).toLocaleDateString()}` : ""}.
                  {phase === "ready" && <span className="font-normal text-muted-foreground"> Downloaded, ready to install.</span>}
                </div>
                {available.notes && <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-muted-foreground">{available.notes}</div>}
              </div>
            )}

            {phase === "downloading" && progress && (
              <div className="space-y-1">
                <div className="h-1.5 overflow-hidden rounded bg-well">
                  <div className="h-full bg-preview transition-[width]" style={{ width: progress.total ? `${(100 * progress.done) / progress.total}%` : "5%" }} />
                </div>
                <div className="text-[11px] text-muted-foreground tabular">
                  Downloading {mb(progress.done)}
                  {progress.total ? ` / ${mb(progress.total)}` : ""} MB. You can close this window; the app does not restart until you press Install again.
                </div>
              </div>
            )}
            {phase === "installing" && (
              <p className="flex items-center gap-2 text-armed">
                <Loader2 className="size-4 animate-spin" /> Installing. The app closes and opens the new version by itself.
              </p>
            )}

            {available && !busy && (
              <p className={blocker ? "flex gap-2 rounded-md border border-live/50 bg-live/10 p-2" : "flex gap-2 text-muted-foreground"}>
                <AlertTriangle className={blocker ? "mt-0.5 size-4 shrink-0 text-live" : "mt-0.5 size-4 shrink-0 text-armed"} />
                {blocker ??
                  "Installing closes the app and opens the new version (on Windows an installer window shows its progress). The audience output window closes with it: open it again with Output afterwards. The show file and media stay as they are."}
              </p>
            )}
            {phase === "error" && error && (
              <p className="flex gap-2 text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}
              </p>
            )}

            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={() => void checkForUpdate().catch(() => {})}>
                <RefreshCw /> Check again
              </Button>
              {available && (
                <Button
                  disabled={!canInstall}
                  onClick={() => void installUpdate({ version: available.version, stillWanted: () => useUpdater.getState().dialogOpen }).catch(() => {})}
                >
                  {phase === "downloading" || phase === "installing" ? <Loader2 className="animate-spin" /> : <Download />} Install {available.version} and restart
                </Button>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
