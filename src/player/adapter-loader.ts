import type {
  FragmentLoaderContext,
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderStats
} from "hls.js";
import { transformStreamAdapterPayload } from "../core/adapter";
import type { StreamAdapter } from "../shared/types";

export const MAX_ADAPTER_FRAGMENT_BYTES = 16 * 1024 * 1024;

function stats(): LoaderStats {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 }
  };
}

export function adapterFragmentLoader(adapter: StreamAdapter): { new (config: HlsConfig): Loader<FragmentLoaderContext> } {
  return class AdapterFragmentLoader implements Loader<FragmentLoaderContext> {
    context: FragmentLoaderContext | null = null;
    stats = stats();
    private controller = new AbortController();
    private callbacks: LoaderCallbacks<FragmentLoaderContext> | null = null;
    private response: Response | null = null;
    private timeout: number | undefined;
    private finished = false;

    constructor() {}

    load(context: FragmentLoaderContext, configuration: LoaderConfiguration, callbacks: LoaderCallbacks<FragmentLoaderContext>): void {
      if (this.context) throw new Error("Loader can only be used once.");
      this.context = context;
      this.callbacks = callbacks;
      this.stats.loading.start = performance.now();
      const maximumTime = Math.min(configuration.loadPolicy.maxLoadTimeMs || 15_000, 15_000);
      this.timeout = self.setTimeout(() => {
        if (this.finished) return;
        this.finished = true;
        this.stats.aborted = true;
        this.controller.abort();
        callbacks.onTimeout(this.stats, context, this.response);
      }, maximumTime);
      void this.fetch(context, callbacks);
    }

    private async fetch(context: FragmentLoaderContext, callbacks: LoaderCallbacks<FragmentLoaderContext>): Promise<void> {
      try {
        const headers = new Headers(context.headers || {});
        const rangeStart = context.rangeStart || 0;
        const rangeEnd = context.rangeEnd || 0;
        if (rangeEnd > rangeStart) headers.set("Range", `bytes=${rangeStart}-${rangeEnd - 1}`);
        const response = await fetch(context.url, {
          credentials: "omit",
          headers,
          referrerPolicy: "no-referrer",
          signal: this.controller.signal
        });
        this.response = response;
        if (!response.ok) throw Object.assign(new Error(response.statusText || `HTTP ${response.status}`), { code: response.status });
        this.stats.loading.first = performance.now();
        const declared = Number(response.headers.get("content-length")) || 0;
        if (declared > MAX_ADAPTER_FRAGMENT_BYTES) throw Object.assign(new Error("adapter-fragment-too-large"), { code: 413 });
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > MAX_ADAPTER_FRAGMENT_BYTES) {
              this.controller.abort();
              throw Object.assign(new Error("adapter-fragment-too-large"), { code: 413 });
            }
            chunks.push(value);
            this.stats.loaded = total;
            this.stats.chunkCount += 1;
          }
        } else {
          const value = new Uint8Array(await response.arrayBuffer());
          total = value.length;
          if (total > MAX_ADAPTER_FRAGMENT_BYTES) throw Object.assign(new Error("adapter-fragment-too-large"), { code: 413 });
          chunks.push(value);
          this.stats.loaded = total;
          this.stats.chunkCount = 1;
        }
        const input = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          input.set(chunk, offset);
          offset += chunk.length;
        }
        const output = transformStreamAdapterPayload(input, adapter);
        this.stats.total = total;
        this.stats.loading.end = performance.now();
        const elapsed = Math.max(1, this.stats.loading.end - this.stats.loading.start);
        this.stats.bwEstimate = Math.round((total * 8 * 1000) / elapsed);
        if (this.finished) return;
        this.finished = true;
        self.clearTimeout(this.timeout);
        callbacks.onSuccess({ url: response.url, data: output.buffer, code: response.status }, this.stats, context, response);
      } catch (error) {
        if (this.finished || this.stats.aborted) return;
        this.finished = true;
        self.clearTimeout(this.timeout);
        const failure = error as Error & { code?: number };
        callbacks.onError({ code: failure.code || 0, text: failure.message || "adapter-fragment-load-failed" }, context, this.response, this.stats);
      }
    }

    abort(): void {
      if (this.finished) return;
      this.finished = true;
      this.stats.aborted = true;
      self.clearTimeout(this.timeout);
      this.controller.abort();
      if (this.context) this.callbacks?.onAbort?.(this.stats, this.context, this.response);
    }

    destroy(): void {
      if (!this.finished) {
        this.finished = true;
        this.stats.aborted = true;
        self.clearTimeout(this.timeout);
        this.controller.abort();
      }
      this.callbacks = null;
      this.context = null;
      this.response = null;
    }

    getResponseHeader(name: string): string | null {
      return this.response?.headers.get(name) || null;
    }

    getCacheAge(): number | null {
      const value = this.response?.headers.get("age");
      return value ? Number(value) : null;
    }
  };
}
