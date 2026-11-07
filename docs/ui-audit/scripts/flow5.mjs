export default async ({ page, shot, wait }) => {
  await wait(3000);
  // New design, then open the recording from the start screen.
  await page.locator('[title*="ew design"], [aria-label*="ew design"]').first().click().catch(async () => { await page.keyboard.press("Meta+n"); });
  await wait(2500); await shot("40-new-design");
  const thumbs = page.locator("text=Or use a screenshot you already have").locator("xpath=following::img");
  await thumbs.nth(0).click();
  await wait(5000); await shot("41-recording-opening");
  await wait(15000); await shot("42-recording-editor");
  const stage = page.locator(".stage").first();
  const box = await stage.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await wait(1500); await shot("43-recording-selected");
  await page.locator(".inspector, aside").last().evaluate((el) => { const s = [...el.querySelectorAll("*")].find((n) => n.scrollHeight > n.clientHeight + 40 && getComputedStyle(n).overflowY !== "visible"); if (s) s.scrollTop = 900; });
  await wait(800); await shot("44-recording-inspector-scrolled");
  await page.keyboard.press("Meta+t"); await wait(4000); await shot("45-recording-timeline");
};
