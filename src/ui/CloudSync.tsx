import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, CloudDownload, CloudUpload, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CloudAheadError, listCloudShows, loadCloudSettings, parseFirebaseConfig, saveCloudSettings, signIn, type CloudLatest, type CloudSettings } from "@/core/cloud";
import { isTauri } from "@/core/platform";
import { cloudOpen, cloudPush, isLive } from "@/engine/showTransfer";
import { useProject } from "@/store/project";
import { PackageProgress, showIncoming } from "./ShowPackage";

type Note = { tone: "ok" | "warn" | "error"; text: string } | null;

/** More → Cloud sync: the Firebase keys (kept on this computer), sign-in, push and sync. Off until keys are entered. */
export function CloudSyncDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [settings, setSettings] = useState<CloudSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [config, setConfig] = useState("");
  const [emulator, setEmulator] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [cloud, setCloud] = useState<CloudLatest[] | null>(null);
  const [ahead, setAhead] = useState(false);
  const [allowLive, setAllowLive] = useState(false);
  const lineage = useProject((s) => s.project.lineage);
  const live = isLive();

  const refresh = async (s: CloudSettings | null = settings) => {
    if (!s?.refreshToken) return setCloud(null);
    try {
      setCloud(await listCloudShows(s));
    } catch (e) {
      setNote({ tone: "error", text: String(e) });
    }
  };

  useEffect(() => {
    if (!open) return;
    setNote(null);
    setAhead(false);
    setAllowLive(false);
    void loadCloudSettings().then((s) => {
      setSettings(s);
      setEmail(s?.email ?? "");
      setLoaded(true);
      void refresh(s);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const parsed = parseFirebaseConfig(config);
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof CloudAheadError) setAhead(true);
      setNote({ tone: e instanceof CloudAheadError ? "warn" : "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const mine = cloud?.find((c) => c.showId === lineage?.showId) ?? (cloud?.length === 1 ? cloud[0] : undefined);

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Cloud sync</DialogTitle>
          <DialogDescription>
            Send the show and its media to your Firebase project from the build computer, and sync it on the show computer. Nothing is sent or taken in until you press a button here. The keys stay on this
            computer.
          </DialogDescription>
        </DialogHeader>

        {!isTauri ? (
          <p className="text-[12px] text-muted-foreground">Cloud sync runs in the desktop app.</p>
        ) : !loaded ? null : !settings ? (
          <div className="space-y-2 text-[12px]">
            <p>
              Paste the web app config from the Firebase console (Project settings → General → Your apps). Only the API key, project id and storage bucket are kept, in this computer's app data folder.
            </p>
            <textarea
              className="h-32 w-full rounded-md border border-input bg-transparent p-2 font-mono text-[11px]"
              placeholder={'const firebaseConfig = {\n  apiKey: "…",\n  projectId: "…",\n  storageBucket: "…",\n  …\n};'}
              value={config}
              onChange={(e) => setConfig(e.target.value)}
              spellCheck={false}
            />
            <div className="text-muted-foreground">{parsed ? `Project ${parsed.projectId}, bucket ${parsed.storageBucket}` : config ? "No apiKey / projectId found yet." : ""}</div>
            {import.meta.env.DEV && (
              <label className="flex items-center gap-2 text-muted-foreground">
                <input type="checkbox" checked={emulator} onChange={(e) => setEmulator(e.target.checked)} /> Use the local Firebase emulators (development)
              </label>
            )}
            <DialogFooter>
              <Button
                disabled={!parsed}
                onClick={() =>
                  void run("save", async () => {
                    const s: CloudSettings = { ...parsed!, ...(emulator ? { emulator: "127.0.0.1" } : {}) };
                    await saveCloudSettings(s);
                    setSettings(s);
                    setConfig("");
                  })
                }
              >
                Save keys
              </Button>
            </DialogFooter>
          </div>
        ) : !settings.refreshToken ? (
          <div className="space-y-2 text-[12px]">
            <p>
              Project <b>{settings.projectId}</b>
              {settings.emulator ? " (local emulator)" : ""}. Sign in with the show's Firebase account (Authentication → Users). The password is not stored.
            </p>
            <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
            <Input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            <DialogFooter className="sm:justify-between">
              <Button variant="ghost" onClick={() => void run("forget", async () => (await saveCloudSettings(null), setSettings(null)))}>
                Forget keys
              </Button>
              <Button
                disabled={!email || !password || !!busy}
                onClick={() =>
                  void run("signin", async () => {
                    const s = await signIn(settings, email.trim(), password);
                    await saveCloudSettings(s);
                    setPassword("");
                    setSettings(s);
                    await refresh(s);
                  })
                }
              >
                {busy === "signin" && <Loader2 className="animate-spin" />} Sign in
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3 text-[12px]">
            <p className="text-muted-foreground">
              Signed in as <b className="text-foreground">{settings.email}</b> · project {settings.projectId}
              {settings.emulator ? " (local emulator)" : ""}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-md border p-2">
                <div className="font-semibold">This computer</div>
                <div className="text-muted-foreground">
                  {lineage?.sent ? `Sent v${lineage.sent}` : "Never sent"}
                  {lineage?.received ? ` · took in v${lineage.received.version} (${lineage.received.via})` : ""}
                </div>
              </div>
              <div className="rounded-md border p-2">
                <div className="flex items-center justify-between font-semibold">
                  Cloud
                  <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => void refresh()} title="Refresh">
                    <RefreshCw className="size-3.5" />
                  </button>
                </div>
                <div className="text-muted-foreground">
                  {cloud === null ? "…" : mine ? `v${mine.version} from a ${mine.from}, ${new Date(mine.createdAt).toLocaleString()}` : cloud.length ? `${cloud.length} other show(s)` : "Empty"}
                </div>
              </div>
            </div>

            {busy && (busy === "push" || busy === "pull") && <PackageProgress />}
            {live && (
              <label className="flex items-start gap-2 rounded-md border border-live/50 bg-live/10 p-2">
                <input type="checkbox" className="mt-0.5" checked={allowLive} onChange={(e) => setAllowLive(e.target.checked)} />
                <span>A scene is live on the wall. Sync or push anyway.</span>
              </label>
            )}
            {note && (
              <p className={note.tone === "ok" ? "flex gap-2 text-preview" : note.tone === "warn" ? "flex gap-2 text-armed" : "flex gap-2 text-destructive"}>
                {note.tone === "ok" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />} {note.text}
              </p>
            )}

            <DialogFooter className="sm:justify-between">
              <Button variant="ghost" disabled={!!busy} onClick={() => void run("signout", async () => {
                const s = { ...settings, refreshToken: undefined };
                await saveCloudSettings(s);
                setSettings(s);
                setCloud(null);
              })}>
                Sign out
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={!!busy || (live && !allowLive)}
                  onClick={() =>
                    void run("push", async () => {
                      const r = await cloudPush({ allowLive, force: ahead });
                      setAhead(false);
                      setNote({ tone: "ok", text: `Pushed v${r.version}: ${r.uploaded} media file(s) uploaded (${r.megabytesUploaded} MB), ${r.alreadyInCloud} already in the cloud.${r.missing.length ? ` Not found here: ${r.missing.join(", ")}` : ""}` });
                      await refresh();
                    })
                  }
                >
                  {busy === "push" ? <Loader2 className="animate-spin" /> : <CloudUpload />} {ahead ? "Push anyway" : "Push this version"}
                </Button>
                <Button
                  disabled={!!busy || !cloud?.length || (live && !allowLive)}
                  onClick={() =>
                    void run("pull", async () => {
                      const { pkg } = await cloudOpen(mine?.showId);
                      onOpenChange(false);
                      showIncoming(pkg);
                    })
                  }
                >
                  {busy === "pull" ? <Loader2 className="animate-spin" /> : <CloudDownload />} Sync from cloud…
                </Button>
              </div>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
