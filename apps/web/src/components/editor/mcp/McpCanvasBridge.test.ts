import { describe, expect, it } from 'vitest';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import { createMcpCanvasEditorAccessor } from './McpCanvasBridge';

describe('McpCanvasBridge editor accessor', () => {
  it('reads the latest SceneDocument and frame after the bridge was created', () => {
    const first = {
      id: 'project-1',
      activeFrameId: 'frame-old',
      deltaSetLike: {},
    } as unknown as SceneDocument;
    const latest = {
      id: 'project-1',
      activeFrameId: 'frame-latest',
      deltaSetLike: { title: { id: 'title' } },
    } as unknown as SceneDocument;

    let document = first;
    const accessor = createMcpCanvasEditorAccessor(
      () => ({ editor: { document } }) as never
    );

    document = latest;

    expect(accessor.getDocument()).toBe(latest);
    expect(accessor.getActiveFrameId()).toBe('frame-latest');
  });
});
