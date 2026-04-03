import { useEffect, useState, useRef } from "react";
import {
  getMessages,
  sendMessage,
  subscribeToEvents,
  type Message,
  type PhilEvent,
} from "../api.js";

export function ChatPanel({ taskId }: { taskId: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getMessages(taskId).then(setMessages).catch(console.error);
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
    <div className="notion-panel p-5">
      <h3 className="text-xs font-semibold text-[#555] uppercase tracking-widest mb-4">Chat with Agent</h3>

      <div className="bg-[#111] rounded-md p-3 max-h-64 overflow-y-auto space-y-2 mb-4">
        {messages.length === 0 && (
          <p className="text-[#444] text-xs">
            No messages yet. Send feedback or instructions to the agent.
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`text-xs rounded-lg px-3 py-2 max-w-[85%] ${
              msg.sender === "user"
                ? "bg-blue-600/20 border border-blue-500/20 ml-auto"
                : "bg-[#2d2d2d] border border-[#3d3d3d]"
            }`}
          >
            <div className="flex items-center gap-2 mb-1">
              <span
                className={`font-semibold text-[10px] uppercase tracking-wide ${
                  msg.sender === "user" ? "text-blue-400" : "text-yellow-400"
                }`}
              >
                {msg.sender === "user" ? "You" : "Agent"}
              </span>
              <span className="text-[#555] text-[10px]">
                {new Date(msg.createdAt).toLocaleTimeString()}
              </span>
            </div>
            <p className="text-[#e5e5e5] whitespace-pre-wrap leading-relaxed">{msg.message}</p>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSend} className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Send feedback or instructions..."
          className="flex-1 bg-[#2d2d2d] border border-[#3d3d3d] rounded-md px-3 py-2 text-sm text-[#e5e5e5] placeholder-[#555] focus:outline-none focus:border-[#555] transition-colors"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="notion-btn-primary"
        >
          Send
        </button>
      </form>
    </div>
  );
}
