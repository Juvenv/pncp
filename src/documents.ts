import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface PdfPage { page: number; text: string }

export async function extractPdf(data: Buffer): Promise<PdfPage[]> {
  if (data.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Arquivo não tem assinatura PDF; OCR/outros formatos ainda não suportados');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise;
  const pages: PdfPage[] = [];
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    pages.push({ page: number, text: content.items.map((item) => ('str' in item ? item.str : '')).join(' ') });
  }
  return pages;
}

export function saveDocument(data: Buffer, directory: string): { hash: string; path: string } {
  mkdirSync(directory, { recursive: true });
  const hash = createHash('sha256').update(data).digest('hex');
  const path = join(directory, `${hash}.pdf`);
  if (!existsSync(path)) writeFileSync(path, data, { flag: 'wx' });
  return { hash, path };
}

export function evidenceSnippets(pages: PdfPage[], terms = ['adesão', 'vigência', 'garantia', 'marca', 'modelo', 'preço']): Array<{ page: number; text: string }> {
  const pattern = new RegExp(terms.filter(Boolean).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'iu');
  return pages.flatMap(({ page, text }) => { const match = pattern.exec(text); return match ? [{ page, text: text.slice(Math.max(0, match.index - 280), match.index + match[0].length + 280) }] : []; });
}
