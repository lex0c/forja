export const migration027SubagentRunsOutputSchema = {
  id: 27,
  name: '027-subagent-runs-output-schema',
  // Per-playbook output_schema (`PLAYBOOKS.md` §1.2). The loader
  // captures the YAML mapping verbatim into the typed
  // `outputSchema?: Record<string, unknown>` field (slice 1);
  // `runSubagent` snapshots the same mapping into this column at
  // spawn so the subprocess child:
  //
  //   1. Renders it into the system prompt (a "## Output schema"
  //      block telling the model to terminate with matching YAML).
  //   2. Validates the terminal assistant text against it
  //      post-hoc — a mismatch buys one retry pass; a second
  //      mismatch publishes the run with reason
  //      `playbook.output_invalid`.
  //
  // Same drift-prevention story as the other snapshots
  // (policy/hooks/tool_restrictions/sampling/references): the
  // parent committed the schema at spawn, the child runs against
  // exactly that contract.
  //
  // Storage as TEXT (JSON-serialized object). NULL = no
  // snapshot taken (legacy row, definition without
  // output_schema) → child runs with no schema enforcement,
  // preserving the legacy free-form output behavior.
  // Non-empty object = the validation contract.
  sql: `
    ALTER TABLE subagent_runs
      ADD COLUMN output_schema TEXT;
  `,
} as const;
