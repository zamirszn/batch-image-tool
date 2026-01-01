export const createImageWorker = (): Worker => {
  return new Worker(new URL("../workers/image.worker.ts", import.meta.url));
};