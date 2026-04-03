import { type Project } from "./api.js";

export type View =
  | { type: "projects" }
  | { type: "project"; project: Project }
  | { type: "settings" };
