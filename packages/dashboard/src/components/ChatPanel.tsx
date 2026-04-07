import { useEffect, useState, useRef } from "react";
import {
  getMessages,
  sendMessage,
  subscribeToEvents,
  type Message,
  type PhilEvent,
} from "../api.js";

const PHASE_LABELS: Record<string, string> = {
  booting: "Booting...",
  planning: "Planning",
  awaiting_approval: "Waiting for approval",
  executing: "Executing",
  pr_created: "PR created",
  awaiting_review: "Waiting for review",
  fixing: "Fixing reviews",
  done: "Done",
  error: "Error",
};

export function ChatPanel({ taskId }: { taskId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [managerPhase, setManagerPhase] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getMessages(taskId).then(setMessages).catch(console.error);
    // Fetch initial manager status
    fetch(`${import.meta.env.VITE_API_URL ?? "/v1"}/tasks/${taskId}/manager-status`)
      .then((r) => r.json())
      .then((data: { phase?: string }) => {
        if (data.phase) setManagerPhase(data.phase);
      })
      .catch(() => {});
  }, [taskId]);

  useEffect(() => {
    const unsub = subscribeToEvents((event: PhilEvent) => {
      if (event.taskId !== taskId) return;
      if (event.type === "escalation" || event.type === "escalation_response") {
        const msg: Message = {
          sender: event.data.from as string,
          message: event.data.message as string,
          createdAt: event.timestamp,
        };
        setMessages((prev) => [...prev, msg]);
      }
      if (event.type === "manager_phase_changed") {
        setManagerPhase(event.data.phase as string);
      }
      if (event.type === "manager_thinking") {
        // Show manager thinking as a transient agent message
        const msg: Message = {
          sender: "manager",
          message: event.data.message as string,
          createdAt: event.timestamp,
        };
        setMessages((prev) => [...prev, msg]);
      }
    });
    return unsub;
  }, [taskId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    setSending(true);
    try {
      await sendMessage(taskId, input.trim());
      setInput("");
    } catch (err) {
      console.error(err);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Manager phase header */}
      {managerPhase && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800 text-xs">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              managerPhase === "done"
                ? "bg-green-400"
                : managerPhase === "error"
                  ? "bg-red-400"
                  : managerPhase === "awaiting_approval" || managerPhase === "awaiting_review"
                    ? "bg-yellow-400 animate-pulse"
                    : "bg-blue-400 animate-pulse"
            }`}
          />
          <span className="text-gray-400">
            Manager: {PHASE_LABELS[managerPhase] ?? managerPhase}
          </span>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
        {messages.length === 0 && (
          <p className="text-gray-600 text-xs">
            The manager agent will communicate here. You can also send messages.
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`text-xs rounded-md px-3 py-2 max-w-[90%] ${
              msg.sender === "user"
                ? "bg-blue-900/50 border border-blue-800 ml-auto text-right"
                : msg.sender === "manager"
                  ? "bg-gray-800/50 border border-gray-700 text-gray-500 italic"
                  : "bg-gray-800 border border-gray-700"
            }`}
          >
            <div className="flex items-center gap-1.5 mb-0.5">
              <span
                className={`font-semibold ${
                  msg.sender === "user"
                    ? "text-blue-400"
                    : msg.sender === "manager"
                      ? "text-gray-500"
                      : "text-yellow-400"
                }`}
              >
                {msg.sender === "user" ? "You" : msg.sender === "manager" ? "Manager" : "Agent"}
              </span>
              <span className="text-gray-500 text-[10px]">
                {new Date(msg.createdAt).toLocaleTimeString()}
              </span>
            </div>
            <p className="text-gray-300 whitespace-pre-wrap">{msg.message}</p>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSend} className="flex gap-2 p-3 border-t border-gray-800">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message the manager agent..."
          className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm focus:outline-none focus:border-blue-500"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium"
        >
          Send
        </button>
      </form>
    </div>
  );
}
