/**
 * One browser, configured once, for every runner.
 *
 * **System Chrome, not Playwright's bundled Chromium.** The claim is about
 * what a user's browser does, and pinning the real Chrome the examiner could
 * install makes the result reproducible in the ordinary sense rather than the
 * "if you have this exact build artefact" sense. Its version is recorded with
 * every result.
 *
 * `--js-flags=--expose-gc` is not used: memory is read through CDP's
 * `HeapProfiler.collectGarbage`, which needs no flag and does not change how
 * the page under test behaves.
 */
import { chromium } from "playwright";

export async function launch({ headless = true } = {}) {
  return chromium.launch({
    channel: "chrome",
    headless,
    args: [
      // The default heap cap makes "it ran out of memory" a property of the
      // flag rather than of the tool. Raised for BOTH tools equally, so a
      // failure is the tool's own ceiling.
      "--js-flags=--max-old-space-size=8192",
      "--disable-dev-shm-usage",
    ],
  });
}

export function versionOf(browser) {
  return `Chrome ${browser.version()}`;
}
