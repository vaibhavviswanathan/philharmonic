import { useEffect, useRef, useImperativeHandle, forwardRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SandboxAddon, type ConnectionState } from "@cloudflare/sandbox/xterm";
import "@xterm/xterm/css/xterm.css";
import { getTerminalWsUrl } from "../api.js";

export interface AgentTerminalHandle {
  sendCommand: (text: string) => void;
}

export const AgentTerminal = forwardRef<
  AgentTerminalHandle,
  { taskId: string }
>(function AgentTerminal({ taskId }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const sandboxAddonRef = useRef<SandboxAddon | null>(null);
  const [connState, setConnState] = useState<ConnectionState>("disconnected");

  useImperativeHandle(ref, () => ({
    sendCommand(text: string) {
      // Write text + enter to the terminal via the WebSocket
      if (terminalRef.current) {
        // The SandboxAddon pipes terminal input to the WebSocket
        terminalRef.current.input(text + "\n", false);
      }
    },
  }));

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      theme: {
        background: "#0d1117",
        foreground: "#c9d1d9",
        cursor: "#58a6ff",
        selectionBackground: "#264f78",
      },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const sandboxAddon = new SandboxAddon({
      getWebSocketUrl: () => getTerminalWsUrl(taskId),
      reconnect: true,
      onStateChange: (state, error) => {
        setConnState(state);
        if (error) {
          console.warn("[AgentTerminal] connection error:", error.message);
        }
      },
    });
    terminal.loadAddon(sandboxAddon);

    terminal.open(containerRef.current);
    fitAddon.fit();

    // Connect to the sandbox terminal
    const sandboxId = `task-${taskId}`.toLowerCase();
    sandboxAddon.connect({ sandboxId });

    terminalRef.current = terminal;
    sandboxAddonRef.current = sandboxAddon;

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      sandboxAddon.dispose();
      terminal.dispose();
      terminalRef.current = null;
      sandboxAddonRef.current = null;
    };
  }, [taskId]);

  return (
    <div className="relative">
      {/* Connection indicator */}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5">
        <div
          className={`w-2 h-2 rounded-full ${
            connState === "connected"
              ? "bg-green-500"
              : connState === "connecting"
                ? "bg-yellow-500 animate-pulse"
                : "bg-red-500"
          }`}
        />
        <span className="text-[10px] text-gray-500">{connState}</span>
      </div>
      <div
        ref={containerRef}
        className="w-full rounded-lg overflow-hidden"
        style={{ height: "500px", background: "#0d1117" }}
      />
    </div>
  );
});
