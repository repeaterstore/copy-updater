import { writeFile } from "node:fs/promises";
import { capturePage } from "@/lib/capture/capture";

const url = process.argv[2] ?? "https://example.com";
const out = process.argv[3] ?? "/tmp/cap";

const started = Date.now();
const t0 = Date.now();
const result = await capturePage({
  url,
  onProgress: (stage) => console.log(`  [${((Date.now()-t0)/1000).toFixed(1)}s] ${stage}`),
});
const seconds = ((Date.now() - started) / 1000).toFixed(1);

await writeFile(`${out}.html`, result.html);
await writeFile(`${out}.skeleton.html`, result.skeleton);
await writeFile(`${out}.png`, result.screenshot);

const { blocks, meta, cssIndex } = result.extraction;
console.log(`captured ${url} in ${seconds}s -> ${result.finalUrl}`);
console.log(`  snapshot   ${(result.html.length / 1e6).toFixed(2)} MB`);
console.log(`  skeleton   ${(result.skeleton.length / 1e6).toFixed(2)} MB`);
console.log(`  screenshot ${(result.screenshot.length / 1e6).toFixed(2)} MB`);
console.log(`  blocks     ${blocks.length}`);
console.log(`  meta       title=${JSON.stringify(meta.title)}`);
console.log(`             desc=${JSON.stringify(meta.description?.slice(0, 70))}`);
console.log(`  cssIndex   ${Object.keys(cssIndex).length} entries`);
console.log("\n  first 12 blocks:");
for (const b of blocks.slice(0, 12)) {
  console.log(
    `   [${b.role.padEnd(9)}] ${b.tag.padEnd(6)} ${JSON.stringify(b.text.slice(0, 58))}` +
      ` ${b.box ? `@${b.box.w}x${b.box.h}` : ""}`,
  );
}
const withRuntime = result.html.includes("data-cu-runtime");
const withIds = (result.html.match(/data-cu-id=/g) ?? []).length;
console.log(`\n  runtime injected: ${withRuntime}`);
console.log(`  data-cu-id attrs in snapshot: ${withIds}`);
