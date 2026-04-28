/**
 * /api/projects — list + create + get + update.
 *
 * Authenticated by accessAuthMiddleware (mounted at the parent in index.ts).
 */

import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { ulid } from 'ulid';
import { z } from 'zod';
import { getDb, schema } from '../lib/db';
import { projectDto, taskDto } from '../lib/dto';
import type { Env, Variables } from '../lib/types';

const DEFAULT_WORKFLOW_MD = `You are a coding agent implementing a task.

## Task

**{{ task.identifier }}: {{ task.title }}**

{{ task.description }}

## Your job

1. Understand the codebase. Read the README, look at the directory structure.
2. Make a plan. Use philharmonic.post_comment to share it with the team.
3. Implement the change. Follow the project's conventions.
4. Run tests. Make sure they pass before opening a PR.
5. Open a pull request via gh pr create. Title: \`{{ task.identifier }}: <summary>\`.
6. Move the task to \`review\` via philharmonic.update_status.
`;

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const CreateProject = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().regex(SLUG, 'lowercase letters, digits, hyphens only'),
  repoUrl: z.string().url(),
  defaultBranch: z.string().min(1).max(100).optional(),
  workflowMd: z.string().optional(),
  concurrencyLimit: z.number().int().min(1).max(20).optional(),
});

const UpdateProject = CreateProject.partial().omit({ slug: true });

export const projectsRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

projectsRoute.get('/projects', async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db.select().from(schema.projects).all();
  return c.json({ projects: rows.map(projectDto) });
});

projectsRoute.post('/projects', async (c) => {
  const body = CreateProject.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json({ error: { code: 'invalid_body', message: body.error.message } }, 400);
  }
  const db = getDb(c.env.DB);
  const now = new Date();
  const row: typeof schema.projects.$inferInsert = {
    id: ulid(),
    name: body.data.name,
    slug: body.data.slug,
    repoUrl: body.data.repoUrl,
    defaultBranch: body.data.defaultBranch ?? 'main',
    workflowMd: body.data.workflowMd ?? DEFAULT_WORKFLOW_MD,
    concurrencyLimit: body.data.concurrencyLimit ?? 2,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const inserted = await db.insert(schema.projects).values(row).returning();
    return c.json({ project: projectDto(inserted[0]!) }, 201);
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      return c.json(
        { error: { code: 'slug_taken', message: 'Slug is already in use.' } },
        409,
      );
    }
    throw err;
  }
});

projectsRoute.get('/projects/:id', async (c) => {
  const db = getDb(c.env.DB);
  const row = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, c.req.param('id')))
    .get();
  if (!row) return c.json({ error: { code: 'not_found', message: 'Project not found' } }, 404);
  return c.json({ project: projectDto(row) });
});

projectsRoute.patch('/projects/:id', async (c) => {
  const body = UpdateProject.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json({ error: { code: 'invalid_body', message: body.error.message } }, 400);
  }
  const db = getDb(c.env.DB);
  const id = c.req.param('id');
  const now = new Date();
  const result = await db
    .update(schema.projects)
    .set({ ...body.data, updatedAt: now })
    .where(eq(schema.projects.id, id))
    .returning();
  if (result.length === 0) {
    return c.json({ error: { code: 'not_found', message: 'Project not found' } }, 404);
  }
  return c.json({ project: projectDto(result[0]!) });
});

projectsRoute.get('/projects/:id/tasks', async (c) => {
  const db = getDb(c.env.DB);
  const projectId = c.req.param('id');
  const status = c.req.query('status');
  const rows = await db
    .select()
    .from(schema.tasks)
    .where(
      status
        ? sql`${schema.tasks.projectId} = ${projectId} AND ${schema.tasks.status} = ${status}`
        : eq(schema.tasks.projectId, projectId),
    )
    .all();
  return c.json({ tasks: rows.map(taskDto) });
});

projectsRoute.post('/projects/:id/tasks', async (c) => {
  const Body = z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(20000).optional(),
    priority: z.number().int().min(0).max(3).optional(),
  });
  const body = Body.safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return c.json({ error: { code: 'invalid_body', message: body.error.message } }, 400);
  }
  const db = getDb(c.env.DB);
  const projectId = c.req.param('id');
  const project = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .get();
  if (!project) {
    return c.json({ error: { code: 'not_found', message: 'Project not found' } }, 404);
  }

  const max = await db
    .select({ n: sql<number>`COALESCE(MAX(${schema.tasks.number}), 0)` })
    .from(schema.tasks)
    .where(eq(schema.tasks.projectId, projectId))
    .get();
  const number = (max?.n ?? 0) + 1;

  const now = new Date();
  const row: typeof schema.tasks.$inferInsert = {
    id: ulid(),
    projectId,
    number,
    title: body.data.title,
    description: body.data.description ?? '',
    status: 'backlog',
    priority: body.data.priority ?? 2,
    createdBy: c.var.user.email,
    assignee: null,
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await db.insert(schema.tasks).values(row).returning();
  return c.json({ task: taskDto(inserted[0]!) }, 201);
});
