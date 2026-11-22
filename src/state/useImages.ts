import { useState } from 'react';
import { layerFromFile } from '../images';
import type { ImageLayer, ProjectUI } from '../model';
import type { Message, SetProject } from './types';

/** Image underlays: add, edit, delete, zoom, and the "adjust" mode (the only time an image can be moved). */
export function useImages(project: ProjectUI, setProject: SetProject, setMessage: (m: Message | undefined) => void) {
  const [adjustImageId, setAdjustImageId] = useState<string>();
  const [adjustPick, setAdjustPick] = useState('');
  /** The image the Adjust button works on (the chosen one, else the first). */
  const adjustTarget = project.images.find((im) => im.id === adjustPick) ?? project.images[0];

  const addImage = (layer: ImageLayer) => setProject((p) => ({ ...p, images: [...p.images, layer] }));
  const updateImage = (id: string, patch: Partial<ImageLayer>) => setProject((p) => ({ ...p, images: p.images.map((im) => (im.id === id ? { ...im, ...patch } : im)) }), `img:${id}`);
  const deleteImage = (id: string) => setProject((p) => ({ ...p, images: p.images.filter((im) => im.id !== id) }));

  const addImageFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      addImage(await layerFromFile(file, project.canvasW, project.canvasH));
      setMessage({ kind: 'info', text: `Added “${file.name}”. Press Adjust image to move or zoom it.` });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  /** Zoom an image about a canvas point (the pointer, or the image centre). */
  const zoomImage = (id: string, factor: number, cx: number, cy: number) =>
    setProject((p) => ({
      ...p,
      images: p.images.map((im) => {
        if (im.id !== id) return im;
        const f = Math.max(0.2, Math.min(5, factor));
        const width = Math.max(20, Math.min(20000, im.width * f));
        const k = width / im.width;
        return { ...im, width, height: im.height * k, x: Math.round(cx - (cx - im.x) * k), y: Math.round(cy - (cy - im.y) * k) };
      }),
    }), `imgzoom:${id}`);

  return { adjustImageId, setAdjustImageId, adjustPick, setAdjustPick, adjustTarget, addImage, updateImage, deleteImage, addImageFile, zoomImage };
}
