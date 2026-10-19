// Agent bridge: the operator window connects to the local MCP server (mcp/server.ts) over a
// WebSocket and runs the commands it relays. The app keeps working whether or not an agent is there;
// the operator can switch agent control off from the top bar.

import { create } from "zustand";
import { isTauri } from "@/core/platform";
import { ioLog } from "@/engine/io";
import { useProject } from "@/store/project";
import { AgentImage, handlers } from "./handlers";
import { AGENT_COMMANDS, AGENT_PORT, AGENT_SPEC_VERSION, type AgentCommand, type AgentHello, type AgentRequest, type AgentResponse, type CommandSpec } from "./spec";

const ENABLED_KEY = "sls.agent";
const PORT_KEY = "sls.agentPort";
/** A second instance (e.g. a test profile) can talk to its own MCP server: VITE_SLS_AGENT_PORT=1441. */
const ENV_PORT = Number(import.meta.env.VITE_SLS_AGENT_PORT) || AGENT_PORT;

function readEnabled() {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "off";
  } catch {
    return true;
  }
}

interface AgentStore {
  enabled: boolean;
  connected: boolean;
  /** Last command that changed something (for the top-bar tooltip). */
  last: { method: string; at: number; ok: boolean } | null;
  commands: number;
  setEnabled(on: boolean): void;
}

export const useAgent = create<AgentStore>((set) => ({
  enabled: readEnabled(),
  connected: false,
  last: null,
  commands: 0,
  setEnabled(on) {
    try {
      localStorage.setItem(ENABLED_KEY, on ? "on" : "off");
    } catch {
      /* per-machine convenience only */
    }
    set({ enabled: on });
  },
}));

function port() {
  try {
    return Number(localStorage.getItem(PORT_KEY)) || ENV_PORT;
  } catch {
    return ENV_PORT;
  }
}

async function run(req: AgentRequest): Promise<AgentResponse> {
  const spec: CommandSpec | undefined = AGENT_COMMANDS[req.method as AgentCommand];
  const handler = handlers[req.method as AgentCommand];
  if (!spec || !handler) return { id: req.id, error: `Unknown command "${req.method}"; the app may be older than the MCP server (reload it)` };
  try {
    const out = await handler(req.params ?? {});
    if (!spec.readOnly) {
      useAgent.setState((s) => ({ last: { method: req.method, at: Date.now(), ok: true }, commands: s.commands + 1 }));
      ioLog("info", `Agent → ${req.method}`);
    }
    if (out instanceof AgentImage) {
      const [head, data] = out.dataUrl.split(",", 2);
      return { id: req.id, image: { data, mimeType: head.slice(5, head.indexOf(";")) }, result: out.meta };
    }
    return { id: req.id, result: out ?? null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!spec.readOnly) {
      useAgent.setState({ last: { method: req.method, at: Date.now(), ok: false } });
      ioLog("error", `Agent → ${req.method}: ${msg}`);
    }
    return { id: req.id, error: msg };
  }
}

/** Keep a connection to the MCP server while agent control is on. Returns a stop function. */
export function startAgentBridge(): () => void {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delay = 1500;
  let stopped = false;

  const schedule = () => {
    if (stopped || timer || !useAgent.getState().enabled) return;
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
    // Back off while nobody is listening, so an idle app does not keep knocking.
    delay = Math.min(delay * 1.6, 5000);
  };

  const connect = () => {
    if (stopped || ws || !useAgent.getState().enabled) return;
    let sock: WebSocket;
    try {
      sock = new WebSocket(`ws://127.0.0.1:${port()}/app`);
    } catch {
      return schedule();
    }
    ws = sock;
    sock.onopen = () => {
      delay = 1500;
      const hello: AgentHello = { hello: "app", specVersion: AGENT_SPEC_VERSION, dev: import.meta.env.DEV, tauri: isTauri, project: useProject.getState().project.name };
      sock.send(JSON.stringify(hello));
      useAgent.setState({ connected: true });
      ioLog("info", "Agent connected (MCP)");
    };
    sock.onmessage = (ev) => {
      let req: AgentRequest;
      try {
        req = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof req.id !== "number" || typeof req.method !== "string") return;
      void run(req).then((res) => {
        if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(res));
      });
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (useAgent.getState().connected) {
        useAgent.setState({ connected: false });
        ioLog("info", "Agent disconnected");
      }
      schedule();
    };
    sock.onerror = () => {
      /* onclose follows */
    };
  };

  const unsub = useAgent.subscribe((s, prev) => {
    if (s.enabled === prev.enabled) return;
    if (s.enabled) {
      delay = 1500;
      connect();
    } else {
      if (timer) clearTimeout(timer);
      timer = null;
      ws?.close();
    }
  });
  connect();

  return () => {
    stopped = true;
    unsub();
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}
