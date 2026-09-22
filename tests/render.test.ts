import { describe, expect, it } from 'vitest';
import { cellFromPoint, fitBoard } from '../src/render/common';

describe('board fit and hit-testing', () => {
  it('fits whole-pixel cells and centres the board', () => {
    expect(fitBoard(1634, 877, 58, 30)).toEqual({ cell: 28, ox: 5, oy: 18 });
    const f = fitBoard(1000, 500, 16, 12);
    expect(f.cell).toBe(41);
    expect(f.ox).toBe(Math.floor((1000 - 41 * 16) / 2));
  });

  it('maps points to cells and rejects the margins', () => {
    const f = { cell: 28, ox: 5, oy: 18 };
    expect(cellFromPoint(5 + 10 * 28 + 14, 18 + 7 * 28 + 14, f, 58, 30)).toEqual({ x: 10, y: 7 });
    expect(cellFromPoint(5, 18, f, 58, 30)).toEqual({ x: 0, y: 0 });
    expect(cellFromPoint(4, 18, f, 58, 30)).toBeNull();
    expect(cellFromPoint(5 + 58 * 28, 20, f, 58, 30)).toBeNull();
  });
});
