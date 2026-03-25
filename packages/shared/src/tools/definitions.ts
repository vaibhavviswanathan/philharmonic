export type AgentPhase = "plan" | "implement" | "test" | "demo" | "review";

export type ToolPermission = "allowed" | "conditional" | "denied";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type AllowedToolsConfig = Record<
  AgentPhase,
  Record<string, ToolPermission>
>;

export const defaultAllowedTools: AllowedToolsConfig = {
  plan: {
    fs_read: "allowed",
    fs_write: "denied",
    shell_exec: "allowed",
    git_commit: "denied",
    git_push: "denied",
    github_pr: "denied",
    escalate: "allowed",
  },
  implement: {
    fs_read: "allowed",
    fs_write: "allowed",
    shell_exec: "allowed",
    git_commit: "allowed",
    git_push: "allowed",
    github_pr: "denied",
    escalate: "allowed",
  },
  test: {
    fs_read: "allowed",
    fs_write: "conditional",
    shell_exec: "allowed",
    git_commit: "conditional",
    git_push: "allowed",
    github_pr: "denied",
    escalate: "allowed",
  },
  demo: {
    fs_read: "allowed",
    fs_write: "denied",
    shell_exec: "allowed",
    git_commit: "denied",
    git_push: "denied",
    github_pr: "denied",
    escalate: "allowed",
  },
  review: {
    fs_read: "allowed",
    fs_write: "conditional",
    shell_exec: "conditional",
    git_commit: "conditional",
    git_push: "allowed",
    github_pr: "allowed",
    escalate: "allowed",
  },
};
