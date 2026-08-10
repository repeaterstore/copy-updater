/**
 * End-to-end test of the real pipeline: capture a page in a real browser, then
 * run the same resolve → diff → export path the app uses.
 *
 * Deliberately not mocked. The parts most likely to break — stamped ids
 * surviving inlining, the skeleton matching the snapshot, structural ops
 * resolving — only fail against a real capture.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { isAllowedEmail } from "@/auth.config";
import { capturePage } from "@/lib/capture/capture";
import { diffResolved } from "@/lib/ops/diff";
import { assignNewIds } from "@/lib/ops/ids";
import { resolveVersion } from "@/lib/ops/resolve.server";
import type { Op } from "@/lib/ops/types";
import { toCsv, toJson, toMarkdown, type ExportContext } from "@/lib/export";
import { injectRuntime } from "@/lib/preview/inject";
import { JSDOM } from "jsdom";

const FIXTURE = `<!doctype html>
<html><head>
  <title>Signal Booster — Acme</title>
  <meta name="description" content="Old meta description for the booster page.">
  <style>
    body { font-family: system-ui; margin: 0 }
    .hero { padding: 48px; background: #eef }
    .hero__title { font-size: 40px; margin: 0 0 12px }
    .btn { display: inline-block; padding: 12px 20px; background: #2f6fed; color: #fff }
    .features li { margin: 6px 0 }
  </style>
</head><body>
  <main>
    <section class="hero">
      <h1 class="hero__title">Fast <em>signal</em> boosters</h1>
      <p class="hero__sub">Boost your signal with a <a href="/shop">booster</a> today.</p>
      <a class="btn" href="/buy">Buy now</a>
    </section>
    <section class="features">
      <h2>Why choose us</h2>
      <ul>
        <li>Free shipping on every order</li>
        <li>Two year warranty included</li>
      </ul>
    </section>
  </main>
</body></html>`;

async function withFixtureServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  let server: Server | undefined;
  try {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(FIXTURE);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    return await fn(`http://127.0.0.1:${port}/`);
  } finally {
    server?.close();
  }
}

test("email allowlist accepts the team's domains and nothing else", () => {
  const previous = process.env.ALLOWED_EMAIL_DOMAINS;
  process.env.ALLOWED_EMAIL_DOMAINS = "waveform.com,rsrf.com";

  assert.equal(isAllowedEmail("sina@waveform.com"), true);
  assert.equal(isAllowedEmail("someone@rsrf.com"), true);
  assert.equal(isAllowedEmail("SINA@WAVEFORM.COM"), true);
  assert.equal(isAllowedEmail("attacker@gmail.com"), false);
  assert.equal(isAllowedEmail("attacker@notwaveform.com"), false);
  // A subdomain is a different domain, and must not slip through.
  assert.equal(isAllowedEmail("x@evil.waveform.com"), false);
  // The classic bypass: the allowed domain in the local part.
  assert.equal(isAllowedEmail("waveform.com@evil.com"), false);
  assert.equal(isAllowedEmail(null), false);
  assert.equal(isAllowedEmail("no-at-sign"), false);

  process.env.ALLOWED_EMAIL_DOMAINS = previous;
});

test("capture → resolve → diff → export round trip", { timeout: 180_000 }, async () => {
  const captured = await withFixtureServer((url) => capturePage({ url }));

  // --- capture ---------------------------------------------------------
  assert.ok(captured.extraction.blocks.length >= 6, "found the page's copy");
  assert.equal(captured.extraction.meta.title, "Signal Booster — Acme");
  assert.match(captured.extraction.meta.description ?? "", /Old meta description/);

  // The stored snapshot carries no scripts at all: the site's are stripped so a
  // framework cannot rehydrate and destroy the stamped ids, and the preview
  // runtime is injected when the snapshot is served rather than baked in, so
  // runtime fixes reach snapshots captured before them.
  const scriptTags = captured.html.match(/<script/gi) ?? [];
  assert.equal(scriptTags.length, 0, "stored snapshot contains no scripts");
  assert.equal(captured.html.includes("data-cu-runtime"), false);

  // Scripts that survive capture — inside templates or shadow roots, or
  // re-inserted while the page serialises — are removed on the way out too.
  const polluted = captured.html.replace(
    "</body>",
    '<script src="https://evil.example.com/x.js"></script>' +
      "<script>window.__CF$cv$params={}</script></body>",
  );
  assert.equal((polluted.match(/<script/gi) ?? []).length, 2);
  const cleaned = injectRuntime(polluted, "window.__previewRuntime = 1;");
  assert.equal((cleaned.match(/<script/gi) ?? []).length, 1, "third-party scripts stripped at serve time");
  assert.equal(cleaned.includes("evil.example.com"), false);
  assert.equal(cleaned.includes("__CF$cv$params"), false);

  const served = injectRuntime(captured.html, "window.__previewRuntime = 1;");
  assert.equal((served.match(/<script/gi) ?? []).length, 1, "exactly one script when served");
  assert.match(served, /data-cu-runtime/);
  assert.ok(served.indexOf("data-cu-runtime") < served.lastIndexOf("</body>"), "runtime sits inside body");

  // Serving twice must not accumulate runtimes, and an older snapshot that
  // still has one embedded must have it replaced rather than duplicated.
  const reserved = injectRuntime(served, "window.__previewRuntime = 2;");
  assert.equal((reserved.match(/<script/gi) ?? []).length, 1, "old runtime replaced, not duplicated");
  assert.match(reserved, /__previewRuntime = 2/);
  assert.equal(reserved.includes("__previewRuntime = 1"), false);

  // CSS is inlined, so the snapshot renders without the origin.
  assert.match(captured.html, /hero__title/);
  assert.ok(captured.screenshot.length > 1000, "screenshot captured");

  // The skeleton must describe the same document as the snapshot.
  assert.ok(
    captured.skeleton.length < captured.html.length,
    "skeleton is smaller than the snapshot",
  );

  const blocks = captured.extraction.blocks;
  const h1 = blocks.find((b) => b.tag === "h1")!;
  const sub = blocks.find((b) => b.text.startsWith("Boost your signal"))!;
  const cta = blocks.find((b) => b.text === "Buy now")!;
  const warranty = blocks.find((b) => b.text.includes("Two year warranty"))!;
  const shipping = blocks.find((b) => b.text.includes("Free shipping"))!;

  assert.equal(h1.role, "heading");
  assert.equal(cta.role, "link");
  assert.equal(warranty.role, "listitem");
  assert.equal(warranty.sectionLabel, "Why choose us");
  // A paragraph with a link inside stays a single editable block.
  assert.match(sub.html, /<a[\s\S]*?>booster<\/a>/);
  // Boxes come from a real layout pass.
  assert.ok((h1.box?.w ?? 0) > 0 && (h1.box?.h ?? 0) > 0, "h1 was measured");

  // --- baseline vs v1 (copy only) --------------------------------------
  const baseline = resolveVersion(captured.skeleton, []).resolved;
  assert.equal(
    baseline.blocks.length,
    blocks.length,
    "skeleton yields the same block count as the live capture",
  );

  const v1Ops: Op[] = [
    { t: "setText", id: h1.id, html: "Faster <em>signal</em> boosters" },
    {
      t: "setMeta",
      title: "5G Signal Boosters that actually work | Acme",
      description: "Fix dropped calls at home or on the road with a booster built for 5G.",
    },
  ];
  const v1 = resolveVersion(captured.skeleton, v1Ops);
  assert.equal(v1.failures.length, 0, "copy ops applied cleanly");

  const d1 = diffResolved(baseline, v1.resolved);
  assert.equal(d1.counts.changed, 1);
  assert.equal(d1.counts.added, 0);
  assert.equal(d1.meta.length, 2);
  assert.ok(
    d1.blocks.find((c) => c.id === h1.id)?.words?.some((w) => w.added),
    "word-level diff produced",
  );

  // --- v1 vs v2 (structural) -------------------------------------------
  const dom = new JSDOM("<!doctype html><body></body>");
  const newBullet = assignNewIds(dom.window.document, "<li>Free returns for 30 days</li>");

  const v2Ops: Op[] = [
    ...v1Ops,
    { t: "insert", refId: warranty.id, pos: "after", html: newBullet },
    { t: "remove", id: shipping.id },
    { t: "move", id: cta.id, refId: h1.id, pos: "before" },
    { t: "setAttr", id: cta.id, name: "href", value: "/checkout" },
    { t: "addStyle", css: ".hero__title { font-size: 52px }" },
  ];
  const v2 = resolveVersion(captured.skeleton, v2Ops);
  assert.equal(v2.failures.length, 0, `structural ops applied: ${JSON.stringify(v2.failures)}`);

  const d2 = diffResolved(v1.resolved, v2.resolved);
  assert.equal(d2.counts.added, 1, "the new bullet is reported as added");
  assert.equal(d2.counts.removed, 1, "the deleted bullet is reported as removed");
  assert.equal(d2.counts.moved, 1, "the moved CTA is reported as moved, not re-added");
  assert.deepEqual(d2.stylesAdded, [".hero__title { font-size: 52px }"]);
  assert.ok(
    v2.resolved.blocks.find((b) => b.text === "Free returns for 30 days"),
    "inserted copy is present in the resolved state",
  );

  // Every id that survived must be unchanged — inserts must not renumber.
  for (const block of v1.resolved.blocks) {
    if (block.id === shipping.id) continue;
    assert.ok(
      v2.resolved.blocks.find((b) => b.id === block.id),
      `id ${block.id} survived the structural edit`,
    );
  }

  // Replaying the same ops must produce byte-identical output.
  const replay = resolveVersion(captured.skeleton, v2Ops);
  assert.deepEqual(replay.resolved.blocks, v2.resolved.blocks, "resolve is deterministic");

  // --- export ----------------------------------------------------------
  const context: ExportContext = {
    pageName: "Signal Booster",
    pageUrl: "https://example.com/booster",
    versionLabel: "Copy pass",
    versionStatus: "approved",
    author: "copy@waveform.com",
    generatedAt: "2026-08-04T00:00:00.000Z",
  };

  const md = toMarkdown(diffResolved(baseline, v2.resolved), context);
  assert.match(md, /# Copy changes — Signal Booster/);
  assert.match(md, /Faster signal boosters/);
  assert.match(md, /5G Signal Boosters that actually work/);
  assert.match(md, /Added listitem/);
  assert.match(md, /Removed listitem/);
  assert.match(md, /## CSS added/);

  const csv = toCsv(diffResolved(baseline, v2.resolved), context);
  const header = csv.split("\n")[0];
  assert.match(header, /"section","kind","role"/);
  // Copy containing commas and quotes must not break the row structure.
  const columns = csv.split("\n")[1].match(/(?:^|,)("(?:[^"]|"")*")/g) ?? [];
  assert.ok(columns.length >= 8, "CSV rows are properly quoted");

  const json = JSON.parse(toJson(diffResolved(baseline, v2.resolved), context));
  assert.equal(json.page.name, "Signal Booster");
  assert.ok(json.blocks.length >= 3);
  assert.ok(json.meta.find((m: { field: string }) => m.field === "title"));
  assert.deepEqual(json.stylesAdded, [".hero__title { font-size: 52px }"]);
});
