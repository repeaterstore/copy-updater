/**
 * Cropping the page screenshot to the copy actually being worked on.
 *
 * The stored screenshot is the whole page — 1440 × 10,590 and about 4 MB on
 * waveform.com's homepage. Sending that to rewrite one headline is expensive
 * and close to useless: the relevant copy is a few hundred pixels somewhere in
 * a very tall image. Every block carries the bounding box it occupied at
 * capture time, so the request can send just the region in question.
 */
import sharp from "sharp";
import type { Block } from "@/lib/ops/types";

/** Context kept around the scope so the model can see its surroundings. */
const PADDING = 120;

/**
 * A very tall section would put us back where we started, so the crop is
 * capped. Anything longer is trimmed from the bottom, keeping the top of the
 * section where the heading and lead copy live.
 */
const MAX_HEIGHT = 3000;

export interface CropBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Union of the blocks' capture-time boxes.
 *
 * Boxes are page coordinates: capture scrolls back to the top before measuring,
 * and the screenshot is full-page at the same device scale, so they line up
 * with the image without conversion.
 */
export function boundingBoxFor(blocks: Block[]): CropBox | null {
  const boxes = blocks.map((b) => b.box).filter((b): b is NonNullable<typeof b> => {
    return Boolean(b) && b!.w > 0 && b!.h > 0;
  });
  if (boxes.length === 0) return null;

  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));

  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Providers reject oversized images — the observed ceiling is 5 MB after base64
 * expansion, so the raw budget is roughly three quarters of that.
 */
const MAX_BYTES = 3_500_000;

/**
 * Crop to the given blocks, or return null when there is nothing to show.
 *
 * Null rather than the full page on purpose. Blocks inside collapsed menus have
 * no measured box, and answering "which region?" with "all 10,000 pixels of it"
 * sends several megabytes that tell the model nothing about the copy in
 * question — and can push the request past the provider's image limit, which
 * surfaces as a confusing failure rather than a missing picture.
 */
export async function cropToBlocks(
  screenshot: Buffer,
  blocks: Block[],
): Promise<Buffer | null> {
  const box = boundingBoxFor(blocks);
  if (!box) return null;

  try {
    const image = sharp(screenshot);
    const { width: imageWidth, height: imageHeight } = await image.metadata();
    if (!imageWidth || !imageHeight) return withinBudget(screenshot);

    const left = Math.max(0, Math.round(box.left - PADDING));
    const top = Math.max(0, Math.round(box.top - PADDING));
    const width = Math.min(imageWidth - left, Math.round(box.width + PADDING * 2));
    const height = Math.min(
      imageHeight - top,
      Math.min(MAX_HEIGHT, Math.round(box.height + PADDING * 2)),
    );

    if (width <= 0 || height <= 0) return withinBudget(screenshot);
    // Cropping to nearly the whole image is not worth the work.
    if (width * height > imageWidth * imageHeight * 0.9) return withinBudget(screenshot);

    const cropped = await sharp(screenshot)
      .extract({ left, top, width, height })
      .png()
      .toBuffer();
    return withinBudget(cropped);
  } catch {
    return withinBudget(screenshot);
  }
}

/**
 * Downscale until the image fits the provider budget, or give up on it.
 *
 * A tall section can still be large after cropping. Halving the resolution
 * keeps the layout legible, which is what the picture is for.
 */
async function withinBudget(image: Buffer): Promise<Buffer | null> {
  let current = image;
  for (let attempt = 0; attempt < 3 && current.length > MAX_BYTES; attempt += 1) {
    try {
      const { width } = await sharp(current).metadata();
      if (!width || width < 400) return null;
      current = await sharp(current)
        .resize({ width: Math.round(width / 2) })
        .png()
        .toBuffer();
    } catch {
      return null;
    }
  }
  return current.length > MAX_BYTES ? null : current;
}
