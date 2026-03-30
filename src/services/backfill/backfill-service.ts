import type { PluginInput } from "@opencode-ai/plugin";
import { memoryClient } from "../client.js";
import { getTags } from "../tags.js";
import { log } from "../logger.js";
import { CONFIG } from "../../config.js";
import {
  extractAIContent,
  buildMarkdownContext,
  generateSummary,
  type ToolCallInfo,
} from "../auto-capture.js";
import { loadBackfillState, markSessionProcessed, isSessionProcessed } from "./backfill-state.js";
import type { BackfillStateData } from "./backfill-types.js";
import type {
  BackfillOptions,
  BackfillResult,
  BackfillError,
  SessionInfo,
  Interaction,
} from "./backfill-types.js";
import { DEFAULT_BATCH_SIZE } from "./backfill-types.js";

export class BackfillService {
  private state: BackfillStateData;

  constructor() {
    this.state = loadBackfillState();
  }

  async runBackfill(
    ctx: PluginInput,
    directory: string,
    options: BackfillOptions
  ): Promise<BackfillResult> {
    const startTime = Date.now();
    const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;

    console.log(`\n🔄 Starting backfill...`);
    console.log(`📅 Mode: ${this.formatModeDescription(options)}`);

    const allSessions = await this.fetchSessions(ctx, options);
    console.log(`📋 Total sessions found: ${allSessions.length}`);

    const sessionsToProcess = this.filterUnprocessed(allSessions);
    console.log(
      `📋 Sessions to process (excluding ${allSessions.length - sessionsToProcess.length} already processed): ${sessionsToProcess.length}`
    );

    const batches = this.chunk(sessionsToProcess, batchSize);
    console.log(`📦 Batch size: ${batchSize}`);
    console.log(`📦 Total batches: ${batches.length}\n`);

    let totalMemoriesCreated = 0;
    let totalSessionsSkipped = 0;
    const errors: BackfillError[] = [];

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      if (!batch) continue;
      console.log(`\nBatch ${batchIndex + 1}/${batches.length}:`);

      for (let i = 0; i < batch.length; i++) {
        const session = batch[i];
        if (!session) continue;
        const result = await this.processSession(
          ctx,
          directory,
          session,
          batchIndex + 1,
          batches.length,
          i + 1,
          batch.length
        );

        totalMemoriesCreated += result.memoriesCreated;
        totalSessionsSkipped += result.skipped ? 1 : 0;

        if (result.error) {
          errors.push({
            sessionId: session.id,
            sessionTitle: session.title,
            error: result.error,
          });
        }
      }
    }

    const duration = Date.now() - startTime;

    console.log(`\n✅ Backfill complete!`);
    console.log(`   Sessions processed: ${sessionsToProcess.length}`);
    console.log(`   Memories created: ${totalMemoriesCreated}`);
    console.log(`   Sessions skipped: ${totalSessionsSkipped}`);
    if (errors.length > 0) {
      console.log(`   Errors: ${errors.length}`);
    }
    console.log(`   Duration: ${(duration / 1000).toFixed(1)}s`);

    return {
      success: true,
      sessionsProcessed: sessionsToProcess.length,
      sessionsSkipped: totalSessionsSkipped,
      memoriesCreated: totalMemoriesCreated,
      profileLearningTriggered: false,
      errors,
      duration,
    };
  }

  private formatModeDescription(options: BackfillOptions): string {
    switch (options.mode) {
      case "all":
        return "all sessions";
      case "days":
        return `last ${options.days} days`;
      case "date-range":
        return `${options.from || "start"} to ${options.to || "now"}`;
      case "search":
        return `search: "${options.search}"`;
      case "session-ids":
        return `${options.sessionIds?.length || 0} specific sessions`;
      default:
        return options.mode;
    }
  }

  private async fetchSessions(ctx: PluginInput, options: BackfillOptions): Promise<SessionInfo[]> {
    if (!ctx.client?.session) {
      throw new Error("OpenCode client session API not available");
    }

    switch (options.mode) {
      case "all": {
        const response = await ctx.client.session.list();
        const all = this.mapToSessionInfo(response.data || []);
        return options.maxSessions ? all.slice(0, options.maxSessions) : all;
      }

      case "days": {
        const response = await ctx.client.session.list();
        const all = this.mapToSessionInfo(response.data || []);
        const cutoff = Date.now() - options.days! * 24 * 60 * 60 * 1000;
        const filtered = all.filter((s) => {
          const created = new Date(s.createdAt).getTime();
          return created >= cutoff;
        });
        return options.maxSessions ? filtered.slice(0, options.maxSessions) : filtered;
      }

      case "date-range": {
        const response = await ctx.client.session.list();
        const all = this.mapToSessionInfo(response.data || []);
        const from = options.from ? new Date(options.from).getTime() : 0;
        const to = options.to ? new Date(options.to).getTime() : Date.now();
        const filtered = all.filter((s) => {
          const created = new Date(s.createdAt).getTime();
          return created >= from && created <= to;
        });
        return options.maxSessions ? filtered.slice(0, options.maxSessions) : filtered;
      }

      case "search": {
        const response = await ctx.client.session.list();
        const all = this.mapToSessionInfo(response.data || []);
        const searchTerm = options.search!.toLowerCase();
        const filtered = all.filter(
          (s) =>
            s.title.toLowerCase().includes(searchTerm) || s.id.toLowerCase().includes(searchTerm)
        );
        return options.maxSessions ? filtered.slice(0, options.maxSessions) : filtered;
      }

      case "session-ids": {
        const sessions: SessionInfo[] = [];
        for (const id of options.sessionIds || []) {
          try {
            const response = await ctx.client.session.get({ path: { id } });
            if (response.data) {
              sessions.push({
                id: response.data.id,
                title: response.data.title || response.data.id,
                createdAt:
                  (response.data as any).createdAt ||
                  (response.data as any).created_at ||
                  new Date().toISOString(),
              });
            }
          } catch {
            // Skip sessions that don't exist
          }
        }
        return sessions;
      }

      default:
        return [];
    }
  }

  private mapToSessionInfo(sessions: any[]): SessionInfo[] {
    return sessions.map((s) => ({
      id: s.id,
      title: s.title || s.name || s.id,
      createdAt: s.createdAt || s.created_at || new Date().toISOString(),
    }));
  }

  private filterUnprocessed(sessions: SessionInfo[]): SessionInfo[] {
    return sessions.filter((s) => !isSessionProcessed(this.state, s.id));
  }

  private chunk<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private async processSession(
    ctx: PluginInput,
    directory: string,
    session: SessionInfo,
    batchIndex: number,
    totalBatches: number,
    sessionIndex: number,
    batchSize: number
  ): Promise<{
    memoriesCreated: number;
    skipped: boolean;
    error?: string;
  }> {
    const prefix = `[${sessionIndex}/${batchSize}] Batch ${batchIndex}/${totalBatches}`;

    try {
      if (!ctx.client?.session) {
        return { memoriesCreated: 0, skipped: false, error: "Client not available" };
      }

      const messages = await this.fetchAllMessages(ctx, session.id);

      if (messages.length === 0) {
        console.log(`  ${prefix} "${session.title}"... ⏭️ skipped (empty)`);
        return { memoriesCreated: 0, skipped: true };
      }

      const interactions = this.groupIntoInteractions(messages);

      if (interactions.length === 0) {
        console.log(`  ${prefix} "${session.title}"... ⏭️ skipped (no interactions)`);
        return { memoriesCreated: 0, skipped: true };
      }

      let memoriesCreated = 0;

      for (const interaction of interactions) {
        const summary = await this.processInteraction(ctx, directory, session.id, interaction);

        if (summary) {
          memoriesCreated++;
        }
      }

      if (memoriesCreated > 0) {
        markSessionProcessed(this.state, session.id, memoriesCreated);
        console.log(
          `  ${prefix} "${session.title}"... ✅ ${memoriesCreated} memory${memoriesCreated > 1 ? "s" : ""}`
        );
      } else {
        console.log(`  ${prefix} "${session.title}"... ⏭️ skipped`);
      }

      return { memoriesCreated, skipped: memoriesCreated === 0 };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.log(`  ${prefix} "${session.title}"... ❌ Error: ${errorMsg}`);
      console.log(`             Continuing to next session...`);
      return { memoriesCreated: 0, skipped: false, error: errorMsg };
    }
  }

  private async fetchAllMessages(ctx: PluginInput, sessionID: string): Promise<any[]> {
    const response = await ctx.client!.session!.messages({
      path: { id: sessionID },
    });

    return response.data || [];
  }

  private groupIntoInteractions(messages: any[]): any[] {
    const interactions: Interaction[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.info?.role !== "user") continue;

      const userPrompt = this.extractUserPrompt(msg);
      if (!userPrompt) continue;

      const aiMessages: any[] = [];
      for (let j = i + 1; j < messages.length; j++) {
        if (messages[j].info?.role === "assistant") {
          aiMessages.push(messages[j]);
        } else if (messages[j].info?.role === "user") {
          break;
        }
      }

      if (aiMessages.length > 0) {
        const { textResponses, toolCalls } = extractAIContent(aiMessages);

        if (textResponses.length > 0 || toolCalls.length > 0) {
          interactions.push({
            userPrompt,
            textResponses,
            toolCalls,
          });
        }
      }
    }

    return interactions;
  }

  private extractUserPrompt(msg: any): string | null {
    if (!msg.parts || !Array.isArray(msg.parts)) return null;

    const textParts = msg.parts
      .filter((p: any) => p.type === "text" && p.text)
      .map((p: any) => p.text)
      .join("\n");

    return textParts.trim() || null;
  }

  private async processInteraction(
    ctx: PluginInput,
    directory: string,
    sessionID: string,
    interaction: Interaction
  ): Promise<string | null> {
    const context = buildMarkdownContext(
      interaction.userPrompt,
      interaction.textResponses,
      interaction.toolCalls,
      null
    );

    const summaryResult = await generateSummary(context, sessionID, interaction.userPrompt);

    if (!summaryResult || summaryResult.type === "skip") {
      return null;
    }

    const tags = getTags(directory);
    const result = await memoryClient.addMemory(summaryResult.summary, tags.project.tag, {
      source: "backfill" as any,
      type: summaryResult.type,
      tags: summaryResult.tags,
      sessionID,
      captureTimestamp: Date.now(),
      displayName: tags.project.displayName,
      userName: tags.project.userName,
      userEmail: tags.project.userEmail,
      projectPath: tags.project.projectPath,
      projectName: tags.project.projectName,
      gitRepoUrl: tags.project.gitRepoUrl,
    });

    return result.success ? summaryResult.summary : null;
  }
}

export const backfillService = new BackfillService();
