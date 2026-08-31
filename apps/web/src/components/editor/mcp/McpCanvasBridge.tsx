/**
 * Live editor bridge for MCP canvas control:
 * - heartbeat → server routes ops to live queue (full designTools parity)
 * - pending batches → applyAgentToolOps (same stagger + canvas lock as Design Agent)
 * - revision fallback reload when headless writes land
 */
import { useCallback, useEffect, useRef } from 'react';
import { useDispatch } from 'react-redux';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import { applyAgentToolOps } from '@/components/editor/panels/agent/runDesignAgent';
import { filterAllowedToolOps } from '@/components/editor/panels/agent/toolOpsContract';
import { importDocument } from '@/store/modules/editor';
import store, { type RootState } from '@/store';
import { canvasToolGateway } from '@/service/agentRuntime/CanvasToolGateway';
import {
  fetchProject,
} from '@/service/projects';
import {
  mcpCanvasAckPending,
  mcpCanvasFetchPending,
  mcpCanvasHeartbeat,
} from '@/service/mcpCanvas';

type Props = {
  projectId: string | null | undefined;
  enabled?: boolean;
  heartbeatMs?: number;
  pollMs?: number;
};

type EditorStateReader = () => Pick<RootState, 'editor'>;

/** Stable runtime accessor: every call reads the latest Redux editor state. */
export function createMcpCanvasEditorAccessor(getState: EditorStateReader) {
  return {
    getDocument: (): SceneDocument | null => getState().editor.document,
    getActiveFrameId: (): string | null =>
      (getState().editor.document?.activeFrameId as string | null | undefined) || null,
  };
}

export function McpCanvasBridge({
  projectId,
  enabled = true,
  heartbeatMs = 4000,
  pollMs = 1500,
}: Props) {
  const dispatch = useDispatch();
  const lastRev = useRef<number | null>(null);
  const applying = useRef(false);
  const editorAccessor = useRef(createMcpCanvasEditorAccessor(() => store.getState())).current;

  const reloadIfRevisionBumped = useCallback(async (pid: string) => {
    try {
      const row = await fetchProject(pid);
      const proj = row?.project;
      const rev = Number(proj?.revision);
      if (!Number.isFinite(rev)) return;
      if (lastRev.current == null) {
        lastRev.current = rev;
        return;
      }
      if (rev > lastRev.current && proj?.document) {
        lastRev.current = rev;
        dispatch(
          importDocument({
            id: pid,
            name: proj.name || 'Untitled',
            document: proj.document,
            source: 'user',
          })
        );
      }
    } catch {
      /* ignore */
    }
  }, [dispatch]);

  const applyPending = useCallback(async (pid: string) => {
    if (applying.current) return;
    if (!editorAccessor.getDocument()) return;
    applying.current = true;
    try {
      const batches = await mcpCanvasFetchPending(pid, 8);
      if (!batches.length) return;
      const ackIds: string[] = [];
      for (const batch of batches) {
        const bid = String(batch.batchId || '').trim();
        const ops = Array.isArray(batch.ops) ? batch.ops : [];
        const runId = String(batch.runId || `mcp-${pid}`);
        if (canvasToolGateway.isCancelled(runId, pid)) {
          if (bid) ackIds.push(bid);
          continue;
        }
        if (ops.length && bid) {
          let acquired = false;
          try {
            canvasToolGateway.acquire(runId, pid);
            acquired = true;
            await canvasToolGateway.apply({
              runId,
              projectId: pid,
              operationId: bid,
              ops: filterAllowedToolOps(ops),
              apply: (canonicalOps, signal) =>
                applyAgentToolOps({
                  ops: canonicalOps,
                  signal,
                  dispatch,
                  getDocument: editorAccessor.getDocument,
                  frameId: editorAccessor.getActiveFrameId(),
                  source: 'ai',
                }),
            });
          } catch {
            // Preserve this and subsequent batches; the next poll retries after the owner releases.
            break;
          } finally {
            if (acquired) canvasToolGateway.release(runId, pid);
          }
        }
        if (bid) ackIds.push(bid);
      }
      if (ackIds.length) {
        await mcpCanvasAckPending(pid, ackIds);
      }
    } finally {
      applying.current = false;
    }
  }, [dispatch, editorAccessor]);

  useEffect(() => {
    const pid = String(projectId || '').trim();
    if (!enabled || !pid) return;

    let cancelled = false;

    const heartbeat = async () => {
      try {
        await mcpCanvasHeartbeat(pid);
      } catch {
        /* MCP disabled or offline */
      }
    };

    const tick = async () => {
      if (cancelled) return;
      await heartbeat();
      await applyPending(pid);
      await reloadIfRevisionBumped(pid);
    };

    void tick();
    const hb = window.setInterval(() => void heartbeat(), heartbeatMs);
    const poll = window.setInterval(() => void tick(), pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(hb);
      window.clearInterval(poll);
    };
  }, [projectId, enabled, heartbeatMs, pollMs, applyPending, reloadIfRevisionBumped]);

  return null;
}
