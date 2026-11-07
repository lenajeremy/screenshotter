export default async ({ page, shot, wait }) => {
  await wait(3000);
  await page.locator('[title*="ew design"], [aria-label*="ew design"]').first().click().catch(() => page.keyboard.press("Meta+n"));
  await wait(2500);
  const thumbs = page.locator("text=Or use a screenshot you already have").locator("xpath=following::img");
  await thumbs.nth(2).click(); await wait(9000);
  await page.locator("text=Keep the first one").click(); await wait(6000);
  await page.mouse.move(700, 1000);
  const rail = async (label) => { const head = page.locator(`h2:has-text("${label}"), .panel-title:has-text("${label}")`); if (!(await head.first().isVisible().catch(() => false))) { await page.locator(`.rail >> text="${label}"`).first().click().catch(() => page.locator(`text="${label}"`).first().click()); } };
  const tab = async (label, name, after = 2500) => { await page.locator(`button:visible:has-text("${label}")`).first().click(); await wait(after); await page.mouse.move(800, 1100); await wait(400); await shot(name); };
  await rail("Elements"); await wait(1500); await shot("50-elements-text");
  await tab("Shapes", "51-elements-shapes");
  await tab("Pictures", "52-elements-pictures", 4000);
  await rail("Backgrounds"); await wait(2500); await shot("53-bg-current");
  await tab("Looks", "54-bg-looks", 5000);
  await tab("Photos", "55-bg-photos", 5000);
  await tab("AI image", "56-bg-ai");
  // Right-click the device.
  const box = await page.locator(".stage").first().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.6, { button: "right" }); await wait(1000); await shot("57-context-menu");
  await page.keyboard.press("Escape"); await wait(500);
  // Title menu.
  await page.locator("text=Untitled design").first().click(); await wait(1000); await shot("58-title-menu");
  await page.keyboard.press("Escape"); await wait(500);
};
