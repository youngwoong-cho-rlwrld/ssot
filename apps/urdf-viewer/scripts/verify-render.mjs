import { chromium } from "playwright-core";
import { existsSync } from "node:fs";

const chromePath = process.env.CHROME_BIN;
const target = process.env.VIEWER_URL ?? "http://127.0.0.1:5173/urdf/";

if (!chromePath) {
  throw new Error("CHROME_BIN is required: set it to your Chrome/Chromium executable path.");
}
if (!existsSync(chromePath)) {
  throw new Error(`Chrome executable not found: ${chromePath}`);
}

async function verifyViewport(browser, viewport, label) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("canvas", { timeout: 20000 });
  await page.waitForFunction(() => document.body.textContent?.includes("joints") && document.body.textContent?.includes("frames"), null, {
    timeout: 20000,
  });

  const canvasInfo = await page.locator("canvas").evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return { width: rect.width, height: rect.height, webgl: false, nonBackgroundSamples: 0 };

    let nonBackgroundSamples = 0;
    const pixel = new Uint8Array(4);
    for (let yStep = 2; yStep <= 18; yStep += 1) {
      for (let xStep = 2; xStep <= 18; xStep += 1) {
        const x = Math.max(0, Math.min(canvas.width - 1, Math.floor((canvas.width * xStep) / 20)));
        const y = Math.max(0, Math.min(canvas.height - 1, Math.floor((canvas.height * yStep) / 20)));
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        const isBackground = pixel[0] > 238 && pixel[1] > 240 && pixel[2] > 242;
        if (!isBackground && pixel[3] > 0) nonBackgroundSamples += 1;
      }
    }
    return { width: rect.width, height: rect.height, webgl: true, nonBackgroundSamples };
  });

  const hovered = await page.locator(".joint-row").first().hover().then(async () => {
    await page.waitForTimeout(150);
    return page.locator(".coordinate-label").count();
  });

  const overflow = await page.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));

  await page.close();

  if (!canvasInfo.webgl) throw new Error(`${label}: WebGL context was not available`);
  if (canvasInfo.width < 240 || canvasInfo.height < 240) throw new Error(`${label}: canvas is too small`);
  if (canvasInfo.nonBackgroundSamples === 0) throw new Error(`${label}: sampled canvas pixels looked blank`);
  if (hovered === 0) throw new Error(`${label}: hover did not activate linked coordinate UI`);
  if (errors.length > 0) throw new Error(`${label}: console/page errors: ${errors.join(" | ")}`);

  return { label, canvasInfo, overflow };
}

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--disable-gpu-sandbox", "--enable-webgl"],
});

try {
  const results = [];
  results.push(await verifyViewport(browser, { width: 1440, height: 900 }, "desktop"));
  results.push(await verifyViewport(browser, { width: 390, height: 844 }, "mobile"));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
