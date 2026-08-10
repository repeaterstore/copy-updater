/**
 * Loads a stored snapshot in a real browser, checks it renders, then drives the
 * injected preview runtime over postMessage exactly as the workspace will.
 *
 * Serves the snapshot over HTTP rather than file:// — protocol-relative asset
 * URLs ("//host/x.jpg") resolve to file://host/x.jpg and always fail under
 * file://, which makes a perfectly good snapshot look broken.
 *
 *   npx tsx scripts/verify-snapshot.mts <snapshot.html> <skeleton.html> [out.png]
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { chromium } from "playwright";
import { extractBlocks } from "@/lib/ops/extract";
import { PREVIEW_CHANNEL } from "@/lib/preview/protocol";
import type { Op } from "@/lib/ops/types";

const snapshotFile = process.argv[2];
const skeletonFile = process.argv[3];
const outPng = process.argv[4] ?? "/tmp/preview-check.png";

const html = readFileSync(snapshotFile);

const skeletonDom = new JSDOM(readFileSync(skeletonFile, "utf8"));
const blocks = extractBlocks(skeletonDom.window.document).filter(
  (b) => b.text.length > 25,
);
const target = blocks[0];
const second = blocks[1];
console.log(`blocks in skeleton : ${blocks.length}`);
console.log(`target block       : ${target.id}`);
console.log(`  before           : ${JSON.stringify(target.text.slice(0, 60))}`);

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors: string[] = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

// esbuild's keepNames helper leaks into serialised evaluate bodies.
await page.addInitScript({
  content: "globalThis.__name = globalThis.__name || function (f) { return f };",
});

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
await page.waitForTimeout(2500);

const render = await page.evaluate(() => {
  const imgs = Array.from(document.images);
  const remote = imgs.filter((i) => !(i.currentSrc || i.src).startsWith("data:"));
  return {
    height: document.body.scrollHeight,
    width: document.body.scrollWidth,
    images: imgs.length,
    inlined: imgs.length - remote.length,
    stillRemote: remote.length,
    broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
    stylesheets: document.querySelectorAll("style").length,
    ids: document.querySelectorAll("[data-cu-id]").length,
  };
});
console.log("\nrendered snapshot:", render);

const ops: Op[] = [
  { t: "setText", id: target.id, html: "REWRITTEN BY THE OPS ENGINE" },
  { t: "setMeta", title: "New Meta Title", description: "New meta description" },
  {
    t: "insert",
    refId: second.id,
    pos: "after",
    html: '<p data-cu-id="new:testbullet">An inserted paragraph</p>',
  },
];

const applyResult = await page.evaluate(
  async ({ ops, channel }) => {
    const done = new Promise((resolve) => {
      window.addEventListener("message", function handler(e: MessageEvent) {
        if (e.data?.channel === channel && e.data.type === "applied") {
          window.removeEventListener("message", handler);
          resolve(e.data);
        }
      });
      setTimeout(() => resolve({ timedOut: true }), 5000);
    });
    window.postMessage({ channel, type: "applyOps", ops }, "*");
    return done;
  },
  { ops, channel: PREVIEW_CHANNEL },
);
console.log("\napplyOps ->", JSON.stringify(applyResult));

const after = await page.evaluate(
  (id) => ({
    targetText: document.querySelector(`[data-cu-id="${id}"]`)?.textContent ?? null,
    title: document.title,
    description:
      document.querySelector('meta[name="description"]')?.getAttribute("content") ?? null,
    insertedPresent: Boolean(document.querySelector('[data-cu-id="new:testbullet"]')),
  }),
  target.id,
);
console.log("after ops:", after);

// Replay a different op set: proves ops apply from the pristine baseline rather
// than compounding on the previous edit.
await page.evaluate(
  ({ channel, id }) => {
    window.postMessage(
      { channel, type: "applyOps", ops: [{ t: "setText", id, html: "SECOND REWRITE" }] },
      "*",
    );
  },
  { channel: PREVIEW_CHANNEL, id: target.id },
);
await page.waitForTimeout(800);
console.log(
  "after replay (insert should be gone):",
  await page.evaluate(
    (id) => ({
      targetText: document.querySelector(`[data-cu-id="${id}"]`)?.textContent ?? null,
      insertedStillPresent: Boolean(
        document.querySelector('[data-cu-id="new:testbullet"]'),
      ),
    }),
    target.id,
  ),
);

await page.evaluate(
  ({ channel, ids }) => {
    window.postMessage(
      {
        channel,
        type: "setDiffMode",
        on: true,
        highlights: { changed: ids, added: [], removed: [], moved: [], layoutRisk: [] },
      },
      "*",
    );
  },
  { channel: PREVIEW_CHANNEL, ids: [target.id] },
);
await page.waitForTimeout(400);
console.log(
  "diff decorations:",
  await page.evaluate(() => ({
    changed: document.querySelectorAll('[data-cu-diff="changed"]').length,
  })),
);

await page.screenshot({ path: outPng, fullPage: false });
console.log(`\nviewport screenshot -> ${outPng}`);
console.log("console errors:", errors.length ? errors.slice(0, 5) : "none");

await browser.close();
server.close();
