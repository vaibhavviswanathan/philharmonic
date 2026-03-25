#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import type { DispatchPayload } from "@phil/shared";
import { runAgent } from "./agent.js";
import { gitCheckoutBranch, gitSetup } from "./tools/git.js";

// In Cloudflare Sandbox SDK, the callback URL is the Worker's public URL
const CALLBACK_URL = process.env.PHIL_CALLBACK_URL ?? "";
const TASK_ID = process.env.PHIL_TASK_ID ?? "";
const SANDBOX_ID = process.env.PHIL_SANDBOX_ID ?? "";

async function reportStatus(status: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${CALLBACK_URL}/internal/sandboxes/${TASK_ID}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sandboxId: SANDBOX_ID, ...status }),
    });
  } catch (err) {
    console.error("Failed to report status:", err);
  }
}

async function reportLog(message: string): Promise<void> {
  try {
    await fetch(`${CALLBACK_URL}/internal/sandboxes/${TASK_ID}/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sandboxId: SANDBOX_ID, message, level: "info" }),
    });
  } catch {
    // best-effort logging
  }
  console.log(message);
}

async function main(): Promise<void> {
  console.log(`Phil sandbox starting. Task: ${TASK_ID}, Sandbox: ${SANDBOX_ID}`);

  // Read dispatch payload
  let payload: DispatchPayload;
  try {
    const raw = await readFile("/workspace/.phil-dispatch.json", "utf-8");
    payload = JSON.parse(raw);
  } catch (err) {
    console.error("Failed to read dispatch payload:", err);
    await reportStatus({ status: "failed", error: "Failed to read dispatch payload" });
    process.exit(1);
  }

  await reportStatus({ status: "started" });
  await reportLog("Sandbox initialized, setting up git...");

  // Configure git
  await gitSetup("Phil Agent", "phil@agent.local");

  // Create feature branch
  try {
    await gitCheckoutBranch(payload.branchName);
    await reportLog(`Created branch: ${payload.branchName}`);
  } catch (err) {
    await reportLog(`Branch setup error (may already exist): ${err}`);
  }

  // Run the agent
  try {
    const result = await runAgent(payload, (msg) => {
      reportLog(msg);
    });

    await reportStatus({
      status: "completed",
      prUrl: result.prUrl,
    });
    await reportLog("Task completed successfully");
  } catch (err) {
    console.error("Agent execution failed:", err);
    await reportStatus({ status: "failed", error: String(err) });
    await reportLog(`Agent failed: ${err}`);
    process.exit(1);
  }
}

main();
