import Anthropic from "@anthropic-ai/sdk";
import type { DispatchPayload, Subtask, RepoContext } from "@phil/shared";
import { SandboxManager } from "../sandbox/manager.js";
import { PLANNER_SYSTEM_PROMPT, buildPlannerUserPrompt, buildPlannerRevisionPrompt } from "./prompts.js";
import type { Env } from "../env.js";

interface PlannerOutput {
  planMarkdown: string;
  subtasks: Array<{
    id: string;
    description: string;
    dependencies: string[];
    fileTargets: string[];
  }>;
  touchSet: string[];
  branchName: string;
}

export interface PlanResult {
  payload: DispatchPayload;
  planMarkdown: string;
}

export async function planTask(
  taskId: string,
  repoUrl: string,
  description: string,
  env: Env,
): Promise<PlanResult> {
  const sandboxManager = new SandboxManager(env);

  // Use sandbox to clone and analyze repo
  const { structure, projectType, defaultBranch, claudeMd } = await sandboxManager.analyzeRepo(repoUrl, taskId);

  const repoContext: RepoContext = {
    repoUrl,
    defaultBranch,
    projectType,
    structure,
  };

  const plan = await callPlanner(env, buildPlannerUserPrompt(
    description,
    repoUrl,
    structure,
    projectType,
    claudeMd,
  ));

  const subtasks: Subtask[] = plan.subtasks.map((s) => ({
    id: s.id,
    description: s.description,
    status: "pending",
    dependencies: s.dependencies,
    fileTargets: s.fileTargets,
  }));

  const workerUrl = env.WORKER_URL ?? "";
  return {
    payload: {
      taskId,
      branchName: plan.branchName,
      repoContext,
      subtasks,
      touchSet: plan.touchSet,
      callbackUrl: `${workerUrl}/internal/sandboxes/${taskId}`,
    },
    planMarkdown: plan.planMarkdown,
  };
}

/**
 * Revise a plan based on developer feedback.
 * Reuses the existing sandbox (repo already cloned).
 */
export async function revisePlan(
  taskId: string,
  repoUrl: string,
  description: string,
  previousPlanMarkdown: string,
  feedback: string,
  env: Env,
): Promise<PlanResult> {
  const sandboxManager = new SandboxManager(env);

  // Re-analyze repo (sandbox still has it from initial planning)
  const { structure, projectType, defaultBranch, claudeMd } = await sandboxManager.analyzeRepo(repoUrl, taskId);

  const repoContext: RepoContext = {
    repoUrl,
    defaultBranch,
    projectType,
    structure,
  };

  const plan = await callPlanner(env, buildPlannerRevisionPrompt(
    description,
    repoUrl,
    structure,
    projectType,
    previousPlanMarkdown,
    feedback,
    claudeMd,
  ));

  const subtasks: Subtask[] = plan.subtasks.map((s) => ({
    id: s.id,
    description: s.description,
    status: "pending",
    dependencies: s.dependencies,
    fileTargets: s.fileTargets,
  }));

  const workerUrl = env.WORKER_URL ?? "";
  return {
    payload: {
      taskId,
      branchName: plan.branchName,
      repoContext,
      subtasks,
      touchSet: plan.touchSet,
      callbackUrl: `${workerUrl}/internal/sandboxes/${taskId}`,
    },
    planMarkdown: plan.planMarkdown,
  };
}

async function callPlanner(env: Env, userPrompt: string): Promise<PlannerOutput> {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: PLANNER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Planner returned no text response");
  }

  let plan: PlannerOutput;
  try {
    plan = JSON.parse(textBlock.text);
  } catch {
    throw new Error(`Planner returned invalid JSON: ${textBlock.text.slice(0, 200)}`);
  }

  // Ensure planMarkdown exists (backwards compat with older prompt format)
  if (!plan.planMarkdown) {
    plan.planMarkdown = plan.subtasks
      .map((s, i) => `${i + 1}. **${s.id}**: ${s.description}\n   Files: ${s.fileTargets.join(", ")}`)
      .join("\n");
  }

  return plan;
}
