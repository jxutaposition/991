import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lele Investor Swipe",
  description: "Swipe through SF investors to triage outreach",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
