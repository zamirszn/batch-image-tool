// src/workers/imageProcessor.worker.ts

import { parseFilenameTemplate, getUniqueFilename } from '../utils/filenameUtils';
import { ImageFormat } from '../components/UploadDropzone'; // Re-import for type consistency

type FitOption = 'contain' | 'cover' | 'crop';

interface ProcessRequest {
  images: { file: File; id: string }[]; // Updated to include id
  options: {
    resize: {
      width: number;
      height: number;
      fit: FitOption;
    };
    borderRadius: number;
    format: ImageFormat;
    quality?: number;
    removeBackground?: boolean;
    filenameTemplate: string;
    presetName: string | null;
  };
}

interface ProcessedImageResult {
  blob: Blob;
  filename: string;
  width: number;
  height: number;
  size: number;
  originalId: string; // Add originalId to match results back
}

interface ProgressUpdateMessage {
  type: 'progress';
  processedCount: number;
  totalCount: number;
  imageName: string; // This is original name, not final filename
}

interface DoneMessage {
  type: 'done';
  results: ProcessedImageResult[];
}

type WorkerResponse = ProgressUpdateMessage | DoneMessage;

/**
 * Calculates the Euclidean distance between two RGB colors.
 */
const colorDistance = (r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number => {
    return Math.sqrt(Math.pow(r1 - r2, 2) + Math.pow(g1 - g2, 2) + Math.pow(b1 - b2, 2));
};

/**
 * Heuristically determines the background color by sampling the image edges.
 * It assumes the most common color on the border is the background.
 */
const getEdgeColor = (imageData: ImageData): [number, number, number] => {
    const { width, height, data } = imageData;
    const colorCounts: { [key: string]: number } = {};
    const samplePoints = [
        ...Array.from({ length: width }, (_, i) => i * 4), // Top edge
        ...Array.from({ length: width }, (_, i) => (height - 1) * width * 4 + i * 4), // Bottom edge
        ...Array.from({ length: height }, (_, i) => i * width * 4), // Left edge
        ...Array.from({ length: height }, (_, i) => i * width * 4 + (width - 1) * 4), // Right edge
    ];

    let maxCount = 0;
    let dominantColor: [number, number, number] = [255, 255, 255];

    for (const i of samplePoints) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const key = `${r},${g},${b}`;
        colorCounts[key] = (colorCounts[key] || 0) + 1;
        if (colorCounts[key] > maxCount) {
            maxCount = colorCounts[key];
            dominantColor = [r, g, b];
        }
    }
    return dominantColor;
};

/**
 * Removes the background of an image using a flood-fill algorithm from the edges.
 * @param ctx The OffscreenCanvas 2D rendering context.
 * @param width The canvas width.
 * @param height The canvas height.
 */
const removeImageBackground = (ctx: OffscreenCanvasRenderingContext2D, width: number, height: number) => {
    const imageData = ctx.getImageData(0, 0, width, height);
    const { data } = imageData;
    const [bgR, bgG, bgB] = getEdgeColor(imageData);
    const tolerance = 20; // Color distance tolerance

    const backgroundMask = new Uint8Array(width * height).fill(0); // 0 = foreground, 1 = background, 2 = feathered edge
    const queue: [number, number][] = [];

    // Add all edge pixels to the queue to start the flood fill
    for (let x = 0; x < width; x++) {
        queue.push([x, 0]);
        queue.push([x, height - 1]);
    }
    for (let y = 1; y < height - 1; y++) {
        queue.push([0, y]);
        queue.push([width - 1, y]);
    }
    
    // Mark initial queue as background
    queue.forEach(([x, y]) => backgroundMask[y * width + x] = 1);
    
    // Flood fill from the edges
    let head = 0;
    while(head < queue.length) {
        const [x, y] = queue[head++];
        
        // Check neighbors (N, S, E, W)
        const neighbors: [number, number][] = [[x, y - 1], [x, y + 1], [x - 1, y], [x + 1, y]];
        for(const [nx, ny] of neighbors) {
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                const index = ny * width + nx;
                if (backgroundMask[index] === 0) { // If not already visited
                    const dataIndex = index * 4;
                    const r = data[dataIndex];
                    const g = data[dataIndex + 1];
                    const b = data[dataIndex + 2];
                    if (colorDistance(r, g, b, bgR, bgG, bgB) < tolerance) {
                        backgroundMask[index] = 1;
                        queue.push([nx, ny]);
                    }
                }
            }
        }
    }

    // Feather the edges
    for (let i = 0; i < backgroundMask.length; i++) {
        if (backgroundMask[i] === 0) { // If it's a foreground pixel
            const x = i % width;
            const y = Math.floor(i / width);
            const neighbors: [number, number][] = [[x-1, y], [x+1, y], [x, y-1], [x, y+1]];
            for (const [nx, ny] of neighbors) {
                if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                    if (backgroundMask[ny * width + nx] === 1) {
                        backgroundMask[i] = 2; // Mark as feathered edge
                        break;
                    }
                }
            }
        }
    }
    
    // Apply the mask to the image data
    for (let i = 0; i < backgroundMask.length; i++) {
        const maskValue = backgroundMask[i];
        if (maskValue === 1) { // Background
            data[i * 4 + 3] = 0;
        } else if (maskValue === 2) { // Feathered Edge
            data[i * 4 + 3] = Math.floor(data[i * 4 + 3] * 0.5);
        }
    }
    
    ctx.putImageData(imageData, 0, 0);
};

self.onmessage = async (event: MessageEvent<ProcessRequest>) => {
  const { images, options } = event.data;
  const totalCount = images.length;
  const results: ProcessedImageResult[] = [];
  const timestamp = Date.now(); // Get timestamp once for the batch

  // Keep track of generated filenames to ensure uniqueness
  const generatedFilenames = new Set<string>();

  for (let i = 0; i < totalCount; i++) {
    const image = images[i]; // image now has { file: File, id: string }
    if (!image) continue;

    try {
      const bitmap = await createImageBitmap(image.file);
      const { resize, borderRadius, quality, removeBackground, filenameTemplate, presetName } = options;
      let { format } = options;

      // --- Canvas Setup ---
      const canvas = new OffscreenCanvas(resize.width, resize.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

      // --- 1. Resize & Fit ---
      const imgAspectRatio = bitmap.width / bitmap.height;
      const canvasAspectRatio = canvas.width / canvas.height;

      let sourceX = 0;
      let sourceY = 0;
      let sourceWidth = bitmap.width;
      let sourceHeight = bitmap.height;

      let destX = 0;
      let destY = 0;
      let destWidth = canvas.width;
      let destHeight = canvas.height;


      switch (resize.fit) {
        case 'contain':
            if (imgAspectRatio > canvasAspectRatio) { // Image is wider than canvas
                destHeight = canvas.width / imgAspectRatio;
                destY = (canvas.height - destHeight) / 2;
            } else { // Image is taller than canvas
                destWidth = canvas.height * imgAspectRatio;
                destX = (canvas.width - destWidth) / 2;
            }
            ctx.drawImage(bitmap, destX, destY, destWidth, destHeight);
            break;
        case 'cover':
            if (imgAspectRatio < canvasAspectRatio) { // Image is taller than canvas
                sourceWidth = bitmap.height * canvasAspectRatio;
                sourceX = (bitmap.width - sourceWidth) / 2;
            } else { // Image is wider than canvas
                sourceHeight = bitmap.width / canvasAspectRatio;
                sourceY = (bitmap.height - sourceHeight) / 2;
            }
            ctx.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
            break;
        case 'crop': // Behaves like cover in terms of source cropping, but then scales to fill
            if (imgAspectRatio > canvasAspectRatio) { // Image is wider than canvas
                sourceWidth = bitmap.height * canvasAspectRatio;
                sourceX = (bitmap.width - sourceWidth) / 2;
            } else { // Image is taller than canvas
                sourceHeight = bitmap.width / canvasAspectRatio;
                sourceY = (bitmap.height - sourceHeight) / 2;
            }
            ctx.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
            break;
        default: // Should not happen if fit is always one of the above
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            break;
      }

      // --- 2. Remove Background (if enabled) ---
      if (removeBackground) {
        removeImageBackground(ctx, canvas.width, canvas.height);
        // Force format to one that supports alpha transparency
        if (format === 'jpeg') {
          format = 'png';
        }
      }

      // --- 3. Rounded Corners ---
      if (borderRadius > 0) {
          ctx.globalCompositeOperation = 'destination-in';
          ctx.fillStyle = 'black';
          ctx.beginPath();
          ctx.moveTo(0, borderRadius);
          ctx.arcTo(0, 0, borderRadius, 0, borderRadius);
          ctx.lineTo(canvas.width - borderRadius, 0);
          ctx.arcTo(canvas.width, 0, canvas.width, borderRadius, borderRadius);
          ctx.lineTo(canvas.width, canvas.height - borderRadius);
          ctx.arcTo(canvas.width, canvas.height, canvas.width - borderRadius, canvas.height, borderRadius);
          ctx.lineTo(borderRadius, canvas.height);
          ctx.arcTo(0, canvas.height, 0, canvas.height - borderRadius, borderRadius);
          ctx.closePath();
          ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
      }

      // --- 5. Convert to Blob ---
      const blob = await canvas.convertToBlob({
        type: `image/${format}`,
        quality: quality ? quality / 100 : undefined,
      });

      if (blob) {
        // --- Generate Filename ---
        const baseFilename = parseFilenameTemplate(filenameTemplate, {
            originalName: image.file.name,
            outputWidth: canvas.width,
            outputHeight: canvas.height,
            outputFormat: format,
            presetName: presetName,
            timestamp: timestamp,
            index: i,
        });

        // Ensure unique filename within the current batch
        const finalFilename = getUniqueFilename(baseFilename, generatedFilenames);
        generatedFilenames.add(finalFilename); // Add to the set for future uniqueness checks

        const result: ProcessedImageResult = {
            blob,
            filename: finalFilename,
            width: canvas.width,
            height: canvas.height,
            size: blob.size,
            originalId: image.id, // Include originalId
        };
        results.push(result);

        self.postMessage({
          type: 'progress',
          processedCount: i + 1,
          totalCount,
          imageName: image.file.name, // Still sending original name for progress
        } as ProgressUpdateMessage);
      }
    } catch (error) {
      console.error('Error processing image:', image.file.name, error);
      // If an error occurs, we might still want to report progress or an error for this specific image
      // For now, it just logs and skips this image, meaning it won't be in `results`.
    }
  }

  self.postMessage({
    type: 'done',
    results,
  } as DoneMessage);
};