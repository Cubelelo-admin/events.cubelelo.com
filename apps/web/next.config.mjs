const API_URL = process.env.API_URL ?? "http://localhost:4000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship as TypeScript source — let Next transpile them.
  transpilePackages: ["@cubers/types", "@cubers/scramble-core", "@cubers/timer-core"],
  async rewrites() {
    return [
      { source: "/health", destination: `${API_URL}/health` },
      { source: "/api/v1/:path*", destination: `${API_URL}/api/v1/:path*` },
      // Local file storage returns relative `/uploads/...` URLs, which resolve
      // against this origin. Without this rewrite every locally-stored banner
      // 404s silently — the image simply never appears.
      { source: "/uploads/:path*", destination: `${API_URL}/uploads/:path*` },
    ];
  },
  experimental: {
    swcMinify: true,
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    config.module.rules.push({
      test: /[\\/]cubing[\\/]dist[\\/].*worker.*\.js$/,
      type: "asset/resource",
      generator: { filename: "static/chunks/[name].[hash][ext]" },
    });
    config.module.rules.push({
      test: /[\\/]cubing[\\/]dist[\\/]lib[\\/]cubing[\\/]chunks[\\/]/,
      type: "javascript/esm",
    });
    return config;
  },
};

export default nextConfig;
