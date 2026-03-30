import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../../config.js";
import { log } from "../logger.js";
import type { BackfillStateData } from "./backfill-types.js";

const STATE_FILE_NAME = "backfill-state.json";

function getStatePath(): string {
  return join(CONFIG.storagePath, STATE_FILE_NAME);
}

function createInitialState(): BackfillStateData {
  return {
    processedSessionIds: [],
    totalSessionsProcessed: 0,
    totalMemoriesCreated: 0,
    lastRunAt: 0,
  };
}

export function loadBackfillState(): BackfillStateData {
  const path = getStatePath();
  if (!existsSync(path)) {
    return createInitialState();
  }

  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as BackfillStateData;
    return {
      processedSessionIds: data.processedSessionIds || [],
      totalSessionsProcessed: data.totalSessionsProcessed || 0,
      totalMemoriesCreated: data.totalMemoriesCreated || 0,
      lastRunAt: data.lastRunAt || 0,
    };
  } catch (error) {
    log("Failed to load backfill state, starting fresh", { error: String(error) });
    return createInitialState();
  }
}

export function saveBackfillState(state: BackfillStateData): void {
  const path = getStatePath();
  try {
    writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
  } catch (error) {
    log("Failed to save backfill state", { error: String(error) });
  }
}

export function markSessionProcessed(
  state: BackfillStateData,
  sessionId: string,
  memoriesCreated: number
): void {
  state.processedSessionIds.push(sessionId);
  state.totalSessionsProcessed += 1;
  state.totalMemoriesCreated += memoriesCreated;
  state.lastRunAt = Date.now();
  saveBackfillState(state);
}

export function isSessionProcessed(state: BackfillStateData, sessionId: string): boolean {
  return state.processedSessionIds.includes(sessionId);
}

export function clearBackfillState(): void {
  const path = getStatePath();
  try {
    writeFileSync(path, JSON.stringify(createInitialState(), null, 2), "utf-8");
    log("Backfill state cleared");
  } catch (error) {
    log("Failed to clear backfill state", { error: String(error) });
  }
}
