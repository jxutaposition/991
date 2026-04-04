export default async function globalTeardown() {
  const mockBackend = (globalThis as any).__mockBackend;
  const mockSite = (globalThis as any).__mockSite;

  if (mockBackend) {
    mockBackend.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      mockBackend.on("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }

  if (mockSite) {
    mockSite.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      mockSite.on("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }
}
