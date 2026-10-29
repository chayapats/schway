import { createHash } from "node:crypto";
import type { ImageContent, ConversationItem, UserContent } from "./types.ts";

/** Maximum images admitted in one user input. */
export const MAX_INPUT_IMAGES = 5;
/** Maximum encoded bytes in one sanitized image. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Maximum width or height of an embedder's model derivative. */
export const MAX_IMAGE_DIMENSION = 2048;
/** Maximum pixels in one model derivative. */
export const MAX_IMAGE_PIXELS = 2048 * 2048;
/** Maximum image parts resolved in one provider request, including replay. */
export const MAX_REQUEST_IMAGES = 50;
/** Maximum aggregate encoded image bytes resolved in one provider request. */
export const MAX_REQUEST_IMAGE_BYTES = 50 * 1024 * 1024;

/** Typed image validation failure without image bytes, references or decoder diagnostics. */
export class HostImageError extends Error {
  constructor(readonly code: "image-count-limit" | "image-byte-limit" | "image-pixel-limit" | "invalid-image" | "images-unavailable" | "images-unsupported") {
    super(`Image input rejected: ${code}`);
    this.name = "HostImageError";
  }
}

/** Validate a byte-free image reference, rejecting unknown fields and unsupported formats. */
export function validateImageContent(value: unknown): asserts value is ImageContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostImageError("invalid-image");
  const image = value as ImageContent;
  if (Object.keys(image).some(key => !["type", "reference", "mediaType", "byteLength", "width", "height", "sha256"].includes(key)) ||
      image.type !== "image" || typeof image.reference !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/.test(image.reference) ||
      !["image/png", "image/jpeg"].includes(image.mediaType) || typeof image.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(image.sha256)) throw new HostImageError("invalid-image");
  if (!Number.isSafeInteger(image.byteLength) || image.byteLength < 1) throw new HostImageError("invalid-image");
  if (image.byteLength > MAX_IMAGE_BYTES) throw new HostImageError("image-byte-limit");
  if (![image.width, image.height].every(n => Number.isSafeInteger(n) && n > 0)) throw new HostImageError("invalid-image");
  if (image.width > MAX_IMAGE_DIMENSION || image.height > MAX_IMAGE_DIMENSION || image.width * image.height > MAX_IMAGE_PIXELS) throw new HostImageError("image-pixel-limit");
}

/** Copy and validate at most five byte-free input references before native acceptance. */
export function inputImages(value: unknown): ImageContent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HostImageError("invalid-image");
  if (value.length > MAX_INPUT_IMAGES) throw new HostImageError("image-count-limit");
  return Array.from(value, image => { validateImageContent(image); return { ...image }; });
}

/** Collect and bound all image references before resolving any provider-request bytes. */
export function requestImages(items: readonly ConversationItem[]): ImageContent[] {
  const images = items.flatMap(item => item.type === "user" ? item.content.filter(block => block.type === "image") : []);
  if (images.length > MAX_REQUEST_IMAGES) throw new HostImageError("image-count-limit");
  for (const image of images) validateImageContent(image);
  if (images.reduce((sum, image) => sum + image.byteLength, 0) > MAX_REQUEST_IMAGE_BYTES) throw new HostImageError("image-byte-limit");
  return images;
}

/** Build a byte-free reference from already sanitized bytes, inspecting only bounded PNG/JPEG headers. */
export function createImageContent(reference: string, mediaType: ImageContent["mediaType"], data: Uint8Array): ImageContent {
  if (!(data instanceof Uint8Array) || !data.byteLength || !["image/png", "image/jpeg"].includes(mediaType)) throw new HostImageError("invalid-image");
  if (data.byteLength > MAX_IMAGE_BYTES) throw new HostImageError("image-byte-limit");
  const [width, height] = dimensions(data, mediaType);
  const image: ImageContent = { type: "image", reference, mediaType, byteLength: data.byteLength, width, height,
    sha256: createHash("sha256").update(data).digest("hex") };
  validateImageContent(image);
  return image;
}

/** Require exact content identity and dimensions on every fresh resolver result. */
export function validateImageBytes(image: ImageContent, data: Uint8Array): void {
  const actual = createImageContent(image.reference, image.mediaType, data);
  if (actual.sha256 !== image.sha256 || actual.byteLength !== image.byteLength || actual.width !== image.width || actual.height !== image.height) throw new HostImageError("images-unavailable");
}

/** Map one user part to Responses input, refusing unresolved bytes rather than omitting images. */
export function imageInputPart(block: UserContent, imageData?: ReadonlyMap<string, Uint8Array>):
  { type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "high" } {
  if (block.type === "text") return { type: "input_text", text: block.text };
  validateImageContent(block);
  const data = imageData?.get(block.sha256);
  if (!data) throw new HostImageError("images-unavailable");
  validateImageBytes(block, data);
  return { type: "input_image", image_url: `data:${block.mediaType};base64,${Buffer.from(data).toString("base64")}`, detail: "high" };
}

function dimensions(data: Uint8Array, mediaType: ImageContent["mediaType"]): [number, number] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (mediaType === "image/png") {
    if (data.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => data[i] === n) ||
        view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new HostImageError("invalid-image");
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new HostImageError("invalid-image");
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset++] !== 0xff) break;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9 || offset + 2 > data.length) break;
    const size = view.getUint16(offset);
    if (size < 2 || offset + size > data.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
    offset += size;
  }
  throw new HostImageError("invalid-image");
}
