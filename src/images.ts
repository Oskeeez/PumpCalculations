import type { ImageLayer } from './model';

export interface LoadedImage {
  dataUrl: string;
  width: number;
  height: number;
}

const MAX_FILE_BYTES = 25_000_000;

/**
 * Read an image file into a data URL, downscaled so its longest side is at most `maxSide` pixels.
 * Keeps the project file and autosave small.
 */
export async function loadImageFile(file: File, maxSide = 2000): Promise<LoadedImage> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (PNG, JPEG, WebP, GIF or SVG).');
  if (file.size > MAX_FILE_BYTES) throw new Error('The image is larger than 25 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('The image could not be read.'));
      img.src = url;
    });
    const nw = img.naturalWidth || 800;
    const nh = img.naturalHeight || 600;
    const k = Math.min(1, maxSide / Math.max(nw, nh));
    const width = Math.max(1, Math.round(nw * k));
    const height = Math.max(1, Math.round(nh * k));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('The image could not be processed.');
    ctx.drawImage(img, 0, 0, width, height);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    return { dataUrl: canvas.toDataURL(type, 0.88), width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A new image layer for a file, sized to fit the canvas, semi-transparent and placed at the top-left. */
export async function layerFromFile(file: File, canvasW: number, canvasH: number): Promise<ImageLayer> {
  const img = await loadImageFile(file);
  const k = Math.min(1, canvasW / img.width, canvasH / img.height);
  return { id: `img${Date.now()}`, name: file.name, dataUrl: img.dataUrl, x: 0, y: 0, width: Math.round(img.width * k), height: Math.round(img.height * k), opacity: 0.6, locked: false };
}
