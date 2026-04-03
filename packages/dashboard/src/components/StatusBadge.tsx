const statusConfig: Record<string, { dot: string; text: string; label: string }> = {
  backlog:   { dot: "bg-[#666]",      text: "text-[#888]",      label: "Backlog"   },
  queued:    { dot: "bg-[#777]",      text: "text-[#999]",      label: "Queued"    },
  planning:  { dot: "bg-blue-500",    text: "text-blue-400",    label: "Planning"  },
  planned:   { dot: "bg-indigo-500",  text: "text-indigo-400",  label: "Planned"   },
  blocked:   { dot: "bg-orange-500",  text: "text-orange-400",  label: "Blocked"   },
  running:   { dot: "bg-yellow-500",  text: "text-yellow-400",  label: "Running"   },
  reviewing: { dot: "bg-purple-500",  text: "text-purple-400",  label: "Reviewing" },
  fixing:    { dot: "bg-purple-400",  text: "text-purple-300",  label: "Fixing"    },
  success:   { dot: "bg-green-500",   text: "text-green-400",   label: "Done"      },
  failed:    { dot: "bg-red-500",     text: "text-red-400",     label: "Failed"    },
  cancelled: { dot: "bg-[#555]",      text: "text-[#666]",      label: "Cancelled" },
  closed:    { dot: "bg-[#555]",      text: "text-[#666]",      label: "Closed"    },
  pending:   { dot: "bg-[#666]",      text: "text-[#888]",      label: "Pending"   },
};

export function StatusBadge({ status }: { status: string }) {
  const cfg = statusConfig[status] ?? { dot: "bg-[#666]", text: "text-[#888]", label: status };
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${cfg.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}
