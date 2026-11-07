export default async ({ page, shot, wait, st }) => {
  await page.waitForFunction(() => window.studio?.state?.ready, null, { timeout: 30000 });
  await wait(2000);
  await page.evaluate(() => window.studio.command("newScene")); await wait(2000);
  const thumbs = page.locator("text=Or use a screenshot you already have").locator("xpath=following::img");
  await thumbs.nth(3).click(); await wait(9000);
  await page.locator("text=Keep the first one").click(); await wait(5000);
  const info = async (label) => console.log(label, JSON.stringify(await page.evaluate(() => {
    const s = window.studio.state; const sel = s.selected; const box = document.querySelector(".sel-box, .selection, [class*=selbox]")?.getBoundingClientRect();
    const ent = sel && document.querySelector(`.ent[data-id="${sel}"]`)?.getBoundingClientRect();
    const insp = document.querySelector(".inspector, .right")?.innerText?.slice(0, 80);
    return { sel, ent: ent && [Math.round(ent.x), Math.round(ent.y), Math.round(ent.width), Math.round(ent.height)], vh: innerHeight, insp };
  })));
  // A label from the Elements panel, as a user adds it.
  await st({ leftOpen: true, leftTab: "text" }); await wait(1200);
  await page.locator("button:has-text('Label')").first().click(); await wait(1500); await info("label"); await shot("130-label-added");
  await st({ leftTab: "images" }); await wait(2500);
  await page.locator("text=Badges").first().scrollIntoViewIfNeeded().catch(() => {});
  await page.locator("button:has-text('New')").last().click().catch((e) => console.log("badge click", e.message.split("\n")[0])); await wait(1500); await info("badge"); await shot("131-badge-added");
  await page.locator("[title*=heart i], [aria-label*=heart i], button:has(img[src*=heart])").first().click().catch((e) => console.log("sticker click", e.message.split("\n")[0])); await wait(2000); await info("sticker"); await shot("132-sticker-added");
};
