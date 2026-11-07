export default async ({ page, shot, wait, st }) => {
  await page.waitForFunction(() => window.studio?.state?.ready, null, { timeout: 30000 });
  await wait(2500);
  const park = () => page.mouse.move(1000, 1150);
  await st({ leftOpen: false, selected: null }); await park();
  const now = Date.now();
  await st({ ai: { ...(await page.evaluate(() => window.studio.state.ai)), open: true, docked: false, busy: true, thread: [{ id: 1, role: "user", text: "Make the background a warm sunset and tilt the phones" }],
    work: { started: now - 9000, steps: [{ key: "look", at: now - 9000, end: now - 7000 }, { key: "think", at: now - 7000, end: now - 2000 }, { key: "render", at: now - 2000 }], items: [] } } });
  await wait(1500); await shot("100-ai-busy");
  await st({ ai: { ...(await page.evaluate(() => window.studio.state.ai)), busy: false, work: null, thread: [
    { id: 1, role: "user", text: "Make the background a warm sunset and tilt the phones" },
    { id: 2, role: "assistant", text: "Set a warm sunset gradient behind all three screens and tilted each phone 12° toward the centre.", ops: [{ prop: "background", target: "scene", value: "sunset" }, { prop: "rotateY", target: "device-1", value: -12 }], took: 14.2, changes: 4 },
    { id: 3, role: "user", text: "Can you make the headline shorter?" },
    { id: 4, role: "error", text: "Claude Code stopped before it finished: it ran out of time. Try again, or ask for a smaller change." } ] } });
  await wait(1500); await shot("101-ai-thread");
  await page.evaluate(async () => { const a = await import("/ui/actions.js"); a.dockAI?.(true); }); await wait(1500); await shot("102-ai-docked");
  await page.evaluate(async () => { const a = await import("/ui/actions.js"); a.dockAI?.(false); (await import("/ui/store.js")).set({ ai: { ...window.studio.state.ai, open: false } }); }); await wait(800);
  // Toasts.
  await page.evaluate(async () => { const s = await import("/ui/store.js");
    s.toast({ kind: "ok", title: "Exported 3 images", text: "In Screenshotter › mockups", actions: [{ label: "Open", run() {} }, { label: "Show in Finder", run() {} }], timeout: 0 });
    s.toast({ kind: "warn", title: "Worth knowing", text: "The headline runs into the phone at iPad 13″.", timeout: 0 });
    s.toast({ kind: "err", title: "Couldn't export", text: "The browser that draws designs quit. Try again.", timeout: 0 }); });
  await wait(1200); await shot("103-toasts");
  await page.evaluate(async () => { const s = await import("/ui/store.js"); s.set({ toasts: [] }); s.set({ rendering: { label: "Exporting video", progress: 0.42, left: 18 } }); });
  await wait(1200); await shot("104-exporting");
  await page.evaluate(async () => { (await import("/ui/store.js")).set({ rendering: null }); });
  await page.evaluate(() => window.studio.command("scenes")); await wait(3000);
  await page.locator(".sp-layout button, [aria-label*=ist]").last().click().catch(() => {}); await wait(1500); await shot("105-my-designs-list");
};
