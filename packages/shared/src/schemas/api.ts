import { z } from "zod";

export const CreateTaskSchema = z.object({
  repoUrl: z.string().url(),
  description: z.string().min(1).max(2000),
});

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

export const TaskIdParamSchema = z.object({
  id: z.string(),
});

export const SandboxStatusUpdateSchema = z.object({
  sandboxId: z.string(),
  status: z.enum(["started", "subtask_started", "subtask_completed", "subtask_failed", "completed", "failed"]),
  subtaskId: z.string().optional(),
  message: z.string().optional(),
  prUrl: z.string().optional(),
  prNumber: z.number().optional(),
  error: z.string().optional(),
});

export type SandboxStatusUpdate = z.infer<typeof SandboxStatusUpdateSchema>;

export const SandboxLogSchema = z.object({
  sandboxId: z.string(),
  message: z.string(),
  level: z.enum(["info", "warn", "error", "debug"]).default("info"),
});

export type SandboxLog = z.infer<typeof SandboxLogSchema>;
