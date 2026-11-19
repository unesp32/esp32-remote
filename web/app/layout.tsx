import type { ReactNode } from "react";
import "@cloudflare/kumo/styles/standalone";

export const metadata = {
  title: "esp32-remote",
  description:
    "Control an ESP32-S3 from the browser over Bluetooth — Wi-Fi provisioning, GPIO and device history, no app install.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
