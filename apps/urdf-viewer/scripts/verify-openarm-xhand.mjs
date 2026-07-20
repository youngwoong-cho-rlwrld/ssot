import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chromePath = process.env.CHROME_BIN;
const target = process.env.VIEWER_URL ?? "http://127.0.0.1:5173/urdf/";
const parquetPath = process.env.OPENARM_PARQUET;
const screenshotPath = process.env.OPENARM_SCREENSHOT ?? join(tmpdir(), "openarm-xhand1-viewer.png");
const basePath = process.env.URDF_BASE_PATH ?? process.env.SSOT_URDF_BASE_PATH ?? "/urdf/";
const expectedUrdfPath = `${basePath}assets/openarm-xhand1/openarm_xhand1.urdf`.replace(/\/{2,}/g, "/");
const urdfText = await readFile(
  new URL("../public/assets/openarm-xhand1/openarm_xhand1.urdf", import.meta.url),
  "utf8",
);

if (!chromePath) throw new Error("CHROME_BIN is required: set it to your Chrome/Chromium executable path.");
if (!parquetPath) throw new Error("OPENARM_PARQUET is required: set it to the OpenArm+XHand1 episode parquet path.");
if (!existsSync(chromePath)) throw new Error(`Chrome executable not found: ${chromePath}`);
if (!existsSync(parquetPath)) throw new Error(`Parquet file not found: ${parquetPath}`);

function positionFromLabel(label) {
  const match = label.match(/\n\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s+m$/);
  if (!match) throw new Error(`Unable to parse joint position: ${label}`);
  return match.slice(1).map(Number);
}

function jointAttribute(jointName, tagName, attributeName) {
  const escapedName = jointName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const joint = urdfText.match(new RegExp(`<joint name="${escapedName}"[^>]*>([\\s\\S]*?)<\\/joint>`));
  const tag = joint?.[1].match(new RegExp(`<${tagName}[^>]*\\b${attributeName}="([^"]+)"`));
  if (!tag) throw new Error(`Unable to read ${jointName} ${tagName}.${attributeName}`);
  return tag[1].trim().split(/\s+/).map(Number);
}

function distance(a, b) {
  return Math.hypot(...a.map((value, index) => value - b[index]));
}

function assertNear(actual, expected, tolerance, context) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${context}: expected ${expected}, got ${actual}`);
  }
}

function assertVectorNear(actual, expected, tolerance, context) {
  if (actual.length !== expected.length) {
    throw new Error(`${context}: expected ${expected.length} values, got ${actual.length}`);
  }
  actual.forEach((value, index) => assertNear(value, expected[index], tolerance, `${context}[${index}]`));
}

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--disable-gpu-sandbox", "--enable-webgl"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(target, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="file"][accept=".parquet"]').setInputFiles(parquetPath);
  await page.waitForFunction(
    () => document.body.textContent?.includes("55 joints") && document.body.textContent?.includes("382 frames"),
    null,
    { timeout: 30000 },
  );

  const mappingSection = page.locator(".panel-section").filter({ hasText: "Mapping" });
  const mappingText = await mappingSection.textContent();
  const stateColumn = await page.locator('input[list="parquet-columns"]').inputValue();
  const urdfPath = await page.locator(".source-panel .field input").first().inputValue();

  async function jointPosition(jointName) {
    const row = page.locator(".joint-row").filter({ hasText: jointName });
    const count = await row.count();
    if (count !== 1) throw new Error(`Expected one row for ${jointName}, found ${count}`);
    await row.hover();
    return positionFromLabel(await page.locator(".coordinate-label").innerText());
  }

  const frame0Wrist = await jointPosition("openarm_left_joint7");
  const frame0LeftThumb2 = await jointPosition("left_hand_thumb_rota_joint2");
  const frame0LeftThumbTip = await jointPosition("left_hand_thumb_rota_joint3");
  const frame0RightThumb2 = await jointPosition("right_hand_thumb_rota_joint2");
  const frame0RightThumbTip = await jointPosition("right_hand_thumb_rota_joint3");
  const frame0LeftIndex2 = await jointPosition("left_hand_index_joint2");
  const frame0LeftIndexTip = await jointPosition("left_hand_index_rota_joint3");
  const frame0RightIndex2 = await jointPosition("right_hand_index_joint2");
  const frame0RightIndexTip = await jointPosition("right_hand_index_rota_joint3");

  await page.locator('input[type="range"]').fill("100");
  const frame100Wrist = await jointPosition("openarm_left_joint7");
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const fingertipLengths = {
    leftThumb: distance(frame0LeftThumb2, frame0LeftThumbTip),
    rightThumb: distance(frame0RightThumb2, frame0RightThumbTip),
    leftIndex: distance(frame0LeftIndex2, frame0LeftIndexTip),
    rightIndex: distance(frame0RightIndex2, frame0RightIndexTip),
  };

  const mountRpy = {
    left: jointAttribute("left_xhand_mount", "origin", "rpy"),
    right: jointAttribute("right_xhand_mount", "origin", "rpy"),
  };
  const indexBendAxes = {
    left: jointAttribute("left_hand_index_bend_joint", "axis", "xyz"),
    right: jointAttribute("right_hand_index_bend_joint", "axis", "xyz"),
  };

  if (urdfPath !== expectedUrdfPath) {
    throw new Error(`OpenArm preset was not selected: ${urdfPath}`);
  }
  if (stateColumn !== "observation.joint_position") {
    throw new Error(`Unexpected state column: ${stateColumn}`);
  }
  if (!mappingText?.includes("Auto (openarm-xhand1-40)")) {
    throw new Error(`Unexpected mapping: ${mappingText}`);
  }
  if (!mappingText.includes("Head order") || !mappingText.includes("0 pitch · 1 yaw") || mappingText.includes("44 yaw")) {
    throw new Error(`Unexpected OpenArm head-order UI: ${mappingText}`);
  }
  if (frame0Wrist.every((value, index) => value === frame100Wrist[index])) {
    throw new Error(`Wrist pose did not change between frames: ${frame0Wrist.join(", ")}`);
  }
  assertVectorNear(mountRpy.left, [Math.PI, 0, -Math.PI / 2], 1e-12, "left XHand mount RPY");
  assertVectorNear(mountRpy.right, [Math.PI, 0, Math.PI / 2], 1e-12, "right XHand mount RPY");
  assertVectorNear(indexBendAxes.left, [-1, 0, 0], 1e-12, "left index-bend axis");
  assertVectorNear(indexBendAxes.right, [1, 0, 0], 1e-12, "right index-bend axis");
  assertNear(fingertipLengths.leftThumb, 0.0504, 0.002, "left thumb distal length");
  assertNear(fingertipLengths.rightThumb, 0.0504, 0.002, "right thumb distal length");
  assertNear(fingertipLengths.leftIndex, 0.0425, 0.002, "left index distal length");
  assertNear(fingertipLengths.rightIndex, 0.0425, 0.002, "right index distal length");
  if (errors.length > 0) throw new Error(`Browser errors: ${errors.join(" | ")}`);

  console.log(
    JSON.stringify(
      {
        urdfPath,
        stateColumn,
        headOrder: ["pitch", "yaw"],
        mapping: "openarm-xhand1-40",
        frames: 382,
        frame0Wrist,
        frame100Wrist,
        mountRpy,
        indexBendAxes,
        fingertipLengths,
        screenshotPath,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
