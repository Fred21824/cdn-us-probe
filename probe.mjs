// Loads the BetsWG guest homepage in headless Chromium and records per-request
// timing, size and CloudFront cache status. Public URL only, no credentials.
import { chromium, devices } from 'playwright';
import fs from 'node:fs';

const URL_ = process.env.TARGET || 'https://www.betswgplay.top/';
const label = process.env.LABEL || 'run';
const throttle = process.env.THROTTLE === '1';

async function loadOnce(context, name) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (throttle) {
    // Rough "good US 4G": 20 Mbps down, 5 Mbps up, +60ms RTT.
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 60,
      downloadThroughput: (20 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8,
    });
  }
  const reqs = [];
  const t0 = Date.now();
  page.on('requestfinished', async (req) => {
    try {
      const res = await req.response();
      const h = res ? await res.allHeaders() : {};
      const sz = await req.sizes().catch(() => ({}));
      const tm = req.timing();
      reqs.push({
        url: req.url(), type: req.resourceType(), status: res?.status(),
        fromCache: res ? (await res.serverAddr()) === null : null,
        xcache: h['x-cache'] || '', pop: h['x-amz-cf-pop'] || '', cc: h['cache-control'] || '',
        enc: h['content-encoding'] || '', bytes: sz.responseBodySize ?? null,
        start: tm.startTime - t0, ttfb: tm.responseStart, end: tm.responseEnd,
        finishedAt: Date.now() - t0,
      });
    } catch (e) { reqs.push({ url: req.url(), err: String(e) }); }
  });
  page.on('requestfailed', (req) => reqs.push({ url: req.url(), failed: req.failure()?.errorText }));
  await page.addInitScript(() => {
    window.__lcp = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp = e.startTime; })
      .observe({ type: 'largest-contentful-paint', buffered: true });
  });
  let err = null;
  try { await page.goto(URL_, { waitUntil: 'load', timeout: 90000 }); } catch (e) { err = String(e); }
  const tLoad = Date.now() - t0;
  try { await page.waitForLoadState('networkidle', { timeout: 60000 }); } catch (e) { err = err || String(e); }
  const tIdle = Date.now() - t0;
  const perf = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0] || {};
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return { ttfb: n.responseStart, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd,
             fcp: fcp ? fcp.startTime : null, lcp: window.__lcp };
  }).catch(() => ({}));
  const shot = `shot-${label}-${name}.png`;
  await page.screenshot({ path: shot }).catch(() => {});
  await page.close();
  const ok = reqs.filter((r) => !r.failed && !r.err);
  const sum = (a, f) => a.reduce((s, r) => s + (f(r) || 0), 0);
  const isJsCss = (r) => /\.(js|css)(\?|$)/.test(new URL(r.url).pathname);
  const summary = {
    name, err, tLoad, tIdle, perf,
    requests: reqs.length, failed: reqs.length - ok.length,
    bytes: sum(ok, (r) => r.bytes),
    jsCss: ok.filter(isJsCss).length, jsCssBytes: sum(ok.filter(isJsCss), (r) => r.bytes),
    hit: ok.filter((r) => /Hit/i.test(r.xcache)).length,
    miss: ok.filter((r) => /Miss/i.test(r.xcache)).length,
    refreshHit: ok.filter((r) => /RefreshHit/i.test(r.xcache)).length,
    browserCache: ok.filter((r) => r.fromCache).length,
    pops: [...new Set(ok.map((r) => r.pop).filter(Boolean))],
  };
  return { summary, reqs };
}

const browser = await chromium.launch();
const out = { label, throttle, target: URL_, at: new Date().toISOString(), runs: [] };
const ctxOpts = { ...devices['Pixel 7'] };

// round1: new browser profile, CDN as found (mostly cold in the US).
const c1 = await browser.newContext(ctxOpts);
out.runs.push(await loadOnce(c1, 'r1-cdn-cold'));
await c1.close();
// round2: new browser profile again; CDN POP was just filled by round1.
const c2 = await browser.newContext(ctxOpts);
out.runs.push(await loadOnce(c2, 'r2-cdn-warm'));
// round3: same profile reloaded; browser cache warm (returning visitor).
out.runs.push(await loadOnce(c2, 'r3-browser-warm'));
await c2.close();
await browser.close();

fs.writeFileSync(`result-${label}.json`, JSON.stringify(out, null, 1));
for (const r of out.runs) console.log(JSON.stringify(r.summary));
