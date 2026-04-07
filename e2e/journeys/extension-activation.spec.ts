/**
 * Extension Activation Tests
 *
 * Verifies that the extension loads correctly:
 * - Service worker starts
 * - Content script injects on matched pages
 * - Side panel renders with Record button
 */
import { test, expect } from "../fixtures/mock-backend";

test.describe("Extension Activation", () => {
  test("service worker starts and is reachable", async ({ context }) => {
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      [sw] = await Promise.all([
        context.waitForEvent("serviceworker", { timeout: 10000 }),
      ]);
    }
    expect(sw).toBeTruthy();
    expect(sw.url()).toContain("background.js");
  });

  test("content script injects on matched pages", async ({
    context,
  }) => {
    const page = await context.newPage();
    await page.goto("http://localhost:4000/sales-nav/search");
    await page.waitForLoadState("domcontentloaded");

    // The content script sets data-percent99-observer="active" on <html>
    await page.waitForFunction(
      () => document.documentElement.dataset.percent99Observer === "active",
      null,
      { timeout: 5000 },
    );

    const attr = await page.evaluate(
      () => document.documentElement.dataset.percent99Observer,
    );
    expect(attr).toBe("active");
  });

  test("content script injects on Clay mock page", async ({
    context,
  }) => {
    const page = await context.newPage();
    await page.goto("http://localhost:4000/clay/tables");
    await page.waitForLoadState("domcontentloaded");

    await page.waitForFunction(
      () => document.documentElement.dataset.percent99Observer === "active",
      null,
      { timeout: 5000 },
    );

    const attr = await page.evaluate(
      () => document.documentElement.dataset.percent99Observer,
    );
    expect(attr).toBe("active");
  });

  test("side panel renders with Record button", async ({
    context,
    extensionId,
  }) => {
    const sidepanel = await context.newPage();
    await sidepanel.goto(
      `chrome-extension://${extensionId}/sidepanel.html`,
    );
    await sidepanel.waitForLoadState("domcontentloaded");

    const recordBtn = sidepanel.getByRole("button", { name: /record/i });
    await expect(recordBtn).toBeVisible({ timeout: 5000 });
  });

  test("popup renders with Open Side Panel button", async ({
    context,
    extensionId,
  }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForLoadState("domcontentloaded");

    const btn = popup.getByRole("button", {
      name: /open side panel/i,
    });
    await expect(btn).toBeVisible({ timeout: 5000 });
  });
});
