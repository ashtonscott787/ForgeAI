/**
 * Turning a photograph into an avatar.
 *
 * A picture chosen from a phone is several megabytes and several thousand
 * pixels across. Storing that in an agent's record would put it in every
 * export and every backup for no benefit, so it is drawn down to a square
 * the size it is actually displayed at before it is kept.
 *
 * The drawing happens here rather than in the main process because a canvas
 * is what does it, and the renderer is where the canvas is.
 */

/** The side of the stored square, in pixels. Twice the 52px it is drawn at. */
export const SIDE = 128;

/** The largest file worth opening at all. */
export const MAX_INPUT_BYTES = 12 * 1024 * 1024;

export const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];

/**
 * Reads a chosen file and returns a small square WebP data URL.
 *
 * Rejects rather than guesses: a file that is not an image this app draws,
 * or one too large to be a photograph anybody meant to pick, comes back as an
 * error with a sentence saying which.
 */
export async function shrinkToAvatar(file: File, side = SIDE): Promise<string> {
  if (!ACCEPTED.includes(file.type)) {
    throw new Error("That needs to be a PNG, JPEG or WebP image.");
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error("That image is larger than 12 MB. Pick a smaller one.");
  }

  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That file could not be opened as an image.");
  });

  try {
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This machine could not draw the image.");

    // Centre-crop to a square first, so a portrait photograph is not squashed.
    const edge = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - edge) / 2;
    const sy = (bitmap.height - edge) / 2;
    ctx.drawImage(bitmap, sx, sy, edge, edge, 0, 0, side, side);

    const url = canvas.toDataURL("image/webp", 0.82);
    // Some browsers quietly hand back a PNG when WebP is unavailable. Either
    // is fine; what matters is that it really is one of the kinds accepted.
    if (!/^data:image\/(webp|png|jpeg);base64,/.test(url)) {
      throw new Error("The image could not be converted.");
    }
    return url;
  } finally {
    bitmap.close?.();
  }
}
