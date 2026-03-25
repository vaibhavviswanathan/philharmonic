import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd: cwd ?? process.cwd(),
    timeout: 30_000,
  });
  return (stdout + stderr).trim();
}

export async function gitCommit(input: {
  message: string;
  files?: string[];
}): Promise<string> {
  if (input.files && input.files.length > 0) {
    await git(["add", ...input.files]);
  } else {
    await git(["add", "-A"]);
  }
  const result = await git(["commit", "-m", input.message]);
  return result;
}

export async function gitPush(input: {
  branch: string;
}): Promise<string> {
  const result = await git(["push", "origin", input.branch]);
  return result || "Pushed successfully";
}

export async function gitCheckoutBranch(branch: string): Promise<string> {
  const result = await git(["checkout", "-b", branch]);
  return result;
}

export async function gitSetup(name: string, email: string): Promise<void> {
  await git(["config", "user.name", name]);
  await git(["config", "user.email", email]);
}
