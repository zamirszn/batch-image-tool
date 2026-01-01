// src/workers/image.worker.ts
import { removeBackground, type Config } from "@imgly/background-removal";


const progress: NonNullable<Config["progress"]> = (
  key: string,
  current: number,
  total: number
) => {
  self.postMessage({
    type: "model-load-progress",
    key,
    current,
    total,
  });
};

// --- Type Definitions ---
type FitOption = 'contain' | 'cover' | 'crop';
type ImageFormat = 'jpeg' | 'png' | 'webp';

interface ResizeOptions {
  width: number;
  height: number;
  fit: FitOption;
}

interface ProcessOptions {
  resize?: ResizeOptions;
  borderRadius?: number;
  format: ImageFormat;
  quality?: number; // 0-100 for jpeg/webp
  removeBackground?: boolean;
  filenameTemplate?: string;
  presetName?: string;
}

// --- Worker Communication Types ---
interface ProcessedImageResult {
  blob: Blob;
  filename: string;
  width: number;
  height: number;
  size: number;
  originalId: string;
}

interface WorkerMessage {
  images: { file: File; id: string }[];
  options: ProcessOptions;
}

// --- Main Worker Logic ---
self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { images, options } = e.data;
  const finalResults: ProcessedImageResult[] = [];
  const totalCount = images.length;
  let processedCount = 0;

  for (const image of images) {
    try {
      let processedFile: File | Blob = image.file;

      // Remove background if requested using Imgly
      if (options.removeBackground) {
        processedFile = await removeBackground(image.file, {
          model: "isnet_quint8",
          progress,
        });
      }


      const imageBitmap = await createImageBitmap(processedFile);

      const canvasWidth = options.resize?.width ?? imageBitmap.width;
      const canvasHeight = options.resize?.height ?? imageBitmap.height;

      const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;

      // Determine effective format
      let effectiveFormat = options.format;
      if (options.removeBackground && effectiveFormat === 'jpeg') effectiveFormat = 'png';

      // Fill background if JPEG (no transparency)
      if (effectiveFormat === 'jpeg') {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
      } else {
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      }

      // Apply rounded corners as clipping
      if (options.borderRadius && options.borderRadius > 0) {
        drawRoundedRectPath(ctx, canvasWidth, canvasHeight, options.borderRadius);
        ctx.clip();
      }

      // Draw image with fit & crop
      const { sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight } = calculateDrawDimensions(
        imageBitmap.width, imageBitmap.height,
        canvasWidth, canvasHeight,
        options.resize?.fit ?? 'cover'
      );
      ctx.drawImage(imageBitmap, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight);

      // Encode final image
      const blob = await canvas.convertToBlob({
        type: `image/${effectiveFormat}`,
        quality: effectiveFormat === 'png' ? undefined : options.quality ? options.quality / 100 : undefined,
      });

      if (!blob) continue;
      processedCount++;

      const filename = generateFileName(
        image.file.name,
        image.id,
        processedCount,
        options.filenameTemplate,
        effectiveFormat,
        canvas.width,
        canvas.height,
        options.presetName
      );

      finalResults.push({
        blob,
        filename,
        width: canvas.width,
        height: canvas.height,
        size: blob.size,
        originalId: image.id,
      });

      self.postMessage({
        type: 'progress',
        processedCount,
        totalCount,
        imageName: image.file.name,
      });
    } catch (err) {
      console.error(`Failed to process image: ${image.file.name}`, err);
    }
  }

  self.postMessage({ type: 'done', results: finalResults });
};

// --- Helper Functions ---
function generateFileName(
  originalName: string,
  originalId: string,
  index: number,
  template: string = "{name}_{index}",
  format: ImageFormat,
  width: number,
  height: number,
  presetName?: string
): string {
  const nameWithoutExt = originalName.split('.').slice(0, -1).join('.');
  const ratio = (width / height).toFixed(2);
  const timestamp = Date.now();

  let fileName = template
    .replace(/{name}/g, nameWithoutExt)
    .replace(/{ext}/g, format)
    .replace(/{index}/g, index.toString())
    .replace(/{width}/g, width.toString())
    .replace(/{height}/g, height.toString())
    .replace(/{ratio}/g, ratio)
    .replace(/{preset}/g, presetName || '')
    .replace(/{timestamp}/g, timestamp.toString());

  if (!fileName.endsWith(`.${format}`)) {
    fileName = `${fileName}.${format}`;
  }

  return fileName;
}

function drawRoundedRectPath(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number, radius: number) {
  radius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(width - radius, 0);
  ctx.quadraticCurveTo(width, 0, width, radius);
  ctx.lineTo(width, height - radius);
  ctx.quadraticCurveTo(width, height, width - radius, height);
  ctx.lineTo(radius, height);
  ctx.quadraticCurveTo(0, height, 0, height - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();
}

function calculateDrawDimensions(
  imgWidth: number, imgHeight: number, canvasWidth: number, canvasHeight: number, fit: FitOption
) {
  const imgAspect = imgWidth / imgHeight;
  const canvasAspect = canvasWidth / canvasHeight;
  let sx = 0, sy = 0, sWidth = imgWidth, sHeight = imgHeight;
  let dx = 0, dy = 0, dWidth = canvasWidth, dHeight = canvasHeight;

  switch (fit) {
    case 'cover':
    case 'crop':
      if (imgAspect > canvasAspect) {
        sWidth = imgHeight * canvasAspect;
        sx = (imgWidth - sWidth) / 2;
      } else {
        sHeight = imgWidth / canvasAspect;
        sy = (imgHeight - sHeight) / 2;
      }
      break;
    case 'contain':
      if (imgAspect > canvasAspect) {
        dHeight = canvasWidth / imgAspect;
        dy = (canvasHeight - dHeight) / 2;
      } else {
        dWidth = canvasHeight * imgAspect;
        dx = (canvasWidth - dWidth) / 2;
      }
      break;
  }
  return { sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight };
}
