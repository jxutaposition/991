import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/nav";
import { AuthProvider } from "@/lib/auth-context";

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
      <body className="font-sans min-h-screen bg-page text-ink flex">
        <AuthProvider>
          <Nav />
          <main className="flex-1 flex flex-col min-h-0 h-screen overflow-y-auto">
            {children}
          </main>
        </AuthProvider>
      </body>
    </html>
  );
}
