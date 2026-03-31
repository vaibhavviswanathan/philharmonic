import { z } from "zod";

// --- Projects ---

export const CreateProjectSchema = z.object({
  name: z.string().min(1).max(200),
  repoUrl: z.string().url(),
});

export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  autonomyLevel: z.enum(["supervised", "moderate", "high", "full"]).optional(),
});

export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;

// --- Tasks ---

export const CreateTaskSchema = z.object({
  projectId: z.string().min(1),
  description: z.string().min(1).max(2000),
  backlog: z.boolean().optional(),
  dependsOn: z.array(z.string()).optional(),
});

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

export const TaskIdParamSchema = z.object({
  id: z.string(),
});

// --- Settings ---

export const UpdateSettingsSchema = z.object({
  anthropicApiKey: z.string().optional(),
  githubToken: z.string().optional(),
});

export type UpdateSettingsInput = z.infer<typeof UpdateSettingsSchema>;

// --- Sandbox callbacks ---

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
