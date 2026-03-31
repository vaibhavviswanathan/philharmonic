import type { AutonomyLevel } from "./task.js";

export interface Project {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch?: string;
  autonomyLevel: AutonomyLevel;
  createdAt: string;
  updatedAt: string;
}
