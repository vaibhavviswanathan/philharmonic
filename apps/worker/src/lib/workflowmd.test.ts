import { describe, expect, it } from 'vitest';
import { type WorkflowContext, renderWorkflowMd } from './workflowmd';

const CTX: WorkflowContext = {
  project: { name: 'Web App', repoUrl: 'https://github.com/acme/web', defaultBranch: 'main' },
  task: {
    identifier: 'WEB-APP-7',
    title: 'Add dark mode',
    description: 'Make it dark.',
    priority: 'normal',
    createdBy: 'vai@example.com',
    createdAt: '2026-06-10T00:00:00.000Z',
  },
  run: { id: 'run_1', attempt: 1 },
};

describe('renderWorkflowMd', () => {
  it('substitutes dotted path references', () => {
    const out = renderWorkflowMd('Task {{ task.identifier }} in {{ project.name }}.', CTX);
    expect(out).toBe('Task WEB-APP-7 in Web App.');
  });

  it('tolerates uneven whitespace inside the braces', () => {
    expect(renderWorkflowMd('{{task.title}} / {{  run.id  }}', CTX)).toBe('Add dark mode / run_1');
  });

  it('renders missing/unknown paths as empty string instead of leaking the placeholder', () => {
    expect(renderWorkflowMd('[{{ task.nonexistent }}] [{{ nope.nope }}]', CTX)).toBe('[] []');
  });

  it('strips the leading frontmatter comment block', () => {
    const template =
      '---\n# Variable docs for humans\n#   {{ task.title }}\n---\n\nReal prompt for {{ task.identifier }}.';
    const out = renderWorkflowMd(template, CTX);
    expect(out).toBe('\nReal prompt for WEB-APP-7.');
    expect(out).not.toContain('Variable docs');
  });

  it('only strips frontmatter at the very start of the template', () => {
    const template = 'Intro line.\n---\nnot frontmatter\n---\n';
    expect(renderWorkflowMd(template, CTX)).toBe(template);
  });

  it('drops a (gt run.attempt 1) block on the first attempt', () => {
    const template = 'A{{#if (gt run.attempt 1) }} RETRY BLOCK{{/if}}B';
    expect(renderWorkflowMd(template, CTX)).toBe('AB');
  });

  it('keeps the (gt run.attempt 1) block on attempt 2+', () => {
    const template = 'A{{#if (gt run.attempt 1) }} attempt {{ run.attempt }}{{/if}}B';
    const out = renderWorkflowMd(template, { ...CTX, run: { id: 'run_2', attempt: 2 } });
    expect(out).toBe('A attempt 2B');
  });

  it('renders the shipped default template end-to-end without leftover constructs', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const template = fs.readFileSync(
      path.resolve(__dirname, '../../../../containers/sandbox/WORKFLOW.md'),
      'utf8',
    );
    const out = renderWorkflowMd(template, CTX);
    expect(out).not.toMatch(/\{\{/); // every construct consumed
    expect(out).not.toMatch(/^---/); // frontmatter gone
    expect(out).toContain('WEB-APP-7');
    expect(out).toContain('/workspace/repo'); // SPEC §13.2 layout
    expect(out).toContain('declare_dependency'); // SPEC §13.4 tools list
  });
});
