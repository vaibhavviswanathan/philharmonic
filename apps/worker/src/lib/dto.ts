/**
 * Mappers from DB rows → public DTOs. Keep one canonical place for the
 * transform so the wire shape can evolve independently from the DB schema.
 */

import type { Artifact, Event, Project, Run, Task } from './schema';

export function projectDto(row: Project) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    workflowMd: row.workflowMd,
    concurrencyLimit: row.concurrencyLimit,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/**
 * Task identifier derivation — SPEC §6.2: `UPPER(project.slug)-number`
 * (e.g. slug `web-app`, number 7 → `WEB-APP-7`). The single source for the
 * DTO mapper, the workflow prompt renderer, and the agent-reference parser
 * in the internal dependencies endpoint. Never hardcode a prefix.
 */
export function taskIdentifier(projectSlug: string, number: number): string {
  return `${projectSlug.toUpperCase()}-${number}`;
}

export function taskDto(row: Task, projectSlug: string) {
  return {
    id: row.id,
    projectId: row.projectId,
    number: row.number,
    identifier: taskIdentifier(projectSlug, row.number),
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    createdBy: row.createdBy,
    assignee: row.assignee,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export function runDto(row: Run) {
  return {
    id: row.id,
    taskId: row.taskId,
    workflowInstanceId: row.workflowInstanceId,
    sandboxId: row.sandboxId,
    status: row.status,
    prUrl: row.prUrl,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt?.getTime() ?? null,
    endedAt: row.endedAt?.getTime() ?? null,
    createdAt: row.createdAt.getTime(),
  };
}

export function eventDto(row: Event) {
  return {
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    type: row.type,
    author: row.author,
    payload: row.payload as Record<string, unknown>,
    createdAt: row.createdAt.getTime(),
  };
}

export function artifactDto(row: Artifact) {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind,
    r2Key: row.r2Key,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    caption: row.caption,
    createdAt: row.createdAt.getTime(),
  };
}
