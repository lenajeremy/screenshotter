export default async ({ page, shot, wait }) => {
  await shot("06-reopen");
  const keep = page.locator("text=Keep the first one");
  if (await keep.count()) { await keep.click(); await wait(6000); }
  await shot("07-editor-default");
  // Click the device in the middle of the canvas.
  const stage = page.locator(".stage, .canvas, [class*=stage]").first();
  const box = await stage.boundingBox();
  console.log("stage", JSON.stringify(box));
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.62);
  await wait(1500); await shot("08-device-selected");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.16);
  await wait(1500); await shot("09-headline-selected");
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height * 0.16);
  await wait(1200); await shot("10-headline-editing");
  await page.keyboard.press("Escape"); await wait(500);
  await page.keyboard.press("Escape"); await wait(800);
  await shot("11-nothing-selected");
};
