// Amplify's `list()` returns one page (100 rows by default) plus a nextToken.
// Reading only that page silently drops history the moment an account passes a
// hundred rows — the home dashboard undercounts, insights correlate against a
// truncated log, and the clinician export prints a record with entries missing
// from it. Every aggregate read goes through here instead.

interface ListPage<T> {
  data: T[];
  nextToken?: string | null;
}

// A backend that kept handing back a token would otherwise spin forever. 60
// pages is ~6000 rows, far past any real account, and stopping there degrades
// to today's behaviour rather than hanging the screen.
const MAX_PAGES = 60;

export async function listAll<T>(
  fetchPage: (nextToken: string | undefined) => Promise<ListPage<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  let nextToken: string | undefined;
  let pages = 0;

  do {
    const page = await fetchPage(nextToken);
    if (page.data) rows.push(...page.data);
    nextToken = page.nextToken ?? undefined;
    pages++;
  } while (nextToken && pages < MAX_PAGES);

  return rows;
}
