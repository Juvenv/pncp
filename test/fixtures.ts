import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Service } from '../src/service.js';
import { PncpApi } from '../src/api.js';
import { HttpClient } from '../src/http.js';
export function temporary() {
  const directory = mkdtempSync(join(process.cwd(), 'dados/test-fixes-'));
  return {
    directory, remove: () => {
      const root = resolve(process.cwd(), 'dados');
      if (!resolve(directory).startsWith(root + '\\') && !resolve(directory).startsWith(root + '/'))
        throw new Error('Pasta de teste fora de dados');
      rmSync(directory, { recursive: true });
    }
  };
}
export class FakeHttp extends HttpClient {
  calls: Array<Record<string, string | number | undefined>> = [];
  data = pdfFixture();
  downloads = 0;
  constructor(readonly respond: (params: Record<string, string | number | undefined>) => unknown = () => ({ items: [], total: 0 })) { super(); }
  override async json(_base: string, params: Record<string, string | number | undefined> = {}) { this.calls.push(params); return await this.respond(params); }
  override async download(url: string) { this.downloads++; return { data: this.data, finalUrl: url, contentType: 'application/octet-stream', status: 200 }; }
}
export function setup(respond?: FakeHttp['respond']) {
  const temp = temporary();
  const http = new FakeHttp(respond);
  const service = new Service(temp.directory, new PncpApi(http));
  return { ...temp, http, service, close: () => { service.close(); temp.remove(); } };
}
export function pdfFixture(text = 'marca teste', pages = 1) {
  const stream = text ? `BT /F1 12 Tf 30 100 Td (${text}) Tj ET` : '';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${'3 0 R '.repeat(pages)}] /Count ${pages} >>`, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(body);
  body += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(body);
}
