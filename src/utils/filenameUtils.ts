// src/utils/filenameUtils.ts

import { ImageFormat } from "../components/UploadDropzone"; // Assuming ImageFormat is exported

interface ImageMetadata {
    originalName: string; // e.g., "my_image.jpeg"
    outputWidth: number;
    outputHeight: number;
    outputFormat: ImageFormat;
    presetName: string | null;
    timestamp: number; // Unix timestamp
    index: number; // Batch index (0-based)
}

/**
 * Replaces template variables in a filename string.
 * @param template The filename template string (e.g., "{name}_{width}x{height}.{ext}")
 * @param metadata Image metadata to fill variables
 * @returns Filename with variables replaced
 */
export function parseFilenameTemplate(template: string, metadata: ImageMetadata): string {
    let filename = template;
    const { originalName, outputWidth, outputHeight, outputFormat, presetName, timestamp, index } = metadata;

    const nameWithoutExt = originalName.substring(0, originalName.lastIndexOf('.') > 0 ? originalName.lastIndexOf('.') : originalName.length);
    const originalExt = originalName.substring(originalName.lastIndexOf('.') > 0 ? originalName.lastIndexOf('.') + 1 : originalName.length);

    const ratio = outputWidth && outputHeight ? `${outputWidth / gcd(outputWidth, outputHeight)}x${outputHeight / gcd(outputWidth, outputHeight)}` : '';

    filename = filename.replace(/{name}/g, nameWithoutExt);
    filename = filename.replace(/{ext}/g, outputFormat); // Use output format for extension
    filename = filename.replace(/{index}/g, (index + 1).toString());
    filename = filename.replace(/{width}/g, outputWidth.toString());
    filename = filename.replace(/{height}/g, outputHeight.toString());
    filename = filename.replace(/{ratio}/g, ratio);
    filename = filename.replace(/{preset}/g, presetName || '');
    filename = filename.replace(/{timestamp}/g, timestamp.toString()); // Could format this more nicely if needed

    return sanitizeFilename(filename);
}

/**
 * Sanitizes a filename to be safe for various file systems.
 * Removes invalid characters and limits length.
 * @param filename The unsanitized filename
 * @returns A safe filename
 */
export function sanitizeFilename(filename: string): string {
    // Remove invalid characters
    let safeFilename = filename.replace(/[/\\?%*:|"<>]/g, '-');
    // Replace multiple hyphens with single
    safeFilename = safeFilename.replace(/--+/g, '-');
    // Trim leading/trailing hyphens/spaces
    safeFilename = safeFilename.replace(/^[ -]+|[ -]+$/g, '');
    // Limit length (e.g., 200 characters)
    if (safeFilename.length > 200) {
        safeFilename = safeFilename.substring(0, 200);
    }
    // Ensure it's not empty
    if (safeFilename === '') {
        safeFilename = 'untitled';
    }
    return safeFilename;
}

/**
 * Generates a unique filename by appending a suffix if a name already exists.
 * @param preferredName The desired filename
 * @param existingNames A Set of already existing filenames
 * @returns A unique filename
 */
export function getUniqueFilename(preferredName: string, existingNames: Set<string>): string {
    let uniqueName = preferredName;
    let counter = 1;
    const nameWithoutExt = preferredName.substring(0, preferredName.lastIndexOf('.') > 0 ? preferredName.lastIndexOf('.') : preferredName.length);
    const ext = preferredName.substring(preferredName.lastIndexOf('.') > 0 ? preferredName.lastIndexOf('.') : preferredName.length);

    while (existingNames.has(uniqueName)) {
        uniqueName = `${nameWithoutExt}(${counter})${ext}`;
        counter++;
    }
    return uniqueName;
}

/**
 * Calculates the greatest common divisor (GCD) of two numbers.
 * Used for aspect ratio simplification.
 */
function gcd(a: number, b: number): number {
    return b === 0 ? a : gcd(b, a % b);
}
