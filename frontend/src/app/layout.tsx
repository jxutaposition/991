import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/nav";

export const metadata: Metadata = {
  title: "lele — GTM Agent Platform",
  description: "Expert-trained GTM agents for the whole funnel",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-page text-ink">
        <Nav />
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
