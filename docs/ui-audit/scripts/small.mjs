export default async ({ page, shot, wait, st }) => {
  const n = process.env.W;
  await page.waitForFunction(() => window.studio?.state?.ready, null, { timeout: 30000 });
  await st({ modal: null, scenesPage: false, leftOpen: true, leftTab: "backgrounds", selected: null }); await wait(4000); await page.mouse.move(600, 700); await shot(`110-small-${n}`);
  await st({ selected: "device-1" }); await wait(1500); await shot(`111-small-${n}-device`);
  await page.evaluate(() => window.studio.command("timeline")); await wait(3000); await shot(`112-small-${n}-timeline`);
};
