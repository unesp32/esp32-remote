import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "esp32-remote · Cloudflare Dashboard",
  description:
    "Cloudflare Workers + Vinext remote control and Wi-Fi provisioning for ESP32-S3 over Web Bluetooth.",
  manifest: "/manifest.webmanifest",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f8fafc" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0d121a" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="ESP32 Remote" />
        <meta name="mobile-web-app-capable" content="yes" />

        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <link rel="icon" type="image/svg+xml" href="/icons/icon.svg" />
        <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png" />

        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                const s = localStorage.getItem("color-scheme");
                if (s === "light" || s === "dark") {
                  document.documentElement.setAttribute("data-theme", s);
                  const m = document.querySelector('meta[name="color-scheme"]');
                  if (m) m.content = s;
                } else {
                  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
                  document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
                }
              } catch (e) {}

              if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
                window.addEventListener('load', () => {
                  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW registration failed:', e));
                });
              }
            `,
          }}
        />
      </head>
      <body className="overscroll-none select-none">{children}</body>
    </html>
  );
}
