import puppeteer from 'puppeteer-core';
import { findBrowserPath } from './browsers.js';

let browserPromise = null;

function launch() {
  const executablePath = findBrowserPath();
  if (!executablePath) {
    throw new Error(
      'No Chrome or Edge browser found for PDF generation. Install Google Chrome/Edge or set CHROME_PATH.'
    );
  }
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-first-run', '--disable-gpu', '--hide-scrollbars']
  });
}

export function getBrowser() {
  if (!browserPromise) {
    browserPromise = launch().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

export async function renderPdf(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    return await page.pdf({
      preferCSSPageSize: true,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });
  } finally {
    await page.close();
  }
}
