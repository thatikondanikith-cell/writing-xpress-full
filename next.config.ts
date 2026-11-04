import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PDF.js resolves its Node fake-worker module relative to its package files.
  // Keep it external so Next's server bundler does not relocate pdf.mjs without pdf.worker.mjs.
  serverExternalPackages: ['pdfjs-dist'],
};

export default nextConfig;
