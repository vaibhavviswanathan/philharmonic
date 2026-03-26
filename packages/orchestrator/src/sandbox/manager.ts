import { getSandbox, type Sandbox as SandboxInstance } from "@cloudflare/sandbox";
import type { DispatchPayload, Sandbox } from "@phil/shared";
import type { Env } from "../env.js";
import { runAgentLoop } from "./agent.js";

export class SandboxManager {
  constructor(private env: Env) {}

  async create(payload: DispatchPayload): Promise<{ sandbox: SandboxInstance; meta: Sandbox }> {
    const sandboxId = `task-${payload.taskId}`.toLowerCase();
    const sandbox = getSandbox(this.env.Sandbox, sandboxId, {
      keepAlive: true,
    });

    // Configure git inside the sandbox
    await sandbox.exec('git config --global user.name "Phil Agent"');
    await sandbox.exec('git config --global user.email "phil@agent.local"');

    // Create feature branch (repo already cloned during planning phase)
    await sandbox.exec(`git checkout -b ${payload.branchName}`, { cwd: "/workspace" });

    const meta: Sandbox = {
      id: sandboxId,
      taskId: payload.taskId,
      containerId: sandboxId,
      state: "active",
      repoPath: "/workspace",
      branchName: payload.branchName,
      createdAt: new Date().toISOString(),
    };

    return { sandbox, meta };
  }

  /**
   * Run the agent loop from the Worker, executing tools via Sandbox SDK.
   */
  async runAgent(
    sandbox: SandboxInstance,
    payload: DispatchPayload,
    onLog: (message: string) => Promise<void>,
  ): Promise<{ prUrl?: string }> {
    return runAgentLoop(sandbox, payload, this.env, onLog);
  }

  async destroy(taskId: string): Promise<void> {
    const sandboxId = `task-${taskId}`.toLowerCase();
    const sandbox = getSandbox(this.env.Sandbox, sandboxId);
    await sandbox.destroy();
  }

  /**
   * For the planner: create a sandbox, clone and analyze a repo.
   * The same sandbox is reused for implementation (already has the repo).
   */
  async analyzeRepo(
    repoUrl: string,
    taskId: string,
  ): Promise<{ structure: string[]; projectType: string; defaultBranch: string }> {
    const sandboxId = `task-${taskId}`.toLowerCase();
    const sandbox = getSandbox(this.env.Sandbox, sandboxId, {
      keepAlive: true,
    });

    // Clone repo (embed token in URL for HTTPS auth)
    const token = this.env.GITHUB_TOKEN ?? "";
    const authedUrl = token
      ? repoUrl.replace("https://", `https://x-access-token:${token}@`)
      : repoUrl;
    await sandbox.exec(`git clone --depth 1 ${authedUrl} /workspace`, {
      env: { GIT_TERMINAL_PROMPT: "0" },
    });
    // Remove token from remote URL after clone
    if (token) {
      await sandbox.exec(`git remote set-url origin ${repoUrl}`, { cwd: "/workspace" });
    }

    // Get default branch
    let defaultBranch = "main";
    const branchResult = await sandbox.exec(
      'git symbolic-ref refs/remotes/origin/HEAD --short 2>/dev/null || echo "origin/main"',
      { cwd: "/workspace" },
    );
    if (branchResult.success) {
      defaultBranch = branchResult.stdout.trim().replace("origin/", "");
    }

    // List structure (depth 3)
    const structResult = await sandbox.exec(
      'find . -maxdepth 3 -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/__pycache__/*" | sort',
      { cwd: "/workspace" },
    );
    const structure = structResult.success
      ? structResult.stdout.trim().split("\n").filter(Boolean)
      : [];

    // Detect project type
    const detectResult = await sandbox.exec(
      'ls package.json pyproject.toml requirements.txt Cargo.toml go.mod pom.xml build.gradle 2>/dev/null || true',
      { cwd: "/workspace" },
    );
    let projectType = "unknown";
    const files = detectResult.stdout.trim();
    if (files.includes("package.json")) projectType = "node";
    else if (files.includes("pyproject.toml") || files.includes("requirements.txt")) projectType = "python";
    else if (files.includes("Cargo.toml")) projectType = "rust";
    else if (files.includes("go.mod")) projectType = "go";
    else if (files.includes("pom.xml") || files.includes("build.gradle")) projectType = "java";

    return { structure, projectType, defaultBranch };
  }
}
