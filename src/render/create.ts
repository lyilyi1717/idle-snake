// Picks the renderer: PixiJS (WebGL) when it initialises, otherwise the
// Canvas 2D fallback. `?canvas2d` in the URL forces the fallback.

import type { BoardRenderer } from './common';
import { PixiRenderer } from './pixiRenderer';
import { Renderer } from './renderer';

export async function createRenderer(canvas: HTMLCanvasElement, host: HTMLElement): Promise<{ renderer: BoardRenderer; canvas: HTMLCanvasElement }> {
  if (!new URLSearchParams(location.search).has('canvas2d')) {
    try {
      const renderer = await PixiRenderer.create(canvas, host);
      host.classList.add('gpu');
      return { renderer, canvas };
    } catch (err) {
      console.warn('[render] WebGL unavailable, using Canvas 2D', err);
    }
  }
  // A canvas that already handed out a WebGL context can't give a 2D one.
  const fresh = canvas.cloneNode() as HTMLCanvasElement;
  canvas.replaceWith(fresh);
  return { renderer: new Renderer(fresh), canvas: fresh };
}
