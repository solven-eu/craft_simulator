const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://poe.ninja/');
  await page.getByRole('button', { name: 'Do not consent' }).click();
  await page.locator('[id="_r_4_"]').getByRole('link', { name: 'Economy' }).click();
  await page.getByRole('link', { name: 'Fate of the Vaal Active', exact: true }).click();
  await page.getByLabel('Value DisplayAdaptiveDivine').selectOption('exalted');
  await page.goto('https://poe.ninja/poe2/economy/vaal/currency?value=exalted');
  await page.getByLabel('Value DisplayAdaptiveDivine').selectOption('chaos');
  await page.goto('https://poe.ninja/poe2/economy/vaal/currency?value=chaos');
  await page.getByRole('cell', { name: '31 Chaos Orb' }).click();
  await page.getByText('1.5').nth(1).click();
  await page.getByRole('link', { name: 'Abyssal Bones' }).click();
  await page.getByLabel('Value DisplayAdaptiveDivine').selectOption('chaos');
  await page.goto('https://poe.ninja/poe2/economy/vaal/abyssal-bones?value=chaos');
  await page.getByRole('link', { name: 'Omens' }).click();
  await page.getByLabel('Value DisplayAdaptiveDivine').selectOption('chaos');
  await page.goto('https://poe.ninja/poe2/economy/vaal/omens?value=chaos');
  await page.getByRole('link', { name: 'Catalysts' }).click();
  await page.getByLabel('Value DisplayAdaptiveDivine').selectOption('chaos');
  await page.goto('https://poe.ninja/poe2/economy/vaal/breach-catalyst?value=chaos');
  await page.close();

  // ---------------------
  await context.close();
  await browser.close();
})();