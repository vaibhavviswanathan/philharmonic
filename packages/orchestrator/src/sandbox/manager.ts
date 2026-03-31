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

    // Recover workspace if sandbox was recycled since planning phase
    const wsCheck = await sandbox.exec("ls /workspace/.git 2>/dev/null && echo 'ok' || echo 'empty'");
    if (wsCheck.stdout.trim() === "empty") {
      const token = this.env.GITHUB_TOKEN ?? "";
      const authedUrl = payload.repoContext.repoUrl.replace("https://", `https://x-access-token:${token}@`);
      await sandbox.exec(`git clone ${authedUrl} /workspace 2>&1`);
    }

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
    onResult?: (result: { prUrl?: string; previewUrl?: string }) => Promise<void>,
  ): Promise<{ prUrl?: string; previewUrl?: string }> {
    return runAgentLoop(sandbox, payload, this.env, onLog, onResult);
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
  ): Promise<{ structure: string[]; projectType: string; defaultBranch: string; claudeMd?: string }> {
    const sandboxId = `task-${taskId}`.toLowerCase();
    const sandbox = getSandbox(this.env.Sandbox, sandboxId, {
      keepAlive: true,
    });

    // Clone repo if not already present (reuse on revision / sandbox recycle)
    const token = this.env.GITHUB_TOKEN ?? "";
    const authedUrl = token
      ? repoUrl.replace("https://", `https://x-access-token:${token}@`)
      : repoUrl;
    const wsCheck = await sandbox.exec("ls /workspace/.git 2>/dev/null && echo 'ok' || echo 'empty'");
    if (wsCheck.stdout.trim() === "empty") {
      await sandbox.exec(`git clone --depth 1 ${authedUrl} /workspace`, {
        env: { GIT_TERMINAL_PROMPT: "0" },
      });
    } else {
      // Pull latest changes in case repo was updated
      await sandbox.exec(`git fetch origin 2>/dev/null || true`, { cwd: "/workspace" });
      await sandbox.exec(`git reset --hard origin/HEAD 2>/dev/null || true`, { cwd: "/workspace" });
    }
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

    // Read CLAUDE.md if it exists (project-level instructions)
    const claudeMdResult = await sandbox.exec(
      'cat CLAUDE.md 2>/dev/null || true',
      { cwd: "/workspace" },
    );
    const claudeMd = claudeMdResult.success && claudeMdResult.stdout.trim()
      ? claudeMdResult.stdout.trim()
      : undefined;

    return { structure, projectType, defaultBranch, claudeMd };
  }
}
