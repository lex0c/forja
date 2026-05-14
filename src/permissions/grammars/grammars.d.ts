// Ambient declaration so `tsc --noEmit` accepts Bun's file-import
// attribute (`import path from './x.wasm' with { type: 'file' }`).
// Bun resolves the import to a runtime path string (the on-disk
// location in dev mode, the embedded asset in compiled binaries);
// TypeScript needs to know the module exists and exposes a string
// default. Scoped to this directory so we do not silently broaden
// the project-wide module surface.

declare module '*.wasm' {
  const path: string;
  export default path;
}
