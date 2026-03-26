const colors: Record<string, string> = {
  queued: "bg-gray-600",
  planning: "bg-blue-600",
  planned: "bg-indigo-600",
  blocked: "bg-orange-600",
  running: "bg-yellow-600",
  success: "bg-green-600",
  failed: "bg-red-600",
  cancelled: "bg-gray-500",
  pending: "bg-gray-600",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? "bg-gray-600"}`}
    >
      {status}
    </span>
  );
}
