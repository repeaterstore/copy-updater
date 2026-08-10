import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Railway runs this as a container; standalone keeps the image small.
  output: "standalone",
  // These pull in native binaries or huge assets and must not be bundled.
  serverExternalPackages: [
    "playwright",
    "playwright-core",
    "single-file-cli",
    "jsdom",
    "sharp",
    "pg",
    // Ships a platform-specific native binary; bundling it fails outright.
    "esbuild",
  ],
};

export default nextConfig;
