export default async ({ page, shot, wait, st }) => {
  await page.waitForFunction(() => window.studio?.state?.ready, null, { timeout: 30000 });
  await wait(1500);
  console.log("native class:", await page.evaluate(() => document.documentElement.className));
  await page.evaluate(() => window.studio.command("newScene")); await wait(2500); await page.mouse.move(700, 860); await shot("120-native-start");
  await page.evaluate(() => window.studio.command("scenes")); await wait(2500); await shot("121-native-my-designs");
  await page.locator(".sp-card, [data-scene]").first().click().catch(() => {}); await wait(5000); await page.mouse.move(700, 860); await shot("122-native-editor");
  await st({ modal: { kind: "settings" } }); await wait(1500); await shot("123-native-settings");
  await page.evaluate(() => { const el = document.querySelector(".modal, .sheet, dialog") ; const sc = [...document.querySelectorAll("*")].find((n) => n.scrollHeight > n.clientHeight + 300 && /auto|scroll/.test(getComputedStyle(n).overflowY) && n.closest(".modal, .sheet, [class*=modal]")); if (sc) sc.scrollTop = 99999; }); await wait(800); await shot("124-native-settings-end");
};
