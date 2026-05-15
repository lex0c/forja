// Retrieval subsystem barrel (RETRIEVAL.md).

export {
  COMPRESSION_LEVELS,
  RETRIEVAL_QUERY_TYPES,
  RETRIEVAL_VIEWS,
  RETRIEVAL_WORKFLOWS,
} from './types.ts';
export type {
  Candidate,
  CompressionLevel,
  ContextSlot,
  ContextSlotEntry,
  EdgeDerivation,
  EdgeKind,
  ExpandedCandidate,
  NodeKind,
  PipelineTimings,
  RankedCandidate,
  RetrievalEdge,
  RetrievalNode,
  RetrievalQuery,
  RetrievalQueryType,
  RetrievalResult,
  RetrievalTraceRow,
  RetrievalView,
  RetrievalWorkflow,
  ScoreBreakdown,
  SkippedCandidate,
} from './types.ts';

export { runRetrieval } from './pipeline.ts';
export type { PipelineDeps, ViewSearch } from './pipeline.ts';
