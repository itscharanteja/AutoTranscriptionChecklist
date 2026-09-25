import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // host-for-testing.sh exposes the dev server through a Cloudflare quick
  // tunnel with a random *.trycloudflare.com subdomain each run -- allow the
  // whole subdomain so devs don't have to edit this file every time.
  // *.sslip.io covers the permanent EC2 deployment (Elastic IP + Caddy,
  // fronted by a sslip.io magic-DNS hostname instead of a real domain).
  allowedDevOrigins: ["*.trycloudflare.com", "*.sslip.io"],
};

export default nextConfig;
