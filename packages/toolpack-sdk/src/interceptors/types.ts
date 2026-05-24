import type { CompletionRequest, CompletionResponse } from '../providers/base/index.js';

export type ToolpackNextFunction = (request?: CompletionRequest) => Promise<CompletionResponse>;

/**
 * An interceptor that wraps each `generate()` call.
 *
 * It is a callable with an optional `init()` hook. When `init()` is present,
 * `Toolpack.init()` calls it once during startup — before any message is
 * processed — so interceptors can validate config, warm caches, or fail fast
 * on bad state (e.g. invalid skill files) rather than failing on the first request.
 *
 * Plain arrow functions without `init` are fully compatible with this type.
 */
export type ToolpackInterceptor = {
  (request: CompletionRequest, next: ToolpackNextFunction): Promise<CompletionResponse>;
  /** Optional startup hook called once by `Toolpack.init()`. */
  init?(): Promise<void>;
};
