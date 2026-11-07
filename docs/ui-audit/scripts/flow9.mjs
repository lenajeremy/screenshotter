export default async ({ page, shot, wait, st }) => {
  await page.waitForFunction(() => window.studio?.state?.ready, null, { timeout: 30000 });
  await wait(1500);
  const act = (fn, ...arg) => page.evaluate(async ([fn, arg]) => { const a = await import("/ui/actions.js"); return a[fn](...arg); }, [fn, arg]);
  const park = () => page.mouse.move(1000, 1150);
  await page.evaluate(() => window.studio.command("newScene")); await wait(2000);
  const thumbs = page.locator("text=Or use a screenshot you already have").locator("xpath=following::img");
  await thumbs.nth(4).click(); await wait(9000);
  await page.locator("text=Keep the first one").click(); await wait(5000);
  await act("addShot", "copy"); await wait(3000); await act("addShot", "copy"); await wait(5000);
  await st({ selected: null, leftOpen: false }); await park(); await wait(2000); await shot("90-set-view");
  await page.evaluate(() => window.studio.command("fit")); await wait(1500); await shot("91-set-view-fit");
  await act("openCopyStyle"); await wait(1500); await shot("92-copy-style");
  await st({ modal: null }); await wait(500);
  await st({ modal: { kind: "storePage" } }); await wait(4000); await shot("93-store-page");
  await st({ modal: null }); await wait(500);
  await page.evaluate(() => window.studio.command("whatsNew")); await wait(2000); await shot("94-whats-new");
  await st({ modal: null }); await wait(500);
  // Wallpapers under Looks.
  await st({ leftOpen: true, leftTab: "backgrounds" }); await wait(1500);
  await page.getByRole("button", { name: "Looks", exact: true }).first().click().catch((e) => console.log("looks:", e.message.split("\n")[0]));
  await park(); await wait(5000); await shot("95-bg-looks");
  await page.evaluate(() => { const el = [...document.querySelectorAll("*")].find((n) => n.scrollHeight > n.clientHeight + 200 && n.getBoundingClientRect().left < 600 && /auto|scroll/.test(getComputedStyle(n).overflowY)); if (el) el.scrollTop = 1300; }); await wait(3000); await shot("96-bg-looks-more");
  await page.getByRole("button", { name: "Photos", exact: true }).first().click().catch((e) => console.log("photos:", e.message.split("\n")[0])); await park(); await wait(3000); await shot("97-bg-photos");
  // Export popover on a set.
  await act("openExport"); await wait(1500); await shot("98-export-set");
  await st({ exportOpen: false }); await wait(400);
  // Templates panel on this set.
  await st({ leftTab: "designs" }); await park(); await wait(6000); await shot("99-templates-set");
};
