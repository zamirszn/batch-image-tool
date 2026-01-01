# Batch Image Tool

A **Next.js** web application for batch processing images with features like resizing, cropping, rounded corners, and on-device background removal using [`@imgly/background-removal`](https://www.npmjs.com/package/@imgly/background-removal).

## Features

* Batch upload and processing of images
* Resize images with `cover`, `contain`, or `crop` options
* Apply rounded corners that crop the image corners
* On-device background removal using AI (`@imgly/background-removal`)
* Download processed images individually or as a zip
* Supports JPEG, PNG, and WebP formats
* Maintains high performance using Web Workers

## Link

https://batch-images-tool.vercel.app/

## Installation

1. Clone the repository:

```bash
git clone https://github.com/zamirszn/batch-image-tool.git
cd batch-image-tool
```

2. Install dependencies:

```bash
npm install
# or
yarn
# or
pnpm install
```

3. Run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

1. Upload multiple images via the drag-and-drop area.
2. Configure processing options:

   * Resize dimensions
   * Fit method: `cover`, `contain`, or `crop`
   * Border radius
   * Output format (JPEG, PNG, WebP)
   * Enable background removal
3. Start processing and wait for progress indicators.
4. Download processed images.

## Technologies

* **Next.js** – React framework for server-side rendering and optimized frontend
* **TypeScript** – Type safety
* **Tailwind CSS** – Styling
* **Web Workers** – For offloading image processing to prevent UI blocking
* **@imgly/background-removal** – On-device AI background removal
* **JSZip & FileSaver** – Batch downloading of processed images

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add new feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

## License

MIT License © [zamirszn](https://github.com/zamirszn)