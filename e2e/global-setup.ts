import { type FullConfig } from "@playwright/test";
import { fork, type ChildProcess } from "child_process";
import path from "path";

let mockBackend: ChildProcess | null = null;
let mockSite: ChildProcess | null = null;

async function waitForPort(port: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.status > 0) return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`Port ${port} not ready after ${timeoutMs}ms`);
}

async function isPortFree(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}/`);
    return false;
  } catch {
    return true;
  }
}

export default async function globalSetup(_config: FullConfig) {
  // Start mock backend on 3001 if not already running
  if (await isPortFree(3001)) {
    mockBackend = fork(
      path.join(__dirname, "mock-backend/server.js"),
      [],
      { stdio: "pipe", env: { ...process.env, MOCK_BACKEND_PORT: "3001" } },
    );
    mockBackend.stdout?.on("data", (d) =>
      process.stdout.write(`[mock-backend] ${d}`),
    );
    mockBackend.stderr?.on("data", (d) =>
      process.stderr.write(`[mock-backend:err] ${d}`),
    );
    await waitForPort(3001);
  }

  // Start mock GTM site on 4000 if not already running
  if (await isPortFree(4000)) {
    mockSite = fork(
      path.join(__dirname, "mock-gtm-site/server.js"),
      [],
      { stdio: "pipe" },
    );
    mockSite.stdout?.on("data", (d) =>
      process.stdout.write(`[mock-site] ${d}`),
    );
    mockSite.stderr?.on("data", (d) =>
      process.stderr.write(`[mock-site:err] ${d}`),
    );
    await waitForPort(4000);
  }

  // Store refs for teardown
  (globalThis as any).__mockBackend = mockBackend;
  (globalThis as any).__mockSite = mockSite;
}
