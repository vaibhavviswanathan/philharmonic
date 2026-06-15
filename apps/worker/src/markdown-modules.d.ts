// Wrangler bundles .md files as text modules via the `rules` entry in
// wrangler.jsonc (type "Text", glob "**/*.md"). Mirror that for tsc so
// `import template from '../path/to/FILE.md'` typechecks as a string.
declare module '*.md' {
  const content: string;
  export default content;
}
