import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/nav";
import { AuthProvider } from "@/lib/auth-context";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "99percent — GTM Agent Platform",
  description: "Expert-trained GTM agents for the whole funnel",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} min-h-screen bg-page text-ink flex`}>
        <AuthProvider>
          <Nav />
          <main className="flex-1 overflow-y-auto h-screen">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
