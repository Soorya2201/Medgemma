import { describe, it, expect, vi } from 'vitest';
import { listAll } from '../utils/listAll';

// Stands in for client.models.X.list(): hands out one page at a time and only
// stops offering a token when the rows run out.
const pager = (pages: string[][]) =>
  vi.fn(async (nextToken: string | undefined) => {
    const index = nextToken ? Number(nextToken) : 0;
    return {
      data: pages[index],
      nextToken: index + 1 < pages.length ? String(index + 1) : null,
    };
  });

describe('listAll', () => {
  it('returns a single page as-is', async () => {
    const fetchPage = pager([['a', 'b']]);
    await expect(listAll(fetchPage)).resolves.toEqual(['a', 'b']);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('follows nextToken until the rows are exhausted', async () => {
    const fetchPage = pager([['a'], ['b'], ['c']]);
    await expect(listAll(fetchPage)).resolves.toEqual(['a', 'b', 'c']);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage).toHaveBeenNthCalledWith(1, undefined);
    expect(fetchPage).toHaveBeenNthCalledWith(2, '1');
  });

  it('keeps paging past an empty page, which a filtered query can return', async () => {
    const fetchPage = pager([['a'], [], ['c']]);
    await expect(listAll(fetchPage)).resolves.toEqual(['a', 'c']);
  });

  it('returns nothing when there is nothing', async () => {
    await expect(listAll(pager([[]]))).resolves.toEqual([]);
  });

  it('stops rather than spinning forever on a token that never clears', async () => {
    const fetchPage = vi.fn(async () => ({ data: ['x'], nextToken: 'always' }));
    const rows = await listAll(fetchPage);
    expect(fetchPage).toHaveBeenCalledTimes(60);
    expect(rows).toHaveLength(60);
  });

  it('propagates a failed page instead of returning a partial list', async () => {
    const fetchPage = vi.fn(async (nextToken: string | undefined) => {
      if (nextToken) throw new Error('network');
      return { data: ['a'], nextToken: '1' };
    });
    await expect(listAll(fetchPage)).rejects.toThrow('network');
  });
});
