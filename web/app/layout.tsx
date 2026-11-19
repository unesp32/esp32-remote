import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "esp32-remote — Web Bluetooth & Wi-Fi Provisioning",
  description:
    "Control an ESP32-S3 from the browser over Bluetooth — Wi-Fi provisioning, GPIO, telemetry and device history on Cloudflare.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta name="color-scheme" content="dark" />
        <meta name="theme-color" content="#0b0f14" />
        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%230b0f14'/><rect x='7' y='7' width='18' height='18' rx='3' fill='none' stroke='%2338e08b' stroke-width='2'/><rect x='13' y='13' width='6' height='6' fill='%2338e08b'/></svg>"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
