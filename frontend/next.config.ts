import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // host-for-testing.sh exposes the dev server through a Cloudflare quick
  // tunnel with a random *.trycloudflare.com subdomain each run -- allow the
  // whole subdomain so devs don't have to edit this file every time.
  allowedDevOrigins: ["*.trycloudflare.com"],
};

export default nextConfig;
