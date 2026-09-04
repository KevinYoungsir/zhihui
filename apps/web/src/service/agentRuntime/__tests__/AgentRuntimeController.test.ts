import { describe, expect, it } from 'vitest';
import {
  isSuccessfulCliCanvasMutation,
  runtimeEventToAgentStep,
} from '../AgentRuntimeController';
import type { AgentRunEvent } from '../types';

const base = {
  runId: 'run-1',
  projectId: 'project-1',
  runtime: 'cli' as const,
  timestamp: 1,
};

describe('AgentRuntimeController CLI event mapping', () => {
  it('does not report a read-only CLI run as a painted canvas', () => {
    const done: AgentRunEvent = { ...base, type: 'run.completed' };
    expect(runtimeEventToAgentStep(done, false)).toEqual({
      type: 'done',
      summary: '',
      painted: false,
    });
  });

  it('reports a canvas write only after a successful mutating tool result', () => {
    const read: AgentRunEvent = {
      ...base,
      type: 'tool.result',
      tool: 'get_scene_summary',
      ok: true,
    };
    const write: AgentRunEvent = {
      ...base,
      type: 'tool.result',
      tool: 'create_text',
      ok: true,
    };
    const failedWrite: AgentRunEvent = { ...write, ok: false };
    expect(isSuccessfulCliCanvasMutation(read)).toBe(false);
    expect(isSuccessfulCliCanvasMutation(failedWrite)).toBe(false);
    expect(isSuccessfulCliCanvasMutation(write)).toBe(true);
    expect(runtimeEventToAgentStep({ ...base, type: 'run.completed' }, true)).toMatchObject({
      type: 'done',
      painted: true,
    });
  });
});
