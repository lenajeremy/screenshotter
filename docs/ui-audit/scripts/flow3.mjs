export default async ({ page, shot, wait }) => {
  await wait(3000);
  const rail = async (label, name, after = 2500) => {
    await page.locator(`text="${label}"`).first().click();
    await wait(after);
    await shot(name);
  };
  await rail("Screenshots", "20-left-screenshots");
  await rail("Templates", "21-left-templates", 8000);
  await rail("Backgrounds", "22-left-backgrounds", 5000);
  await page.mouse.wheel(0, 0);
  await rail("Elements", "23-left-elements", 3000);
  await rail("My designs", "24-my-designs", 3000);
  await page.keyboard.press("Escape"); await wait(800);
  await rail("Help", "25-help", 1500);
  await page.keyboard.press("Escape"); await wait(800);
  await rail("Settings", "26-settings", 1500);
  await page.keyboard.press("Escape"); await wait(800);
};
