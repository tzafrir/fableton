import type { Page } from "@playwright/test";

/**
 * Render-suite helper: attaches listeners that collect every console error,
 * uncaught page exception, and failed/non-2xx network response seen while
 * the page is open. Used by every spec in this suite so "zero console
 * errors, zero uncaught exceptions, zero failed asset requests" (M0 render
 * probe check 1) is actually enforced on every flow, not just the smoke
 * test.
 */
export interface PageErrors {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

export function collectPageErrors(page: Page): PageErrors {
  const errors: PageErrors = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
  };

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.consoleErrors.push(msg.text());
    }
  });

  page.on("pageerror", (err) => {
    errors.pageErrors.push(String(err));
  });

  page.on("requestfailed", (req) => {
    errors.failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText ?? "unknown error"}`);
  });

  page.on("response", (res) => {
    // Ignore the dev/preview server's own navigation redirects and anything
    // not same-origin static content; a >=400 on any asset/document request
    // is a real failure.
    if (res.status() >= 400) {
      errors.failedRequests.push(`${res.request().method()} ${res.url()} — HTTP ${res.status()}`);
    }
  });

  return errors;
}
