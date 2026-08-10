/**
 * Captures a live URL into a frozen, self-contained snapshot.
 *
 * Everything happens in one Playwright session so the stamped ids, the measured
 * boxes, the screenshot and the inlined HTML all describe the same render of
 * the same page.
 */
import { chromium, type Browser, type Page } from "playwright";
import { bundleBrowserScript } from "@/lib/browser/bundle";
import type { CaptureExtraction } from "@/lib/browser/capture-entry";

export type CaptureStage =
  | "launching"
  | "loading"
  | "settling"
  | "extracting"
  | "screenshotting"
  | "inlining"
  | "finalizing";

export interface CaptureOptions {
  url: string;
  viewportWidth?: number;
  viewportHeight?: number;
  /** Overall budget for navigation and settling. */
  timeoutMs?: number;
  /** Ceiling for the inlining step, which dominates on asset-heavy pages. */
  inlineTimeoutMs?: number;
  onProgress?: (stage: CaptureStage) => void;
}

export interface CaptureResult {
  html: string;
  skeleton: string;
  screenshot: Buffer;
  extraction: CaptureExtraction;
  finalUrl: string;
}

/**
 * SingleFile ships its browser code as an ES module whose exports are *strings*
 * of JavaScript, not as a script file to inject directly. `script` defines the
 * `singlefile` global; `hookScript` patches page APIs and must land before the
 * page's own scripts run.
 */
interface SingleFileBundle {
  script: string;
  hookScript: string;
}

let bundlePromise: Promise<SingleFileBundle> | null = null;

function loadSingleFileBundle(): Promise<SingleFileBundle> {
  if (!bundlePromise) {
    // The specifier must be a static string. Building a file:// URL at runtime
    // and importing that works under plain Node but fails inside Next with
    // "Cannot find module as expression is too dynamic" — the bundler has to be
    // able to see the specifier to externalise it. `single-file-cli` is listed
    // in serverExternalPackages, so this resolves at runtime rather than being
    // bundled.
    bundlePromise = import(
      "single-file-cli/lib/single-file-bundle.js"
    ) as Promise<SingleFileBundle>;
  }
  return bundlePromise;
}

/**
 * SingleFile settings chosen for review fidelity rather than archive size.
 *
 * The "unused" removals are all disabled on purpose: they prune CSS and fonts
 * that nothing currently references, but layout-mode edits routinely introduce
 * markup that uses exactly those rules. Pruning them would make a new element
 * styled with an existing class silently render unstyled.
 */
const SINGLE_FILE_OPTIONS = {
  removeHiddenElements: false,
  removeUnusedStyles: false,
  removeUnusedFonts: false,
  removeAlternativeFonts: false,
  removeAlternativeMedias: false,
  removeAlternativeImages: false,
  compressHTML: false,
  compressCSS: false,
  blockScripts: false,
  blockVideos: false,
  blockAudios: false,
  // A CSP meta tag in the saved page would block our own preview runtime.
  insertMetaCSP: false,
  saveRawPage: false,
  removeImports: false,
};

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      // Never hold the process open on the loser of the race.
      timer.unref?.();
    }),
  ]);
}

/**
 * Scroll the page end to end so lazy-loaded images actually load.
 *
 * Bounded by wall clock, iteration count, and a stuck-position check rather
 * than by document height. On a lazy-loading page every scroll appends more
 * content, so `scrollHeight` grows faster than the scroll position climbs and a
 * height-based exit condition never fires — the capture simply hangs.
 */
async function settle(page: Page, timeoutMs: number): Promise<void> {
  const scrollBudgetMs = Math.min(timeoutMs / 2, 20_000);

  await page.evaluate(async (budgetMs: number) => {
    await new Promise<void>((resolve) => {
      const step = 800;
      const startedAt = Date.now();
      let lastY = -1;
      let stuckRounds = 0;

      const finish = () => {
        clearInterval(timer);
        window.scrollTo(0, 0);
        resolve();
      };

      const timer = setInterval(() => {
        if (Date.now() - startedAt > budgetMs) return finish();

        window.scrollBy(0, step);
        const y = window.scrollY;

        // Position stopped advancing: we are at the bottom, or the page pins
        // scrolling. Two consecutive rounds guards against a slow reflow.
        if (y === lastY) {
          stuckRounds += 1;
          if (stuckRounds >= 2) return finish();
        } else {
          stuckRounds = 0;
        }
        lastY = y;
      }, 80);
    });
  }, scrollBudgetMs);

  // Give newly-requested images a chance to arrive, but never hang on a page
  // that keeps a socket open forever (analytics, chat widgets, polling).
  await page
    .waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 15_000) })
    .catch(() => undefined);

  await page
    .evaluate(async () => {
      const pending = Array.from(document.images).filter((img) => !img.complete);
      await Promise.race([
        Promise.all(
          pending.map(
            (img) =>
              new Promise((resolve) => {
                img.addEventListener("load", resolve, { once: true });
                img.addEventListener("error", resolve, { once: true });
              }),
          ),
        ),
        // An image that never resolves either way must not stall the capture.
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
    })
    .catch(() => undefined);
}

/**
 * Give SingleFile a Node-side fetch fallback.
 *
 * Its in-page fetch cannot read cross-origin assets that lack CORS headers —
 * which is most CDN-hosted fonts and images. Without this, those resources are
 * silently missing from the snapshot and the preview renders wrong.
 */
async function exposeFetchFallback(page: Page): Promise<void> {
  await page.exposeFunction(
    "__cuFetch",
    async (
      url: string,
      pageUrl: string,
    ): Promise<{ status: number; headers: [string, string][]; body: string }> => {
      try {
        // Pages are full of protocol-relative ("//cdn.example.com/x.jpg") and
        // root-relative ("/x.jpg") asset URLs. Node's fetch rejects both — it
        // has no document to resolve against. Left unresolved, every such asset
        // fails here, SingleFile keeps the original URL, and the "frozen"
        // snapshot quietly hotlinks back to the live site.
        const absolute = new URL(url, pageUrl).href;
        const response = await fetch(absolute, {
          headers: { referer: pageUrl },
          redirect: "follow",
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        return {
          status: response.status,
          headers: Array.from(response.headers.entries()),
          body: buffer.toString("base64"),
        };
      } catch {
        return { status: 500, headers: [], body: "" };
      }
    },
  );
}

async function inlineWithSingleFile(page: Page): Promise<string> {
  const { script } = await loadSingleFileBundle();
  await page.addScriptTag({ content: script });
  await page.evaluate(() => {
    (window as unknown as { __singlefileLoaded: boolean }).__singlefileLoaded = true;
  });

  await page.evaluate(() => {
    const w = window as unknown as {
      singlefile: { init: (o: unknown) => void };
      __cuFetch: (
        url: string,
        pageUrl: string,
      ) => Promise<{ status: number; headers: [string, string][]; body: string }>;
    };
    w.singlefile.init({
      fetch: async (url: string, options?: RequestInit) => {
        try {
          const response = await fetch(url, options);
          if (response.status < 400) return response;
        } catch {
          // fall through to the Node-side fetch
        }
        const relayed = await w.__cuFetch(url, document.baseURI);
        const bytes = Uint8Array.from(atob(relayed.body), (c) => c.charCodeAt(0));
        return new Response(bytes, {
          status: relayed.status,
          headers: relayed.headers,
        });
      },
    });
  });

  // Strip scripts only now: SingleFile's own bundle had to be present long
  // enough to declare its global, and the site's scripts had to run to produce
  // the render we are freezing.
  await page.evaluate(() => window.__copyUpdaterStripScripts());

  return page.evaluate(async (options) => {
    const w = window as unknown as {
      singlefile: { getPageData: (o: unknown) => Promise<{ content: string }> };
    };
    const data = await w.singlefile.getPageData(options);
    return data.content;
  }, SINGLE_FILE_OPTIONS);
}

export async function capturePage(options: CaptureOptions): Promise<CaptureResult> {
  const {
    url,
    viewportWidth = 1440,
    viewportHeight = 900,
    timeoutMs = 60_000,
    inlineTimeoutMs = 180_000,
    onProgress = () => {},
  } = options;

  const captureScript = await bundleBrowserScript("capture");

  let browser: Browser | null = null;
  try {
    onProgress("launching");
    browser = await chromium.launch({
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      deviceScaleFactor: 1,
      // Some sites serve a different DOM to headless UAs.
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    await exposeFetchFallback(page);

    // Transpilers that preserve function names (esbuild's keepNames, used by
    // tsx and some Next builds) emit __name() calls inside function bodies.
    // Playwright serialises evaluate callbacks as source, so those calls land
    // in a page that has no such helper. A no-op shim keeps evaluate working
    // regardless of how this file was compiled.
    await page.addInitScript({
      content: "globalThis.__name = globalThis.__name || function (f) { return f };",
    });

    // Must run before the page's own scripts: it records data SingleFile needs
    // that is otherwise lost once the page mutates itself.
    const { hookScript } = await loadSingleFileBundle();
    await page.addInitScript({ content: hookScript });

    onProgress("loading");
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    if (response && response.status() >= 400) {
      throw new Error(`Page returned HTTP ${response.status()}.`);
    }

    onProgress("settling");
    await settle(page, timeoutMs);

    // Stamp ids and extract before inlining, so the ids end up baked into the
    // stored snapshot and the boxes match what the screenshot shows.
    onProgress("extracting");
    await page.addScriptTag({ content: captureScript });
    const extraction = await page.evaluate(() => window.__copyUpdaterCapture());

    if (extraction.blocks.length === 0) {
      throw new Error(
        "No copy blocks found. The page may be behind a bot check or render nothing without JavaScript.",
      );
    }

    onProgress("screenshotting");
    const screenshot = await page.screenshot({ fullPage: true, type: "png" });

    // Built from the live DOM, before SingleFile rewrites it for serialisation.
    const skeleton = await page.evaluate(() => window.__copyUpdaterSkeleton());

    onProgress("inlining");
    const inlined = await withTimeout(
      inlineWithSingleFile(page),
      inlineTimeoutMs,
      `Inlining the page took longer than ${Math.round(inlineTimeoutMs / 1000)}s. ` +
        "The page may have an unusually large number of assets.",
    );
    const finalUrl = page.url();

    await context.close();

    // The preview runtime is deliberately not stored with the snapshot; it is
    // injected when the snapshot is served, so runtime fixes reach pages
    // captured before them. See lib/preview/inject.ts.
    return { html: inlined, skeleton, screenshot, extraction, finalUrl };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
