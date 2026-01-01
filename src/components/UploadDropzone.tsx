"use client";

import { useCallback, useState, useEffect } from "react";
import { useDropzone } from "react-dropzone";
import { createImageWorker } from "@utils/imageWorker";
import JSZip from "jszip";
import { saveAs } from "file-saver";

// --- Type Definitions ---

type ImageFormat = 'jpeg' | 'png' | 'webp';
type FitOption = 'contain' | 'cover' | 'crop';

type ImageState = {
  id: string; // Unique ID for stable keys and removal
  originalFile: File;
  originalPreview: string;
  processedBlob?: Blob;
  currentPreview: string;
  // New fields for processed image info
  processedFileName?: string;
  processedSize?: number;
  processedWidth?: number;
  processedHeight?: number;
  processedFormat?: ImageFormat; // Stores the actual format after processing (e.g., if JPEG forced to PNG)
};

interface Preset {
  name: string;
  width: number;
  height: number;
  fit: FitOption;
  radius?: number;
}

// --- Worker Communication Types ---
// Update this to match the worker's output
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
  imageName: string;
}

interface ModelLoadProgressMessage {
  type: 'model-load-progress';
  key: string;
  current: number;
  total: number;
}

interface DoneMessage {
  type: 'done';
  results: ProcessedImageResult[];
}

type WorkerResponse = ProgressUpdateMessage | DoneMessage | ModelLoadProgressMessage;

// --- Constants ---
const defaultOptions = {
    resizeDimensions: { width: 512, height: 512 },
    borderRadius: 0,
    format: 'jpeg' as ImageFormat,
    quality: 90,
    fitOption: 'cover' as FitOption,

    removeBackground: false,
    filenameTemplate: "{name}_{index}",
};

const presets: Record<string, Record<string, Preset>> = {
  "App Icons": {
    ios: { name: "iOS App Icon", width: 1024, height: 1024, fit: 'contain', radius: 0 },
    android_play: { name: "Android Play Store", width: 512, height: 512, fit: 'contain', radius: 0 },
    android_fg: { name: "Android Adaptive (FG)", width: 432, height: 432, fit: 'contain', radius: 0 },
    android_bg: { name: "Android Adaptive (BG)", width: 432, height: 432, fit: 'cover', radius: 0 },
  },
  "Social Media": {
    instagram_post: { name: "Instagram Post", width: 1080, height: 1080, fit: 'cover' },
    instagram_story: { name: "Instagram Story / Reel", width: 1080, height: 1920, fit: 'cover' },
    twitter_post: { name: "Twitter/X Post", width: 1200, height: 675, fit: 'cover' },
    facebook_post: { name: "Facebook Post", width: 1200, height: 630, fit: 'cover' },
    linkedin_post: { name: "LinkedIn Post", width: 1200, height: 627, fit: 'cover' },
    youtube_thumb: { name: "YouTube Thumbnail", width: 1280, height: 720, fit: 'cover' },
  },
};

// --- Component ---

export default function UploadDropzone() {
  const [images, setImages] = useState<ImageState[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [overallProgress, setOverallProgress] = useState(0);
  const [processedImageNames, setProcessedImageNames] = useState<Set<string>>(new Set());
  const [modelLoadProgress, setModelLoadProgress] = useState<{ current: number, total: number } | null>(null);
  const [showModelConfirm, setShowModelConfirm] = useState(false);
  const [deferredProcess, setDeferredProcess] = useState<(() => void) | null>(null);

  // Options State
  const [resizeDimensions, setResizeDimensions] = useState<{ width: number, height: number }>(defaultOptions.resizeDimensions);
  const [borderRadius, setBorderRadius] = useState(defaultOptions.borderRadius);
  const [format, setFormat] = useState<ImageFormat>(defaultOptions.format);
  const [quality, setQuality] = useState(defaultOptions.quality);
  const [fitOption, setFitOption] = useState<FitOption>(defaultOptions.fitOption);

  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [removeBackground, setRemoveBackground] = useState(defaultOptions.removeBackground);
  const [filenameTemplate, setFilenameTemplate] = useState<string>(defaultOptions.filenameTemplate);
  const [showInfoModal, setShowInfoModal] = useState<boolean>(false); // New state for info modal

  const toggleInfoModal = () => setShowInfoModal(prev => !prev);


  const onDrop = useCallback((acceptedFiles: File[]) => {
    const newImages = acceptedFiles.map((file) => {
        const previewUrl = URL.createObjectURL(file);
        return {
            id: `${file.name}-${file.lastModified}-${Math.random()}`, // Create a reasonably unique ID
            originalFile: file,
            originalPreview: previewUrl,
            currentPreview: previewUrl,
        };
    });
    setImages((prev) => [...prev, ...newImages]);
  }, []);

  const removeImage = (idToRemove: string) => {
    setImages((prev) => {
      const imageToRemove = prev.find(img => img.id === idToRemove);
      if (imageToRemove) {
        URL.revokeObjectURL(imageToRemove.originalPreview);
        if (imageToRemove.originalPreview !== imageToRemove.currentPreview) {
            URL.revokeObjectURL(imageToRemove.currentPreview);
        }
      }
      return prev.filter((img) => img.id !== idToRemove);
    });
  };

  const clearAll = () => {
    images.forEach((img) => {
        URL.revokeObjectURL(img.originalPreview);
        if (img.originalPreview !== img.currentPreview) {
            URL.revokeObjectURL(img.currentPreview);
        }
    });
    setImages([]);
    setOverallProgress(0);
    setProcessedImageNames(new Set());
  };

  useEffect(() => {
    return () => {
      images.forEach((img) => {
        URL.revokeObjectURL(img.originalPreview);
        if (img.currentPreview && img.currentPreview !== img.originalPreview) {
          URL.revokeObjectURL(img.currentPreview);
        }
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // empty deps → only runs on unmount
  

  const { getRootProps, getInputProps, isDragActive } = useDropzone({ accept: { "image/*": [] }, onDrop, disabled: isProcessing });

  // --- Handlers ---
  const handleDimensionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSelectedPreset(null);
    const { name, value } = e.target;
    if (value === "") {
        setResizeDimensions(prev => ({ ...prev, [name]: 0 }));
    } else {
        const numValue = parseInt(value, 10);
        if (!isNaN(numValue)) {
            setResizeDimensions(prev => ({ ...prev, [name]: numValue }));
        }
    }
  };
  const handleBorderRadiusChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSelectedPreset(null);
    setBorderRadius(parseInt(e.target.value, 10));
  };
  const handleFormatChange = (e: React.ChangeEvent<HTMLSelectElement>) => setFormat(e.target.value as ImageFormat);
  const handleQualityChange = (e: React.ChangeEvent<HTMLInputElement>) => setQuality(parseInt(e.target.value, 10));
  const handleFitChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedPreset(null);
    setFitOption(e.target.value as FitOption)
  };

  const handleRemoveBackgroundChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setRemoveBackground(e.target.checked);
    // If remove background is checked and format is jpeg, switch to png
    if (e.target.checked && format === 'jpeg') {
      setFormat('png');
    }
  };
  const handleFilenameTemplateChange = (e: React.ChangeEvent<HTMLInputElement>) => setFilenameTemplate(e.target.value);
  
  const handlePresetSelect = (presetKey: string | null) => {
    if (presetKey === null) {
      setSelectedPreset(null);
      return;
    }

    const presetCategory = Object.keys(presets).find(category => presets[category][presetKey]);
    if (!presetCategory) return;
    
    const preset = presets[presetCategory][presetKey];
    if (preset) {
        setSelectedPreset(presetKey);
        setResizeDimensions({ width: preset.width, height: preset.height });
        setFitOption(preset.fit);
        if (preset.radius !== undefined) {
            setBorderRadius(Number(preset.radius)); // Ensure it's a number
        }
    }
  };

  const handleProcessImages = () => {
    if (images.length === 0 || isProcessing) return;

    const process = () => {
        setIsProcessing(true);
        setOverallProgress(0);
        setProcessedImageNames(new Set());

        const worker = createImageWorker();
        const width = resizeDimensions.width || 512;
        const height = resizeDimensions.height || 512;

        let effectiveFormat = format;
        if (removeBackground && effectiveFormat === 'jpeg') {
            effectiveFormat = 'png';
        }

        worker.postMessage({
          images: images.map(img => ({ file: img.originalFile, id: img.id })),
          options: {
            resize: { width, height, fit: fitOption },
            borderRadius,
            format: effectiveFormat,
            quality: effectiveFormat === 'png' ? undefined : quality,
            removeBackground: removeBackground,
            filenameTemplate: filenameTemplate,
            presetName: selectedPreset,
          },
        });

        worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
          const { data } = e;
          if (data.type === 'progress') {
            const { processedCount, totalCount, imageName } = data;
            setOverallProgress((processedCount / totalCount) * 100);
            setProcessedImageNames(prev => new Set(prev).add(imageName));
          } else if (data.type === 'model-load-progress') {
            const { current, total } = data;
            setModelLoadProgress({ current, total });
          } else if (data.type === 'done') {
            const processedResults = data.results;
            setModelLoadProgress(null);
            setImages(currentImages => currentImages.map(img => {
                const result = processedResults.find(p => p.originalId === img.id);
                if (!result || !result.filename) {
                    console.warn(`Could not find processed result for image ID: ${img.id} or filename is missing.`);
                    return img;
                }
                if (img.processedBlob) URL.revokeObjectURL(img.currentPreview);
                return {
                    ...img,
                    currentPreview: URL.createObjectURL(result.blob),
                    processedBlob: result.blob,
                    processedFileName: result.filename,
                    processedSize: result.size,
                    processedWidth: result.width,
                    processedHeight: result.height,
                    processedFormat: result.filename.split('.').pop() as ImageFormat,
                };
            }));
            setIsProcessing(false);
            worker.terminate();
          }
        };
         worker.onerror = (error) => {
            console.error("Web worker error:", error);
            setIsProcessing(false);
        };
    };

    if (removeBackground) {
        setShowModelConfirm(true);
        setDeferredProcess(() => process);
    } else {
        process();
    }
  };

  const handleResetEffects = () => {
    setImages(currentImages => currentImages.map(img => {
      if (img.processedBlob) URL.revokeObjectURL(img.currentPreview); // cleanup old processed URL
      const newPreview = URL.createObjectURL(img.originalFile); // create fresh preview URL
      return {
        ...img,
        processedBlob: undefined,
        currentPreview: newPreview,
        processedFileName: undefined,
        processedSize: undefined,
        processedWidth: undefined,
        processedHeight: undefined,
        processedFormat: undefined,
      };
    }));
    
    setResizeDimensions(defaultOptions.resizeDimensions);
    setBorderRadius(defaultOptions.borderRadius);
    setFormat(defaultOptions.format);
    setQuality(defaultOptions.quality);
    setFitOption(defaultOptions.fitOption);
  
    setRemoveBackground(defaultOptions.removeBackground);
    setFilenameTemplate(defaultOptions.filenameTemplate);
    setSelectedPreset(null);
  };
      


  const handleDownloadZip = async () => {
    const zip = new JSZip();
    const imagesToZip = images.filter(img => img.processedBlob && img.processedFileName);
    if (imagesToZip.length === 0) return;

    imagesToZip.forEach(image => {
      if (image.processedBlob && image.processedFileName) {
        zip.file(image.processedFileName, image.processedBlob);
      }
    });

    const zipBlob = await zip.generateAsync({ type: "blob" });
    saveAs(zipBlob, "processed-images.zip");
  };

  const handleDownloadSingleFile = (image: ImageState) => {
    if (image.processedBlob && image.processedFileName) {
      saveAs(image.processedBlob, image.processedFileName);
    }
  };


  const hasProcessedImages = images.length > 0 && images.some(img => img.processedBlob);
  const isUIDisabled = hasProcessedImages || isProcessing;

  // Helper to format file sizes
  const formatBytes = (bytes: number | undefined, decimals = 2) => {
    if (bytes === 0 || bytes === undefined) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  };

  return (
    <div className="w-full max-w-5xl space-y-6 p-4 bg-white dark:bg-gray-900 rounded-xl shadow-lg"> {/* Main container with new styling */}
      {/* Model Download Progress Modal */}
      {modelLoadProgress && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl max-w-sm w-full mx-4">
            <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-white flex items-center gap-2">
              <svg className="animate-spin h-5 w-5 text-blue-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Downloading Model
            </h2>
            <p className="text-gray-700 dark:text-gray-300 mb-4">
              The background removal model is being downloaded. This is a one-time process and might take a moment.
            </p>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-4">
              <div
                className="bg-blue-600 h-4 rounded-full text-center text-white text-xs leading-none"
                style={{ width: `${(modelLoadProgress.current / modelLoadProgress.total) * 100}%` }}
              >
                {((modelLoadProgress.current / modelLoadProgress.total) * 100).toFixed(0)}%
              </div>
            </div>
            <p className="text-right text-sm text-gray-600 dark:text-gray-400 mt-2">
              {(modelLoadProgress.current / 1024 / 1024).toFixed(2)} MB / {(modelLoadProgress.total / 1024 / 1024).toFixed(2)} MB
            </p>
          </div>
        </div>
      )}

      {/* Model Download Confirmation Dialog */}
      {showModelConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl max-w-sm w-full mx-4">
            <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-white">Download Background Removal Model</h2>
            <p className="text-gray-700 dark:text-gray-300 mb-4">
              To enable background removal, a model file (~40 MB) needs to be downloaded. This is a one-time download and will be cached for future use. Do you want to proceed?
            </p>
            <div className="flex justify-end gap-4">
              <button
                onClick={() => {
                  setShowModelConfirm(false);
                  setDeferredProcess(null);
                }}
                className="px-4 py-2 bg-gray-300 text-gray-800 rounded-md hover:bg-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-500"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowModelConfirm(false);
                  if (deferredProcess) {
                    deferredProcess();
                    setDeferredProcess(null); // Clear the deferred process after execution
                  }
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                Download & Process
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header with info icon */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
          Batch Image Processor
          <button onClick={toggleInfoModal} className="text-blue-500 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 focus:outline-none">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
              <path strokeLinecap="round" strokeLinejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z" />
            </svg>
          </button>
        </h1>
      </div>

      {/* Info Modal */}
      {showInfoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl max-w-md w-full mx-4">
            <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-white">About This Tool</h2>
            <p className="text-gray-700 dark:text-gray-300 mb-4">
              This tool allows batch image processing including resize, format conversion, corner rounding,
              aspect ratio adjustments, and presets.
            </p>
            <p className="text-gray-700 dark:text-gray-300 mb-4">
              Check out the open-source repository on{' '}
              <a
                href="https://github.com/GoogleForDevelopers/gemini-pro-vision-example"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                GitHub
              </a>
              .
            </p>
            <button
              onClick={toggleInfoModal}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Dropzone */}
      <div {...getRootProps()} className={`border-2 border-dashed p-10 text-center cursor-pointer transition ${isDragActive ? "border-blue-500 bg-blue-50 dark:bg-blue-900/50" : "border-gray-300 dark:border-gray-600"} shadow-md rounded-lg`}>
        <input {...getInputProps()} />
        <p className="text-gray-600 dark:text-gray-400">Drag & drop images here, or click to select</p>
      </div>

      {images.length > 0 && (
        <div className="space-y-6 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 shadow-md"> {/* Options panel styling */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Resize & Fit</h3>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="width" className="block text-xs text-gray-600 dark:text-gray-400">Width</label>
                  <input type="number" id="width" name="width" value={resizeDimensions.width || ''} onChange={handleDimensionChange} className="mt-1 block w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 sm:text-sm" disabled={isUIDisabled}/>
                </div>
                <div>
                  <label htmlFor="height" className="block text-xs text-gray-600 dark:text-gray-400">Height</label>
                  <input type="number" id="height" name="height" value={resizeDimensions.height || ''} onChange={handleDimensionChange} className="mt-1 block w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 sm:text-sm" disabled={isUIDisabled}/>
                </div>
              </div>
              <div>
                <label htmlFor="fit" className="block text-xs text-gray-600 dark:text-gray-400">Fit</label>
                <select id="fit" name="fit" value={fitOption} onChange={handleFitChange} className="mt-1 block w-full pl-3 pr-10 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 sm:text-sm" disabled={isUIDisabled}>
                  <option value="cover">Cover</option>
                  <option value="contain">Contain</option>
                  <option value="crop">Crop</option>
                </select>
              </div>
            </div>
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Appearance</h3>
              <div className="flex items-center gap-4">
                <div className="flex-grow">
                  <label htmlFor="borderRadius" className="block text-xs text-gray-600 dark:text-gray-400">Corners: {borderRadius}px</label>
                  <input type="range" id="borderRadius" name="borderRadius" min="0" max="100" value={borderRadius} onChange={handleBorderRadiusChange} className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50" disabled={isUIDisabled}/>
                </div>
                <div className="w-12 h-12 bg-gray-300 dark:bg-gray-500 border-2 border-gray-400 dark:border-gray-600 rounded-md transition-all duration-100" style={{ borderRadius: `${borderRadius}px` }}></div> {/* Added rounded-md here */}
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2 pt-2">
                  <input type="checkbox" id="removeBackground" checked={removeBackground} onChange={handleRemoveBackgroundChange} disabled={isUIDisabled} className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 focus:ring-offset-0" /> {/* Added focus:ring-offset-0 */}
                  <label htmlFor="removeBackground" className="block text-xs text-gray-600 dark:text-gray-400">Remove Background</label>
                </div>
              </div>
            </div>
            <div className="space-y-4">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Output</h3>
              <div>
                <label htmlFor="format" className="block text-xs text-gray-600 dark:text-gray-400">Format</label>
                <select id="format" name="format" value={format} onChange={handleFormatChange} className="mt-1 block w-full pl-3 pr-10 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 sm:text-sm" disabled={isUIDisabled}><option value="jpeg" disabled={removeBackground}>JPEG</option><option value="png">PNG</option><option value="webp">WebP</option></select>
              </div>
              <div>
                <label htmlFor="quality" className="block text-xs text-gray-600 dark:text-gray-400">Quality: {quality}</label>
                <input type="range" id="quality" name="quality" min="0" max="100" value={quality} onChange={handleQualityChange} className="w-full h-2 bg-gray-200 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50" disabled={isUIDisabled || format === 'png'}/> {/* Added focus:ring-2 */}
              </div>
            </div>
          </div>
          
          <div className="pt-4 border-t border-gray-200 dark:border-gray-700 mt-6"> {/* Added mt-6 for spacing */}
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Presets</h3>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => handlePresetSelect(null)}
                  disabled={isUIDisabled}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors disabled:opacity-50 ${
                    selectedPreset === null
                      ? 'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800'
                      : 'bg-gray-200 text-gray-800 hover:bg-gray-300 dark:bg-gray-700 dark:text-white dark:hover:bg-gray-600 active:bg-gray-400 dark:active:bg-gray-500'
                  } focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800`}
                >
                  Custom Size
                </button>
              </div>
              {Object.entries(presets).map(([category, items]) => (
                <div key={category}>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{category}</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(items).map(([key, preset]) => (
                      <button
                        key={key}
                        onClick={() => handlePresetSelect(key)}
                        disabled={isUIDisabled}
                        className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors disabled:opacity-50 ${
                          selectedPreset === key
                            ? 'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800'
                            : 'bg-gray-200 text-gray-800 hover:bg-gray-300 dark:bg-gray-700 dark:text-white dark:hover:bg-gray-600 active:bg-gray-400 dark:active:bg-gray-500'
                        } focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800`}
                      >
                        {preset.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Filename Template and Global Info Toggle */}
          <div className="pt-4 border-t border-gray-200 dark:border-gray-700 space-y-3 mt-6">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Download Options</h3>
            <div>
              <label htmlFor="filenameTemplate" className="block text-xs text-gray-600 dark:text-gray-400">Filename Template</label>
              <input type="text" id="filenameTemplate" name="filenameTemplate" value={filenameTemplate} onChange={handleFilenameTemplateChange} placeholder="{name}_{index}" className="mt-1 block w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 sm:text-sm" disabled={isUIDisabled} />
              <p className="mt-1 text-xs text-gray-500">Variables: {'{name}, {ext}, {index}, {width}, {height}, {ratio}, {preset}, {timestamp}'}</p>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-3 pt-4 border-t border-gray-200 dark:border-gray-700 mt-6">
            <button onClick={handleProcessImages} className="px-4 py-2 bg-black text-white rounded-md text-sm disabled:bg-gray-400 hover:bg-gray-800 active:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800" disabled={isUIDisabled}>Process Images</button>
            <button onClick={handleDownloadZip} className="px-4 py-2 bg-green-600 text-white rounded-md text-sm disabled:bg-gray-400 hover:bg-green-700 active:bg-green-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800" disabled={!hasProcessedImages || isProcessing}>Download ZIP</button>
            <button onClick={handleResetEffects} className="px-4 py-2 bg-yellow-500 text-black rounded-md text-sm disabled:bg-gray-400 hover:bg-yellow-600 active:bg-yellow-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800" disabled={!hasProcessedImages || isProcessing}>Reset Effects</button>
            <button onClick={clearAll} className="px-4 py-2 bg-red-600 text-white rounded-md text-sm disabled:bg-gray-400 hover:bg-red-700 active:bg-red-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800" disabled={isProcessing}>Clear All</button>
          </div>
        </div>
      )}

      {/* Progress Bar */}
      {isProcessing && <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 transition-all duration-500 ease-out mt-6"><div className="bg-blue-600 h-2.5 rounded-full" style={{ width: `${overallProgress}%` }}></div></div>}

      {/* Image Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4 mt-6">
  {images.map((img) => (
    <div key={img.id} className="relative aspect-square bg-gray-100 dark:bg-gray-800 rounded-lg shadow-md overflow-hidden group">
      <img src={img.currentPreview} alt={`preview of ${img.originalFile.name}`} className="w-full h-full object-cover rounded-md"/>

      {/* Close button for unprocessed images */}
      {!img.processedBlob && !isProcessing && (
        <button
          onClick={() => removeImage(img.id)}
          className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 text-xs hover:bg-red-600 active:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500"
          disabled={isProcessing}
        >
          &times;
        </button>
      )}

      {/* Spinner overlay during processing */}
      {isProcessing && (
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center pointer-events-none">
          {processedImageNames.has(img.originalFile.name) ? (
            <svg className="w-8 h-8 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="animate-spin w-8 h-8 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          )}
        </div>
      )}

      {/* Hover Overlay for Info + Buttons */}
      {img.processedBlob && (
        <div className="absolute inset-0 bg-black/70 text-white text-xs p-2 overflow-auto flex flex-col justify-between opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-auto">
          <div>
            <p><strong>Original:</strong> {img.originalFile.name}</p>
            <p><strong>Size:</strong> {formatBytes(img.originalFile.size)}</p>
            {img.processedFileName && <p><strong>Processed:</strong> {img.processedFileName}</p>}
            {img.processedSize !== undefined && <p><strong>Size:</strong> {formatBytes(img.processedSize)}</p>}
            {img.processedWidth && img.processedHeight && <p><strong>Dims:</strong> {img.processedWidth}x{img.processedHeight}</p>}
            {img.processedFormat && <p><strong>Format:</strong> {img.processedFormat.toUpperCase()}</p>}
          </div>

          {/* Buttons at the bottom of overlay */}
          <div className="flex justify-between mt-2 gap-2">
            <button
              onClick={() => handleDownloadSingleFile(img)}
              className="flex-1 px-2 py-1 bg-blue-600 text-white rounded-md text-xs hover:bg-blue-700 active:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
              disabled={!img.processedBlob || isProcessing}
            >
              Download
            </button>

            <button
              onClick={() => removeImage(img.id)}
              className="px-2 py-1 bg-red-500 text-white rounded-md text-xs hover:bg-red-600 active:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
              disabled={isProcessing}
            >
              &times;
            </button>
          </div>
        </div>
      )}
    </div>
  ))}
</div>

    </div>
  )}