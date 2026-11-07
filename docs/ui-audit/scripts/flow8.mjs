const L = "/private/tmp/claude-501/-Users-mac-Documents-screenshotter/d31ba984-670b-4646-b282-6d6fee6f787f/scratchpad/audit/lib";
export default async ({ page, shot, wait, st }) => {
  await page.waitForFunction(() => window.studio?.state?.ready, null, { timeout: 30000 });
  await wait(1500);
  const spec = { video: `${L}/recordings/rec-audit.mp4`, poster: `${L}/recordings/rec-audit.png`, width: 3840, height: 2160, duration: 12.1, name: "Screen recording", saveName: "Screen Recording 7 Nov", saveTo: `${L}/desktop`, cursor: `${L}/parts/cursor.json`,
    camera: { video: `${L}/parts/camera-edit.mp4`, poster: `${L}/parts/camera-edit.png`, x: 0.1, y: 0.78, height: 0.24, radius: 0.5, ring: true } };
  await page.evaluate((s) => window.studio.command("openRecording", s), spec);
  await wait(4000); await shot("80-rec-open-4s");
  await wait(10000); await page.mouse.move(1000, 1150); await shot("81-rec-editor");
  await page.evaluate(() => { const el = [...document.querySelectorAll("*")].find((n) => n.scrollHeight > n.clientHeight + 200 && n.getBoundingClientRect().left > 1000 && getComputedStyle(n).overflowY === "auto"); if (el) el.scrollTop = 700; }); await wait(800); await shot("82-rec-inspector-mid");
  await page.evaluate(() => { const el = [...document.querySelectorAll("*")].find((n) => n.scrollHeight > n.clientHeight + 200 && n.getBoundingClientRect().left > 1000 && getComputedStyle(n).overflowY === "auto"); if (el) el.scrollTop = 99999; }); await wait(800); await shot("83-rec-inspector-end");
  // The webcam layer.
  await st({ selected: "device-2" }); await wait(1200); await shot("84-rec-webcam-selected");
  await st({ selected: null }); await wait(500);
  // Timeline with a footage part and a zoom selected.
  if (!(await page.evaluate(() => window.studio.state.timelineOpen))) await page.evaluate(() => window.studio.command("timeline"));
  await wait(3500); await shot("85-rec-timeline");
  await page.evaluate(async () => { const t = await import("/ui/timeline.js"); const zi = window.studio.state.scene.animations?.findIndex((a) => a.targets === "camera"); if (zi >= 0) t.selectAnimation?.(zi); }); await wait(1500); await shot("86-rec-zoom-selected");
  await page.evaluate(async () => { const s = await import("/ui/sound.js"); s.selectSound?.(0); }); await wait(1500); await shot("87-rec-sound-selected");
  await page.evaluate(async () => { const f = await import("/ui/footage.js"); f.selectPart?.(0); }); await wait(1500); await shot("88-rec-footage-selected");
  await page.keyboard.press("Escape"); await wait(500);
  // Export popover on a recording (video).
  await page.evaluate(() => window.studio.command("exportVideo")).catch(() => {});
  await wait(300);
  await page.evaluate(async () => { (await import("/ui/store.js")).set({ rendering: null }); });
  await page.evaluate(async () => { const a = await import("/ui/actions.js"); (await import("/ui/store.js")).set({ exportOpen: false }); a.openExport(); }); await wait(1500); await shot("89-rec-export");
};
