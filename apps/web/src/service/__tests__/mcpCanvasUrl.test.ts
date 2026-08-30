import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/token', () => ({ getToken: () => '' }));

describe('MCP Canvas API routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the FastAPI /api/v1/mcp/canvas prefix for every request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ batches: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { mcpCanvasFetchPending, mcpCanvasHeartbeat } = await import('../mcpCanvas');
    await mcpCanvasHeartbeat('project-1');
    await mcpCanvasFetchPending('project-1');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/mcp/canvas/session/heartbeat',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/mcp/canvas/pending?project_id=project-1&limit=8',
      expect.any(Object)
    );
  });
});
