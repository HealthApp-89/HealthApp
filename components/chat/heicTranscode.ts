// components/chat/heicTranscode.ts
//
// Convert a picked File to JPEG via Canvas. iOS Safari delivers HEIC from the
// camera roll for iPhone 12+ defaults. Anthropic + the server-side MIME
// allowlist accept JPEG/PNG/WebP only, so we transcode client-side.
//
// Throws on any decode error — caller surfaces a per-thumbnail error.

export async function transcodeToJpeg(file: File, quality = 0.9): Promise<File> {
  // Fast path: already a supported format and below the size budget.
  if (
    (file.type === "image/jpeg" || file.type === "image/png" || file.type === "image/webp") &&
    file.size <= 4 * 1024 * 1024
  ) {
    return file;
  }

  // Try createImageBitmap first (broad support, fast). On iOS Safari it does
  // NOT decode HEIC — fall back to <img>, which Safari does decode for display.
  let width: number;
  let height: number;
  let drawSource: CanvasImageSource;
  let bitmapToClose: ImageBitmap | null = null;

  try {
    const bitmap = await createImageBitmap(file);
    width = bitmap.width;
    height = bitmap.height;
    drawSource = bitmap;
    bitmapToClose = bitmap;
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("decode_failed"));
        el.src = url;
      });
      width = img.naturalWidth;
      height = img.naturalHeight;
      drawSource = img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas_unsupported");
  ctx.drawImage(drawSource, 0, 0);
  bitmapToClose?.close();

  const blob: Blob | null = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality),
  );
  if (!blob) throw new Error("encode_failed");

  return new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" });
}
