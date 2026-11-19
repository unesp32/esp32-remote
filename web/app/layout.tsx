import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "esp32-remote · Cloudflare Dashboard",
  description:
    "Cloudflare Workers + Vinext remote control and Wi-Fi provisioning for ESP32-S3 over Web Bluetooth.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta name="color-scheme" content="dark" />
        <meta name="theme-color" content="#111722" />
        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%23111722'/><path d='M23 18a4 4 0 0 0-4-4 4.5 4.5 0 0 0-8.7 1.2A3.5 3.5 0 0 0 7 18.5a3.5 3.5 0 0 0 3.5 3.5h12.5a3 3 0 0 0 0-6z' fill='%23f6821f'/></svg>"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
