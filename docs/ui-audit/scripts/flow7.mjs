export default async ({ page, shot, wait, st }) => {
  await page.waitForFunction(() => window.studio?.state?.ready, null, { timeout: 30000 });
  await wait(1500);
  const act = (fn, arg) => page.evaluate(async ([fn, arg]) => { const a = await import("/ui/actions.js"); return a[fn](...(arg ?? [])); }, [fn, arg]);
  const park = () => page.mouse.move(1000, 1150);
  await park();
  await st({ leftOpen: true, leftTab: "shapes", selected: null }); await wait(1500); await shot("60-elements-shapes");
  await st({ leftTab: "images" }); await wait(3500); await shot("61-elements-pictures");
  await st({ leftTab: "backgrounds" }); await wait(1500);
  await page.locator(".left-panel button:has-text('Looks'), aside button:has-text('Looks')").first().click().catch((e) => console.log("looks", e.message)); await park(); await wait(5000); await shot("62-bg-looks");
  await page.evaluate(() => { const el = [...document.querySelectorAll("*")].find((n) => n.scrollHeight > n.clientHeight + 200 && n.getBoundingClientRect().left < 600 && getComputedStyle(n).overflowY === "auto"); if (el) el.scrollTop = 1400; }); await wait(2500); await shot("63-bg-looks-scrolled");
  await page.locator("button:has-text('Photos')").first().click().catch(() => {}); await park(); await wait(3000); await shot("64-bg-photos");
  // Shapes and text on the design, then their inspectors.
  await act("addShape", ["arrow"]); await wait(1500); await shot("65-shape-arrow-selected");
  await act("addPresetShape", [ (await page.evaluate(async () => (await import("/ui/actions.js")).BADGE_PRESETS[0])) ]); await wait(1500); await shot("66-badge-selected");
  await act("addText", ["label"]); await wait(1500); await shot("67-text-label-selected");
  await act("addSticker", ["heart"]); await wait(2500); await shot("68-sticker-selected");
  // Device dropdown open.
  await st({ selected: "device-1" }); await wait(1200);
  await page.locator("button:has-text('Match the screenshot')").first().click().catch((e) => console.log("dd", e.message)); await wait(1000); await shot("69-device-dropdown");
  await page.keyboard.press("Escape"); await wait(500);
  // Inspector "More options" on the device.
  await page.locator("text=More options").first().click().catch(() => {}); await wait(800);
  await page.evaluate(() => { const el = [...document.querySelectorAll("*")].find((n) => n.scrollHeight > n.clientHeight + 200 && n.getBoundingClientRect().left > 1000 && getComputedStyle(n).overflowY === "auto"); if (el) el.scrollTop = 99999; }); await wait(800); await shot("70-device-more-options");
};
