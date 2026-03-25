import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function fsWrite(input: { path: string; content: string }): Promise<string> {
  await mkdir(dirname(input.path), { recursive: true });
  await writeFile(input.path, input.content, "utf-8");
  return `Written ${input.content.length} bytes to ${input.path}`;
}
