import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:1440,height:900}, deviceScaleFactor:2 });
await p.goto('file://'+process.cwd()+'/direction.html'); await p.waitForTimeout(1200);
await p.screenshot({path:'direction-light.png'});
await p.evaluate(()=>document.documentElement.dataset.theme='dark'); await p.waitForTimeout(200);
await p.screenshot({path:'direction-dark.png'});
await b.close();
