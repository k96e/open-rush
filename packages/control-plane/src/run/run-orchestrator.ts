import type { CreateSandboxOptions, SandboxProvider } from '@open-rush/sandbox';
import type { EventStore } from '../event-store.js';
import type { LlmAccessService, LlmGrant } from '../llm/llm-access-service.js';
import type { RunUsageTotals } from '../llm/router-token-store.js';
import { AgentBridge } from './agent-bridge.js';
import type { AgentExecutor } from './agent-executor.js';
import type { CheckpointService } from './checkpoint-service.js';
import type { Run, RunService } from './run-service.js';
import {
  createErrorHandler,
  createIncrementalSave,
  createStreamLogger,
  StreamPipeline,
} from './stream-middleware.js';

/**
 * Feature flag guarding the v1 event protocol (single-writer model + the
 * `data-openrush-*` extension events).
 *
 * Default: **OFF**. Strictly accepts only the literal lowercase `"true"`
 * — any other value (including `TRUE`, `True`, `1`, non-empty arbitrary
 * strings) is treated as OFF. This matches the documented flag contract
 * in the plan and avoids accidental half-on state from 12-factor-style
 * boolean tolerance.
 *
 * When on, activates:
 *  - {@link EventStore.appendAssignSeq} (server-assigned monotonic seq)
 *  - `data-openrush-run-started` / `data-openrush-run-done` injection
 *
 * See `.claude/plans/managed-agents-p0-p1.md` §10 "发布策略": flag stays off
 * until task-19 flips it on atomically with the frontend migration, so the
 * existing production stream behaviour remains byte-for-byte identical.
 */
export function isV1EventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENRUSH_V1_EVENTS_ENABLED === 'true';
}

export interface RunOrchestratorDeps {
  runService: RunService;
  sandboxProvider: SandboxProvider;
  eventStore: EventStore;
  checkpointService?: CheckpointService;
  agentExecutor?: AgentExecutor;
  /**
   * llm-router 接入（M6·T6.2）。**可选依赖**：不装配时这条链路的一切都不发生
   * ——不签发令牌、沙箱 env 里没有 `ANTHROPIC_*`、不聚合用量、不吊销——行为与
   * 改造前完全一致。这是灰度与回滚开关，不要做成必选。
   *
   * 装配与否由 `apps/control-worker` 按 `LLM_ROUTER_BASE_URL` 是否存在决定。
   */
  llmAccess?: LlmAccessService;
  resolveProjectIdForAgent?: (agentId: string) => Promise<string | null>;
  /** Release the task's active_run_id lock after a run reaches a terminal state. */
  releaseTaskLock?: (runId: string) => Promise<void>;
}

export class RunOrchestrator {
  constructor(private deps: RunOrchestratorDeps) {}

  /**
   * Execute a run. Supports both initial runs and follow-up runs (with parentRunId).
   * Follow-up runs attempt to restore from the parent's checkpoint.
   * If the parent sandbox is gone, degrades to a fresh initial run.
   */
  async execute(runId: string, prompt: string, agentId: string): Promise<void> {
    const run = await this.deps.runService.getById(runId);
    const isFollowUp = run?.parentRunId != null;
    let sandboxId: string | null = null;
    let agentContext: Awaited<ReturnType<AgentExecutor['prepareContext']>> | null = null;
    let grant: LlmGrant | null = null;
    const v1EventsEnabled = isV1EventsEnabled();
    // Tracks whether a `data-openrush-run-started` chunk was actually
    // appended. Stays false when `emitRunStarted` no-ops (e.g. when
    // `agentDefinitionVersion` is null), which guarantees `run-done` can
    // never precede a missing `run-started`.
    let runStartedEmitted = false;
    // Tracks whether any `data-openrush-run-done` chunk has been appended.
    // Guarantees at-most-once terminal marker per run — without this, a
    // successful stream followed by a `finalize()` exception could emit
    // both `run-done(success)` and then `run-done(failed)`.
    let runDoneEmitted = false;

    try {
      // 1. queued → provisioning
      await this.deps.runService.transition(runId, 'provisioning');

      if (this.deps.agentExecutor && this.deps.resolveProjectIdForAgent) {
        const projectId = await this.deps.resolveProjectIdForAgent(agentId);
        if (!projectId) {
          throw new Error(`Project not found for agent ${agentId}`);
        }
        agentContext = await this.deps.agentExecutor.prepareContext(agentId, projectId);
      }

      // ★ 签发 run 级接入令牌 —— 必须在 sandbox 创建之前，env 才注得进去。
      if (this.deps.llmAccess && agentContext) {
        grant = await this.deps.llmAccess.issueForRun({
          runId,
          agentId,
          projectId: agentContext.projectId,
          ownerUserId: agentContext.agentConfig.createdBy ?? null,
          modelAlias: agentContext.modelAlias,
        });
      }
      // 合并顺序固定：**router 后写、优先级更高**。Vault 里若也配了
      // `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`，必须被网关的值盖掉，
      // 否则沙箱会绕过网关直连供应商（specs/llm-router.md §密钥边界）。
      // 未装配 llmAccess 且没有 agentContext 时保持 `undefined`（而不是 `{}`），
      // 与改造前逐字一致——回归用例就是对着这一点断言的。
      const sandboxEnv =
        agentContext || grant ? { ...(agentContext?.env ?? {}), ...(grant?.env ?? {}) } : undefined;
      const sandboxOptions: CreateSandboxOptions = {
        agentId,
        env: sandboxEnv,
        ttlSeconds: 3600,
      };
      const sandbox = await this.deps.sandboxProvider.create(sandboxOptions);
      sandboxId = sandbox.id;

      // 2. provisioning → preparing
      await this.deps.runService.transition(runId, 'preparing');
      await this.deps.sandboxProvider.healthCheck(sandboxId);

      // 3. Restore checkpoint for follow-up runs
      let restoredContext: string | null = null;
      if (isFollowUp && this.deps.checkpointService && run?.parentRunId) {
        restoredContext = await this.tryRestoreCheckpoint(run.parentRunId);
      }

      // 4. preparing → running
      const endpointUrl =
        this.getDevAgentWorkerUrl() ??
        (await this.deps.sandboxProvider.getEndpointUrl(sandboxId, 8787));
      if (!endpointUrl) {
        throw new Error('Sandbox endpoint URL not available');
      }

      const agentBridge = new AgentBridge({ agentWorkerUrl: endpointUrl });
      await this.deps.runService.transition(runId, 'running');

      // Inject Open-rush extension event `data-openrush-run-started` before
      // the worker stream begins. Uses the single-writer EventStore entry so
      // the extension chunk shares the per-run seq with worker-emitted chunks.
      // Behind the v1 flag to preserve pre-task-19 stream fidelity.
      if (v1EventsEnabled) {
        // `emitRunStarted` returns true only if an event was actually
        // written (it no-ops when `agentDefinitionVersion` is null).
        runStartedEmitted = await this.emitRunStarted(runId, agentId, run);
      }

      // Build prompt with restored context if available
      const fullPrompt = restoredContext
        ? `[Restored from checkpoint]\n\nPrevious context:\n${restoredContext}\n\nNew prompt:\n${prompt}`
        : prompt;

      const { response } = await agentBridge.sendPrompt(fullPrompt, {
        sessionId: runId,
        // ⚠️ `sandboxEnv` 必须**同时**走这一条（`ref/R3` §4.2.1）：dev 下的
        // `LocalDevSandboxProvider.create()` 完全忽略 options，只改上面那处的话
        // 会看到「网关根本没被调用、还在直连」。
        env: sandboxEnv,
        // ★ 修 `ref/R1` §2.6 的断链：这个参数一直存在，但从来没被传过，
        // 于是 per-agent / per-run 模型选择实际不生效。
        modelId: agentContext?.modelAlias,
        allowedTools: agentContext?.agentConfig.allowedTools,
        maxTurns: agentContext?.agentConfig.maxSteps,
        projectId: agentContext?.projectId,
        agentConfig: agentContext
          ? {
              name: agentContext.agentConfig.name,
              isBuiltin: agentContext.agentConfig.isBuiltin,
              systemPrompt: agentContext.agentConfig.systemPrompt,
              appendSystemPrompt: agentContext.agentConfig.appendSystemPrompt,
            }
          : undefined,
      });

      // 5. Consume SSE stream
      await this.consumeStream(runId, response, v1EventsEnabled);

      // 5a. 逐调用记录聚合回写 `data-openrush-usage`（D8 / A5）。
      // 放在 `run-done` **之前**：那是终态标记，停在它上面的消费者不该漏掉用量。
      // best-effort——计量缺失不得影响 run 收敛。
      if (v1EventsEnabled && this.deps.llmAccess) {
        try {
          const usage = await this.deps.llmAccess.aggregateUsage(runId);
          if (usage) await this.emitUsage(runId, usage);
        } catch (err) {
          console.error('[orchestrator] usage aggregation failed (non-fatal):', err);
        }
      }

      // 5b. Inject `data-openrush-run-done` {status: 'success'} (v1 only).
      // Gate on `runStartedEmitted` to enforce the "no done-before-started"
      // invariant on the success path too: when `data-openrush-run-started`
      // was skipped (e.g. null `agentDefinitionVersion`), skip `run-done`
      // as well so consumers never see an orphaned terminal marker.
      //
      // Set `runDoneEmitted` *after* the emitAssignSeq call succeeds so
      // that if the append itself throws, the catch branch below can
      // still attempt a `run-done(failed)` replacement — preserving the
      // at-least-one-terminal-marker guarantee.
      if (v1EventsEnabled && runStartedEmitted) {
        await this.emitRunDone(runId, 'success');
        runDoneEmitted = true;
      }

      // 6. Finalization
      await this.finalize(runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Emit a `run-done` terminal marker so SSE② consumers observe the
      // terminal state even if the later transition fails. Guard with:
      //   - `runStartedEmitted` (no done-before-started)
      //   - `!runDoneEmitted`   (at-most-once terminal marker per run)
      // Best-effort — errors here do not mask the original failure.
      if (v1EventsEnabled && runStartedEmitted && !runDoneEmitted) {
        try {
          await this.emitRunDone(runId, 'failed', message);
          runDoneEmitted = true;
        } catch (emitErr) {
          console.error('[orchestrator] Failed to emit run-done on error:', emitErr);
        }
      }
      try {
        await this.deps.runService.transition(runId, 'failed', {
          errorMessage: message,
        });
      } catch {
        // Best-effort
      }
    } finally {
      // ★ 无论成败都吊销令牌，把凭据暴露窗口压到 run 的实际时长。
      // 放在最前面：后面两步（释放任务锁、销毁沙箱）失败也不能让令牌留着。
      if (this.deps.llmAccess) {
        try {
          await this.deps.llmAccess.revokeForRun(runId);
        } catch (err) {
          console.error(`[orchestrator] token revoke failed for run ${runId}:`, err);
        }
      }
      // Release the task lock so the next run can be created
      if (this.deps.releaseTaskLock) {
        try {
          await this.deps.releaseTaskLock(runId);
        } catch (err) {
          console.error(`[orchestrator] Failed to release task lock for run ${runId}:`, err);
        }
      }
      if (sandboxId) {
        this.deps.sandboxProvider.destroy(sandboxId).catch(() => {});
      }
    }
  }

  private getDevAgentWorkerUrl(): string | null {
    const explicit = process.env.DEV_AGENT_WORKER_URL?.trim();
    if (explicit) return explicit;
    if (process.env.NODE_ENV === 'production') return null;
    return 'http://127.0.0.1:8787';
  }

  /**
   * Try to restore checkpoint from parent run.
   * Returns restored messages context as string, or null if unavailable.
   */
  private async tryRestoreCheckpoint(parentRunId: string): Promise<string | null> {
    if (!this.deps.checkpointService) return null;

    try {
      const result = await this.deps.checkpointService.restoreCheckpoint(parentRunId);
      if (!result) {
        console.log(
          `[recovery] No checkpoint found for parent run ${parentRunId}, running as initial`
        );
        return null;
      }

      const events = JSON.parse(result.messages.toString());
      // Extract text content from events for context
      const textParts: string[] = [];
      for (const event of events) {
        if (event.eventType === 'text-delta' || event.eventType === 'text_delta') {
          const content = event.payload?.content ?? event.payload?.delta ?? '';
          if (content) textParts.push(content);
        }
      }

      console.log(
        `[recovery] Restored checkpoint for parent ${parentRunId}: ${events.length} events, lastSeq=${result.checkpoint.lastEventSeq}`
      );
      return textParts.join('');
    } catch (err) {
      console.warn(
        `[recovery] Checkpoint restore failed for parent ${parentRunId}, degrading to initial:`,
        err
      );
      return null;
    }
  }

  private async finalize(runId: string): Promise<void> {
    await this.deps.runService.transition(runId, 'finalizing_prepare');

    // Create checkpoint for potential follow-up runs
    if (this.deps.checkpointService) {
      try {
        const events = await this.deps.eventStore.getEvents(runId);
        const lastSeq = await this.deps.eventStore.getLastSeq(runId);
        const snapshot = Buffer.from(JSON.stringify(events));
        await this.deps.checkpointService.createCheckpoint(runId, snapshot, lastSeq);
      } catch (err) {
        console.error('[finalize] Checkpoint creation failed (non-fatal):', err);
      }
    }

    await this.deps.runService.transition(runId, 'finalizing_uploading');
    await this.deps.runService.transition(runId, 'finalizing_verifying');
    await this.deps.runService.transition(runId, 'finalizing_metadata_commit');
    await this.deps.runService.transition(runId, 'finalized');
    await this.deps.runService.transition(runId, 'completed');
  }

  /**
   * Consume the SSE① UIMessageChunk stream from the agent-worker and
   * persist each chunk via the EventStore.
   *
   * When `v1Enabled` is true (OPENRUSH_V1_EVENTS_ENABLED): uses
   * {@link EventStore.appendAssignSeq} so seq is assigned atomically by the
   * DB (single-writer contract, see §7.3). The incoming chunk's `seq`
   * field carried through the pipeline is **advisory only** for logging;
   * the authoritative seq is in the EventStore insert result.
   *
   * When false (default): legacy behaviour — an in-process counter assigns
   * seq starting at 0 via `EventStore.append`.
   */
  private async consumeStream(runId: string, response: Response, v1Enabled = false): Promise<void> {
    const pipeline = new StreamPipeline();

    pipeline.use(
      createIncrementalSave(async (event) => {
        if (v1Enabled) {
          await this.deps.eventStore.appendAssignSeq({
            runId,
            eventType: event.type,
            payload: event.data,
          });
        } else {
          await this.deps.eventStore.append({
            runId,
            eventType: event.type,
            payload: event.data,
            seq: event.seq,
          });
        }
      }, 1)
    );

    pipeline.use(
      createErrorHandler((err, event) => {
        console.error('Stream error:', err, event);
      })
    );

    pipeline.use(
      createStreamLogger((msg, data) => {
        console.log(msg, data);
      })
    );

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let seq = 0;
    let buffer = '';

    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6);
        if (json === '[DONE]') continue;

        try {
          const data = JSON.parse(json);
          const event = {
            type: data.type,
            data,
            seq: seq++,
            timestamp: Date.now(),
          };
          await pipeline.process(event);
        } catch {
          /* skip malformed */
        }
      }
    }
  }

  /**
   * Emit `data-openrush-run-started` via the single-writer EventStore.
   *
   * Payload shape mirrors `openrushRunStartedPartSchema` in
   * `packages/contracts/src/v1/runs.ts`. `definitionVersion` is derived
   * from `runs.agent_definition_version` (task-3 column); the Zod schema
   * requires `definitionVersion ≥ 1`, so when the version is null (legacy
   * rows, or runs created before task-11 ships) we skip the injection
   * entirely rather than emit an invalid payload.
   *
   * @returns `true` if an event was actually appended, `false` if skipped.
   *          Callers use this to gate the matching `run-done` emission so
   *          consumers never see a terminal marker without a preceding
   *          `run-started`.
   */
  private async emitRunStarted(runId: string, agentId: string, run: Run | null): Promise<boolean> {
    const definitionVersion = run?.agentDefinitionVersion;
    if (definitionVersion == null) {
      return false;
    }
    await this.deps.eventStore.appendAssignSeq({
      runId,
      eventType: 'data-openrush-run-started',
      payload: {
        type: 'data-openrush-run-started',
        data: {
          runId,
          agentId,
          definitionVersion,
        },
      },
    });
    return true;
  }

  /**
   * Emit `data-openrush-usage` via the single-writer EventStore.
   * Payload shape mirrors `openrushUsagePartSchema` in
   * `packages/contracts/src/v1/runs.ts`.
   */
  private async emitUsage(runId: string, usage: RunUsageTotals): Promise<void> {
    await this.deps.eventStore.appendAssignSeq({
      runId,
      eventType: 'data-openrush-usage',
      payload: { type: 'data-openrush-usage', data: usage },
    });
  }

  /**
   * Emit `data-openrush-run-done` via the single-writer EventStore.
   * Status maps onto the run terminal state; `error` carries the failure
   * message when non-empty.
   */
  private async emitRunDone(
    runId: string,
    status: 'success' | 'failed' | 'cancelled',
    error?: string
  ): Promise<void> {
    await this.deps.eventStore.appendAssignSeq({
      runId,
      eventType: 'data-openrush-run-done',
      payload: {
        type: 'data-openrush-run-done',
        data: error ? { status, error } : { status },
      },
    });
  }
}
