import { setTimeout as delay } from 'node:timers/promises';
import { appendFileSync, mkdirSync, statSync, renameSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
export class PncpError extends Error {
  constructor(message: string, readonly operation: string, readonly retryable = false, readonly status?: number, options?: ErrorOptions, readonly retryAt?: number) {
    super(message, options);
    this.name = 'PncpError';
  }
}
export interface RequestContext {
  signal?: AbortSignal | undefined;
  budget?: {
    remaining: number;
  };
}
interface HttpOptions {
  minIntervalMs?: number;
  backoffMs?: number;
  userAgent?: string;
  telemetry?: boolean;
  random?: () => number;
  persistCooldown?: boolean;
}
const hosts = new Set(['pncp.gov.br', 'www.pncp.gov.br']);
const gates = new Map<string, number>();
export const defaultUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
export function remoteUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname.toLowerCase()) || (url.port && url.port !== '443') || url.username || url.password) {
    throw new PncpError('URL fora das origens HTTPS/443 públicas permitidas do PNCP', 'url-validation');
  }
  return url;
}
export function errorDetails(error: unknown): Record<string, unknown> {
  const chain: Array<Record<string, unknown>> = [];
  let current = error;
  while (current instanceof Error && chain.length < 6) {
    const e = current as Error & {
      code?: string;
      status?: number;
      retryAt?: number;
    };
    chain.push({ name: e.name, message: e.message, code: e.code ?? null, status: e.status ?? null, retry_at: e.retryAt ?? null });
    current = e.cause;
  }
  return { message: error instanceof Error ? error.message : String(error), chain };
}
function envNumber(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${name} fora do intervalo ${min}–${max}`);
  return value;
}
export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal)
    return promise;
  if (signal.aborted) {
    void promise.catch(() => { });
    throw signal.reason;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
export class HttpClient {
  constructor(private readonly timeoutMs = 15000, private readonly retries = 2, private readonly maxBytes = 50 * 1024 * 1024, private readonly options: HttpOptions = {}) { }
  private log(event: Record<string, unknown>): void {
    if (this.options.telemetry === false)
      return;
    try {
      const directory = join(process.env.PNCP_DATA_DIR ?? join(process.cwd(), 'dados'), 'logs');
      mkdirSync(directory, { recursive: true });
      const file = join(directory, 'http.jsonl');
      if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024)
        renameSync(file, join(directory, `http-${Date.now()}.jsonl`));
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
    }
    catch { /* Telemetria não pode refazer uma requisição concluída. */ }
  }
  private async wait(host: string, signal?: AbortSignal): Promise<void> {
    const interval = this.options.minIntervalMs ?? envNumber('PNCP_REQUEST_INTERVAL_MS', 1000, 100, 60000);
    while (true) {
      signal?.throwIfAborted();
      const at = Math.max(gates.get(host) ?? 0, gates.get(`${host}:cooldown`) ?? 0, this.savedCooldown());
      if (at <= Date.now()) {
        gates.set(host, Date.now() + interval);
        return;
      }
      await delay(Math.min(at - Date.now(), 1000), undefined, { signal });
    }
  }
  private savedCooldown(value?: number): number {
    if (this.options.persistCooldown === false)
      return 0;
    try {
      const directory = join(process.env.PNCP_DATA_DIR ?? join(process.cwd(), 'dados'), 'http-state');
      const path = join(directory, 'pncp-cooldown.json');
      const saved = existsSync(path) ? Number(JSON.parse(readFileSync(path, 'utf8')).retry_at) : 0;
      const until = Number.isFinite(saved) ? saved : 0;
      if (value === undefined || value <= until)
        return until;
      mkdirSync(directory, { recursive: true });
      const temporary = join(directory, `${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify({ retry_at: value }));
      renameSync(temporary, path);
      return value;
    }
    catch {
      return 0;
    }
  }
  private async bytes(response: Response, limit: number, operation: string): Promise<Buffer> {
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > limit) {
      await response.body?.cancel();
      throw new PncpError('Corpo excede o limite configurado', operation);
    }
    if (!response.body)
      return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done)
          break;
        size += chunk.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new PncpError('Corpo excede o limite configurado', operation);
        }
        chunks.push(chunk.value);
      }
      return Buffer.concat(chunks, size);
    }
    finally {
      reader.releaseLock();
    }
  }
  private async request(url: URL, operation: string, json: boolean, context: RequestContext): Promise<{
    data: Buffer;
    finalUrl: string;
    contentType: string;
    status: number;
  }> {
    const deadline = AbortSignal.timeout(45000);
    context = { ...context, signal: context.signal ? AbortSignal.any([context.signal, deadline]) : deadline };
    const userAgent = this.options.userAgent ?? process.env.PNCP_USER_AGENT ?? defaultUserAgent;
    if (!userAgent.trim() || /[\r\n]/.test(userAgent))
      throw new PncpError('User-Agent inválido', operation);
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      context.signal?.throwIfAborted();
      await this.wait('pncp.gov.br', context.signal);
      if (context.budget) {
        if (context.budget.remaining <= 0)
          throw new PncpError('Orçamento de requisições da coleta esgotado', operation);
        context.budget.remaining--;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException('Timeout HTTP', 'TimeoutError')), this.timeoutMs);
      const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
      const started = Date.now();
      let status: number | undefined;
      try {
        const response = await fetch(url, { signal, redirect: 'error', headers: { accept: json ? 'application/json' : '*/*', 'user-agent': userAgent } });
        status = response.status;
        if (!response.ok || (json && status === 204)) {
          const retryAfter = response.headers.get('retry-after');
          const parsed = retryAfter === null ? NaN : /^\d+$/.test(retryAfter.trim()) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter);
          const retryAt = Number.isFinite(parsed) ? Math.max(Date.now(), parsed) : undefined;
          if (retryAt !== undefined) {
            gates.set('pncp.gov.br:cooldown', Math.max(gates.get('pncp.gov.br:cooldown') ?? 0, retryAt));
            this.savedCooldown(retryAt);
          }
          await response.body?.cancel();
          throw new PncpError(`HTTP ${status} em ${operation}`, operation, [429, 500, 502, 503, 504].includes(status), status, undefined, retryAt);
        }
        const data = await this.bytes(response, json ? Math.min(this.maxBytes, 10 * 1024 * 1024) : this.maxBytes, operation);
        signal.throwIfAborted();
        this.log({ url: url.href, operation, attempt: attempt + 1, status, elapsed_ms: Date.now() - started, user_agent: userAgent, bytes: data.length });
        return { data, finalUrl: response.url || url.href, contentType: response.headers.get('content-type') ?? 'application/octet-stream', status };
      }
      catch (cause) {
        const error = cause instanceof PncpError ? cause : new PncpError(`Falha de transporte em ${operation}: ${cause instanceof Error ? cause.message : String(cause)}`, operation, !context.signal?.aborted, status, { cause });
        this.log({ url: url.href, operation, attempt: attempt + 1, status: status ?? null, elapsed_ms: Date.now() - started, user_agent: userAgent, error: errorDetails(error) });
        if (context.signal?.aborted)
          throw context.signal.reason;
        if (!error.retryable || attempt === this.retries)
          throw error;
        clearTimeout(timer);
        const base = this.options.backoffMs ?? 1000;
        const backoff = base * 2 ** attempt * (0.5 + (this.options.random ?? Math.random)());
        await delay(Math.max(backoff, (error.retryAt ?? 0) - Date.now()), undefined, { signal: context.signal });
      }
      finally {
        clearTimeout(timer);
      }
    }
    throw new PncpError('Tentativas HTTP esgotadas', operation);
  }
  async json(base: string, params: Record<string, string | number | undefined> = {}, operation = 'request', context: RequestContext = {}): Promise<unknown> {
    const url = remoteUrl(base);
    for (const [key, value] of Object.entries(params))
      if (value !== undefined)
        url.searchParams.set(key, String(value));
    const response = await this.request(url, operation, true, context);
    try {
      return JSON.parse(response.data.toString('utf8'));
    }
    catch (cause) {
      throw new PncpError(`JSON inválido em ${operation}`, operation, false, response.status, { cause });
    }
  }
  async download(rawUrl: string, operation = 'documento', context: RequestContext = {}): Promise<{
    data: Buffer;
    finalUrl: string;
    contentType: string;
    status: number;
  }> {
    return this.request(remoteUrl(rawUrl), operation, false, context);
  }
}
