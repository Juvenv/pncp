import { setTimeout as delay } from 'node:timers/promises';

export class PncpError extends Error {
  constructor(message: string, readonly operation: string, readonly retryable = false, readonly status?: number) {
    super(message);
    this.name = 'PncpError';
  }
}

const allowedRemoteHosts = new Set(['pncp.gov.br', 'www.pncp.gov.br']);
function assertRemoteUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !allowedRemoteHosts.has(url.hostname.toLowerCase())) {
    throw new PncpError('URL remota fora da allowlist HTTPS do PNCP', 'url-validation');
  }
  return url;
}

export class HttpClient {
  constructor(private readonly timeoutMs = 30_000, private readonly retries = 2, private readonly maxBytes = 50 * 1024 * 1024) {}

  async json(base: string, params: Record<string, string | number | undefined> = {}, operation = 'request'): Promise<unknown> {
    const url = assertRemoteUrl(base);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    let last: PncpError | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } });
        if (response.status === 204) throw new PncpError('Resposta 204 sem conteúdo', operation, false, 204);
        if (!response.ok) throw new PncpError(`HTTP ${response.status} em ${operation}`, operation, [429, 500, 502, 503, 504].includes(response.status), response.status);
        try { return await response.json(); } catch (error) { throw new PncpError(`JSON inválido em ${operation}: ${String(error)}`, operation); }
      } catch (error) {
        last = error instanceof PncpError ? error : new PncpError(`Falha de rede em ${operation}: ${String(error)}`, operation, true);
        if (!last.retryable || attempt === this.retries) throw last;
        await delay(2 ** attempt * 500);
      } finally { clearTimeout(timer); }
    }
    throw last ?? new PncpError('Falha HTTP desconhecida', operation);
  }

  async download(rawUrl: string, operation = 'documento'): Promise<{ data: Buffer; finalUrl: string; contentType: string; status: number }> {
    const url = assertRemoteUrl(rawUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
      if (!response.ok) throw new PncpError(`HTTP ${response.status} ao baixar documento`, operation, false, response.status);
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > this.maxBytes) throw new PncpError('Documento excede o limite configurado', operation);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > this.maxBytes) throw new PncpError('Documento excede o limite configurado', operation);
      return { data: bytes, finalUrl: response.url, contentType: response.headers.get('content-type') ?? 'application/octet-stream', status: response.status };
    } catch (error) { throw error instanceof PncpError ? error : new PncpError(`Falha de rede: ${String(error)}`, operation, true); }
    finally { clearTimeout(timer); }
  }
}
