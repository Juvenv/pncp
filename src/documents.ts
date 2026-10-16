import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
export interface PdfPage {
  page: number;
  text: string;
}
let running = 0;
const waiting: Array<() => void> = [];
async function slot(signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  if (running >= 2) {
    if (waiting.length >= 4)
      throw new Error('Fila de extração PDF ocupada; tente atualizar o documento mais tarde');
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal?.removeEventListener('abort', abort); running++; resolve(); };
      const abort = () => {
        const index = waiting.indexOf(ready); if (index >= 0)
          waiting.splice(index, 1); reject(signal?.reason);
      };
      waiting.push(ready);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  else
    running++;
  let released = false;
  return () => {
    if (released)
      return; released = true; running--; waiting.shift()?.();
  };
}
export async function extractPdf(data: Buffer, signal?: AbortSignal): Promise<PdfPage[]> {
  if (data.subarray(0, 5).toString('ascii') !== '%PDF-')
    throw new Error('Formato não PDF: pendente conversão manual; conteúdo não executado');
  signal?.throwIfAborted();
  const release = await slot(signal);
  const javascript = new URL('./pdf-worker.js', import.meta.url);
  let worker: Worker;
  try {
    worker = new Worker(existsSync(javascript) ? javascript : new URL('./pdf-worker.ts', import.meta.url), {
      workerData: { data: new Uint8Array(data), maxPages: 500, maxText: 4000000 }, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 }, stdout: true, stderr: true,
      execArgv: [],
    });
  }
  catch (error) {
    release();
    throw error;
  }
  worker.stdout?.on('data', chunk => process.stderr.write(chunk));
  worker.stderr?.on('data', chunk => process.stderr.write(chunk));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: unknown, pages?: PdfPage[]) => {
      if (done)
        return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate().then(release, release);
      if (error)
        reject(error);
      else
        resolve(pages ?? []);
    };
    const abort = () => finish(signal?.reason ?? new Error('Extração cancelada'));
    const timer = setTimeout(() => finish(new Error('Extração PDF excedeu 25 segundos')), 25000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted)
      abort();
    worker.once('error', error => finish(error));
    worker.once('exit', code => {
      if (!done)
        finish(new Error(`Worker PDF terminou sem resultado (${code})`));
    });
    worker.once('message', (message: {
      pages?: PdfPage[];
      error?: string;
    }) => message.error ? finish(new Error(message.error)) : finish(undefined, message.pages));
  });
}
export function saveDocument(data: Buffer, directory: string): {
  hash: string;
  path: string;
} {
  mkdirSync(directory, { recursive: true });
  const hash = createHash('sha256').update(data).digest('hex');
  const prefix = data.subarray(0, 100).toString('utf8').trimStart().toLowerCase();
  const extension = prefix.startsWith('%pdf-') ? 'pdf' : prefix.startsWith('{\\rtf') ? 'rtf' : prefix.startsWith('<!doctype html') || prefix.startsWith('<html') ? 'html' : 'bin';
  const path = join(directory, `${hash}.${extension}`);
  try {
    writeFileSync(path, data, { flag: 'wx' });
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw error;
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== hash)
      throw new Error('Arquivo local diverge do SHA-256; foi preservado e requer restauração');
  }
  return { hash, path };
}
function folded(text: string): {
  text: string;
  positions: number[];
} {
  let result = '', offset = 0;
  const positions: number[] = [];
  for (const char of text) {
    const value = char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (const unit of value) {
      result += unit;
      for (let i = 0; i < unit.length; i++)
        positions.push(offset);
    }
    offset += char.length;
  }
  return { text: result, positions };
}
export function evidenceSnippets(pages: PdfPage[], terms = ['adesão', 'vigência', 'garantia', 'marca', 'modelo', 'preço', 'valor']): Array<{
  page: number;
  text: string;
}> {
  const needles = terms.map(t => folded(t.trim()).text).filter(Boolean);
  if (!needles.length)
    return [];
  const result: Array<{
    page: number;
    text: string;
  }> = [];
  for (const page of pages) {
    const normalized = folded(page.text);
    const windows: Array<[
      number,
      number
    ]> = [];
    for (const term of needles) {
      let start = 0, count = 0;
      while (count++ < 100) {
        const match = normalized.text.indexOf(term, start);
        if (match < 0)
          break;
        const position = normalized.positions[match] ?? match;
        windows.push([Math.max(0, position - 280), Math.min(page.text.length, (normalized.positions[match + term.length] ?? page.text.length) + 280)]);
        start = match + Math.max(1, term.length);
      }
    }
    windows.sort((a, b) => a[0] - b[0]);
    const merged: Array<[
      number,
      number
    ]> = [];
    for (const window of windows) {
      const previous = merged.at(-1);
      if (previous && window[0] <= previous[1])
        previous[1] = Math.max(previous[1], window[1]);
      else
        merged.push(window);
    }
    for (const [start, end] of merged)
      for (let at = start; at < end; at += 1200)
        result.push({ page: page.page, text: page.text.slice(at, Math.min(at + 1200, end)) });
  }
  return result;
}
