/** Region (province/metro) display order for grouping cities in the UI. */
export const REGION_ORDER: readonly string[] = [
  'seoul',
  'incheon',
  'gyeonggi',
  'busan',
  'ulsan',
  'gyeongnam',
  'daegu',
  'gyeongbuk',
  'daejeon',
  'chungnam',
  'chungbuk',
  'gwangju',
  'jeonbuk',
  'gangwon',
  'jeju',
];

/** Group items by region_slug, ordered by REGION_ORDER (unknown regions last). */
export function groupByRegion<T extends { region_slug: string | null }>(
  items: T[],
): Array<{ region: string; items: T[] }> {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const r = it.region_slug ?? 'other';
    const arr = map.get(r);
    if (arr) arr.push(it);
    else map.set(r, [it]);
  }

  const out: Array<{ region: string; items: T[] }> = [];
  for (const r of REGION_ORDER) {
    const g = map.get(r);
    if (g && g.length) {
      out.push({ region: r, items: g });
      map.delete(r);
    }
  }
  for (const [r, g] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (g.length) out.push({ region: r, items: g });
  }
  return out;
}
