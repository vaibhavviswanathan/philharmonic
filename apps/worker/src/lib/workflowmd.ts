/**
 * Render the per-project WORKFLOW.md template. SPEC §17 references a Handlebars-
 * style template, but the only constructs the default template uses are:
 *
 *   {{ a.b.c }}                            simple property reference
 *   {{#if (gt run.attempt 1) }} ... {{/if}}  conditional retry block
 *
 * The implementation here covers exactly those two constructs. Anything more
 * exotic should be flagged as a deviation in DEVIATIONS.md.
 */

export interface WorkflowContext {
  project: {
    name: string;
    repoUrl: string;
    defaultBranch: string;
  };
  task: {
    identifier: string;
    title: string;
    description: string;
    priority: string;
    createdBy: string;
    createdAt: string;
  };
  run: {
    id: string;
    attempt: number;
  };
}

const PATH_RX = /\{\{\s*([\w.]+)\s*\}\}/g;
const IF_GT_RX =
  /\{\{#if\s+\(gt\s+([\w.]+)\s+(\d+)\s*\)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;

export function renderWorkflowMd(template: string, ctx: WorkflowContext): string {
  let out = template;

  // 1) Resolve `{{#if (gt path N) }} ... {{/if}}` — keep body if value > N, drop otherwise.
  out = out.replace(IF_GT_RX, (_match, path: string, n: string, body: string) => {
    const value = lookup(ctx as unknown as Record<string, unknown>, path);
    if (typeof value === 'number' && value > Number.parseInt(n, 10)) {
      return body;
    }
    return '';
  });

  // 2) Substitute `{{ path }}` references.
  out = out.replace(PATH_RX, (_match, path: string) => {
    const value = lookup(ctx as unknown as Record<string, unknown>, path);
    return value == null ? '' : String(value);
  });

  return out;
}

function lookup(ctx: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, key) =>
        acc != null && typeof acc === 'object'
          ? (acc as Record<string, unknown>)[key]
          : undefined,
      ctx,
    );
}
