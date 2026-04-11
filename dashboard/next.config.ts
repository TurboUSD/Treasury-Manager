import type { NextConfig } from "next";


const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: true
  },
  eslint: {
    ignoreDuringBuilds: true
  },
  serverExternalPackages: ["exceljs"],
  headers: async () => [
    {
      source: "/api/treasury-data",
      headers: [
        { key: "Access-Control-Allow-Origin", value: "https://turbousd.com" },
        { key: "Access-Control-Allow-Methods", value: "GET, OPTIONS" },
        { key: "Access-Control-Allow-Headers", value: "Content-Type" },
      ],
    },
  ],
  webpack: config => { config.resolve.fallback = { fs: false, net: false, tls: false }; config.externals.push("pino-pretty", "lokijs", "encoding", "exceljs"); return config; }
};

const isIpfs = process.env.NEXT_PUBLIC_IPFS_BUILD === "true";

if (isIpfs) {
  nextConfig.output = "export";
  nextConfig.trailingSlash = true;
  nextConfig.images = {
    unoptimized: true,
  };
}



module.exports = nextConfig;