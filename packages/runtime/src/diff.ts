/** Cheap multiset line diff: good enough for construction-progress sizing. */
export function lineDiff(oldText: string, newText: string): { added: number; removed: number } {
  const count = (text: string) => {
    const map = new Map<string, number>();
    if (text === "") return map;
    for (const line of text.split("\n")) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = count(oldText);
  const newLines = count(newText);
  let added = 0;
  let removed = 0;
  for (const [line, n] of newLines) added += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) removed += Math.max(0, n - (newLines.get(line) ?? 0));
  return { added, removed };
}
