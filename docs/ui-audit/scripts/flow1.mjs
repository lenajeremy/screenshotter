export default async ({ page, shot, wait }) => {
  // Hover states on the start screen.
  await page.hover("text=Drop a screenshot or a recording here"); await wait(300); await shot("02-start-hover-drop");
  // Pick an existing screenshot (the cook screen).
  const thumbs = page.locator("text=Or use a screenshot you already have").locator("xpath=following::img");
  console.log("thumbs", await thumbs.count());
  await thumbs.nth(5).click();
  await wait(2500); await shot("03-after-pick-2s");
  await wait(9000); await shot("04-after-pick-11s");
  await wait(12000); await shot("05-after-pick-23s");
};
