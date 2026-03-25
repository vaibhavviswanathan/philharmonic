import { readFile } from "node:fs/promises";

export async function fsRead(input: { path: string }): Promise<string> {
  const content = await readFile(input.path, "utf-8");
  return content;
}
