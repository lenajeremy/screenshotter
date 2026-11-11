/** A board's thumbnail for the library: its first artboard, drawn a few seconds after the last change. */
import { writeFileSync } from "node:fs";
import { type Board } from "./core.js";
import { drawLayers } from "./render.js";
import { boardThumb, getBoard } from "./store.js";

const pending = new Map<string, NodeJS.Timeout>();
let queue: Promise<void> = Promise.resolve();

export function scheduleBoardThumb(id: string, delay = 2500) {
  clearTimeout(pending.get(id));
  pending.set(
    id,
    setTimeout(() => {
      pending.delete(id);
      queue = queue.then(() => drawThumb(id)).catch(() => undefined);
    }, delay),
  );
}

async function drawThumb(id: string) {
  let b: Board;
  try {
    b = getBoard(id);
  } catch {
    return;
  }
  const first = b.pages[0]?.children.find((x) => b.nodes[x] && !b.nodes[x].hidden);
  if (!first) return;
  const { images } = await drawLayers(b, [first], { scale: 1, maxEdge: 640, format: "jpeg", quality: 82, transparent: false });
  if (images[first]) writeFileSync(boardThumb(id), images[first]);
}
