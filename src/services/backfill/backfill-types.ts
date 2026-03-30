import type { ToolCallInfo } from "../auto-capture.js";

export type { ToolCallInfo };

export interface BackfillOptions {
  mode: "all" | "days" | "date-range" | "search" | "session-ids";
  from?: string;
  to?: string;
  days?: number;
  search?: string;
  sessionIds?: string[];
  maxSessions?: number;
  batchSize?: number;
}

export interface BackfillResult {
  success: boolean;
  sessionsProcessed: number;
  sessionsSkipped: number;
  memoriesCreated: number;
  profileLearningTriggered: boolean;
  errors: BackfillError[];
  duration: number;
}

export interface BackfillError {
  sessionId: string;
  sessionTitle: string;
  error: string;
}

export interface BackfillStateData {
  processedSessionIds: string[];
  totalSessionsProcessed: number;
  totalMemoriesCreated: number;
  lastRunAt: number;
}

export interface SessionInfo {
  id: string;
  title: string;
  createdAt: string;
}

export interface Interaction {
  userPrompt: string;
  textResponses: string[];
  toolCalls: ToolCallInfo[];
}

export const DEFAULT_BATCH_SIZE = 100;
