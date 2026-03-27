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
    <div className="p-4 bg-gray-900 rounded-lg border border-gray-800">
      <h3 className="text-sm font-semibold mb-2">Chat with Agent</h3>

      <div className="bg-black rounded p-3 max-h-64 overflow-y-auto space-y-2 mb-3">
        {messages.length === 0 && (
          <p className="text-gray-600 text-xs">
            No messages yet. Send a message to give the agent feedback or instructions.
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`text-xs rounded-md px-3 py-2 max-w-[85%] ${
              msg.sender === "user"
                ? "bg-blue-900/50 border border-blue-800 ml-auto text-right"
                : "bg-gray-800 border border-gray-700"
            }`}
          >
            <div className="flex items-center gap-1.5 mb-0.5">
              <span
                className={`font-semibold ${
                  msg.sender === "user" ? "text-blue-400" : "text-yellow-400"
                }`}
              >
                {msg.sender === "user" ? "You" : "Agent"}
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

      <form onSubmit={handleSend} className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Send feedback or instructions to the agent..."
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
