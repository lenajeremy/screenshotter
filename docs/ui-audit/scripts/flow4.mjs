export default async ({ page, shot, wait }) => {
  await wait(3000);
  // Does Escape close Help?
  await page.locator('text="Help"').first().click(); await wait(800);
  await page.keyboard.press("Escape"); await wait(800);
  console.log("help still open after Escape:", await page.locator("h2:has-text(\"How Screenshotter works\")").isVisible());
  const close = page.locator(".scrim").first();
  if (await close.isVisible()) { await page.mouse.click(30, 600); await wait(600); console.log("after scrim click:", await page.locator("h2:has-text(\"How Screenshotter works\")").isVisible()); }
  if (await page.locator("h2:has-text(\"How Screenshotter works\")").isVisible()) { await page.locator('[aria-label*=lose], button:has-text("×")').first().click().catch(() => {}); await wait(600); }
  await page.locator('text="Settings"').first().click(); await wait(1500); await shot("26-settings");
  await page.keyboard.press("Escape"); await wait(800);
  console.log("settings open after Escape:", await page.locator(".scrim").first().isVisible().catch(() => false));
  await page.mouse.click(1000, 450); await wait(500);
  await page.reload(); await wait(3500);
  await page.locator('text="Ask AI"').first().click(); await wait(1500); await shot("30-ask-ai");
  await page.keyboard.type("Make the background a sunset"); await wait(500); await shot("31-ask-ai-typed");
  await page.keyboard.press("Escape"); await wait(800);
  await page.locator('button:has-text("Export")').first().click(); await wait(2500); await shot("32-export");
  await page.keyboard.press("Escape"); await wait(800);
  await page.locator('text="Timeline"').first().click(); await wait(3000); await shot("33-timeline");
  await page.keyboard.press("Space"); await wait(1500); await shot("34-timeline-playing");
  await page.keyboard.press("Space"); await wait(500);
};
