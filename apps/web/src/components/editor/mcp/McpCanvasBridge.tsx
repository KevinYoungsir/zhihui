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
import { consumeMcpPendingBatches } from './mcpPendingConsumer';

type Props = {
  projectId: string | null | undefined;
  enabled?: boolean;
  heartbeatMs?: number;
  pollMs?: number;
  revisionPollMs?: number;
  /** Test/dev injection point; production defaults to the real API ACK. */
  ack?: (projectId: string, batchIds: string[]) => Promise<unknown>;
};

type EditorStateReader = () => Pick<RootState, 'editor'>;

/** Stable runtime accessor: every call reads the latest Redux editor state. */
export function createMcpCanvasEditorAccessor(getState: EditorStateReader) {
  return {
    getDocument: (): SceneDocument | null => getState().editor.document,
    getActiveFrameId: (): string | null =>
      (getState().editor.document?.activeFrameId as string | null | undefined) || null,
    getSnapshot: () => {
      const editor = getState().editor;
      const delta = editor.document?.deltaSetLike || {};
      return {
        document: editor.document,
        nodeCount: Object.keys(delta).filter((id) => id !== 'ROOT').length,
        revision: Math.max(0, Number(editor.sceneRevision) || 0),
      };
    },
  };
}

export function McpCanvasBridge({
  projectId,
  enabled = true,
  heartbeatMs = 4000,
  pollMs = 1500,
  revisionPollMs = 30000,
  ack = mcpCanvasAckPending,
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
      await consumeMcpPendingBatches({
        projectId: pid,
        batches,
        gateway: canvasToolGateway,
        filterOps: (ops) => filterAllowedToolOps(ops || []),
        getSnapshot: editorAccessor.getSnapshot,
        applyOps: (canonicalOps, signal) =>
          applyAgentToolOps({
            ops: canonicalOps,
            signal,
            dispatch,
            getDocument: editorAccessor.getDocument,
            frameId: editorAccessor.getActiveFrameId(),
            source: 'ai',
          }),
        ack,
      });
    } finally {
      applying.current = false;
    }
  }, [dispatch, editorAccessor, ack]);

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
      try {
        await applyPending(pid);
      } catch {
        /* MCP disabled, offline, or rate limited; the next poll retries. */
      }
    };

    const checkRevision = async () => {
      if (cancelled) return;
      await reloadIfRevisionBumped(pid);
    };

    void heartbeat();
    void tick();
    void checkRevision();
    const hb = window.setInterval(() => void heartbeat(), heartbeatMs);
    const poll = window.setInterval(() => void tick(), pollMs);
    const revisionPoll = window.setInterval(
      () => void checkRevision(),
      revisionPollMs
    );
    return () => {
      cancelled = true;
      window.clearInterval(hb);
      window.clearInterval(poll);
      window.clearInterval(revisionPoll);
    };
  }, [
    projectId,
    enabled,
    heartbeatMs,
    pollMs,
    revisionPollMs,
    ack,
    applyPending,
    reloadIfRevisionBumped,
  ]);

  return null;
}
