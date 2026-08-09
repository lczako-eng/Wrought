import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  permissions: ['clipboard-read', 'clipboard-write'] });
const p = await ctx.newPage();
await p.goto('http://localhost:8099/index.html', { waitUntil: 'load' });
await p.evaluate(async () => {
  const step = innerHeight * 0.8;
  for (let y = 0; y < document.body.scrollHeight; y += step) { scrollTo(0, y); await new Promise(r => setTimeout(r, 80)); }
});
await p.waitForTimeout(500);
console.log('URL reads:', await p.$eval('#mcpurl', el => el.textContent));
await p.$eval('.close', el => el.scrollIntoView());
await p.waitForTimeout(700);
await p.screenshot({ path: 'home-cta.png' });
await p.click('#mcpurl');
await p.waitForTimeout(250);
console.log('after tap:', await p.$eval('#mcpurl', el => el.textContent));
await p.screenshot({ path: 'home-cta-copied.png' });
await b.close();
