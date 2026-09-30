/**
 * Food photos for the demo app's screens, from Unsplash (free to use). Downloaded once into
 * site/demo/photos/, with who took them in credits.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const PHOTOS: Record<string, { query: string; pick?: number }> = {
  salmon: { query: "seared salmon plate dark moody" },
  bowl: { query: "pasta dish overhead dark" },
  salad: { query: "green salad bowl overhead" },
  ramen: { query: "ramen bowl dark background" },
  tacos: { query: "fish tacos plate" },
  curry: { query: "curry bowl rice overhead" },
  shakshuka: { query: "shakshuka pan" },
  toast: { query: "avocado toast plate" },
  table: { query: "dinner table overhead dark moody" },
};

export async function ensurePhotos(dir: string): Promise<Record<string, string>> {
  mkdirSync(dir, { recursive: true });
  const creditsFile = path.join(dir, "credits.json");
  const credits: Record<string, { id: string; by: string; url: string }> = existsSync(creditsFile) ? JSON.parse(readFileSync(creditsFile, "utf8")) : {};
  const files: Record<string, string> = {};
  for (const [name, { query, pick = 0 }] of Object.entries(PHOTOS)) {
    const file = path.join(dir, `${name}.jpg`);
    files[name] = file;
    if (existsSync(file)) continue;
    const res = await fetch(`https://unsplash.com/napi/search/photos?query=${encodeURIComponent(query)}&per_page=20`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Unsplash search for "${query}" failed (${res.status})`);
    const free = ((await res.json()) as { results: any[] }).results.filter((r) => !r.premium && !r.plus);
    const hit = free[pick % free.length];
    if (!hit) throw new Error(`No free Unsplash photo for "${query}"`);
    const img = await fetch(hit.urls.regular);
    writeFileSync(file, Buffer.from(await img.arrayBuffer()));
    credits[name] = { id: hit.id, by: hit.user?.name ?? "", url: hit.links?.html ?? `https://unsplash.com/photos/${hit.id}` };
    writeFileSync(creditsFile, JSON.stringify(credits, null, 2));
  }
  return files;
}
