import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
try {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const assets = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const assetPath = (name: string) => join(assets, name).replaceAll('\\', '/') + '/';
  const document = await pdfjs.getDocument({
    data: workerData.data as Uint8Array, isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
    standardFontDataUrl: assetPath('standard_fonts'), cMapUrl: assetPath('cmaps'), cMapPacked: true, wasmUrl: assetPath('wasm')
  }).promise;
  try {
    if (document.numPages > Number(workerData.maxPages))
      throw new Error('PDF excede o orçamento de 500 páginas; indexação manual pendente');
    let length = 0;
    const pages: Array<{
      page: number;
      text: string;
    }> = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str : '').join(' ');
      length += text.length;
      if (length > Number(workerData.maxText))
        throw new Error('Texto PDF excede o orçamento de 4 milhões de caracteres');
      pages.push({ page: number, text });
      page.cleanup();
    }
    parentPort?.postMessage({ pages });
  }
  finally {
    await document.destroy();
  }
}
catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
