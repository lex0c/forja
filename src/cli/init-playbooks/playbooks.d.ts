// Ambient declaration so `tsc --noEmit` accepts Bun's text-import
// attribute (`import md from './x.md' with { type: 'text' }`).
// Bun handles the runtime semantics; TypeScript needs to know that
// the module exists and exposes a string default. Scoped to this
// directory's `.md` files so we do not silently broaden the
// project-wide module surface.

declare module '*.md' {
  const content: string;
  export default content;
}
