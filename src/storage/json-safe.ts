// Wraps JSON.parse with a typed error so a tampered/corrupt DB row doesn't
// surface as a bare SyntaxError to the harness. Storage stores JSON as TEXT
// (no JSONB in SQLite); any schema we own can't generate invalid JSON, so
// hitting this path means external corruption.
export class StorageJsonError extends Error {
  readonly context: string;
  constructor(context: string, cause: Error) {
    super(`storage: corrupt JSON in ${context}: ${cause.message}`);
    this.name = 'StorageJsonError';
    this.context = context;
  }
}

export const parseJsonSafe = (raw: string, context: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new StorageJsonError(context, e as Error);
  }
};
