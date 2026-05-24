import type { ToolpackInterceptor, ToolpackNextFunction } from '../interceptors/types.js';
import type { CompletionRequest, CompletionResponse } from '../providers/base/index.js';
import type { SkillInterceptorOptions } from './types.js';
import { SkillIndexManager } from './index-manager.js';

export type { SkillInterceptorOptions };

export function createSkillInterceptor(options?: SkillInterceptorOptions): ToolpackInterceptor {
  const dir = options?.dir ?? '.toolpack/skills';
  const maxSkills = options?.maxSkills ?? 3;
  const minScore = options?.minScore ?? 0.3;
  const onValidationError = options?.onValidationError ?? 'fail';

  const manager = new SkillIndexManager({ dir, onValidationError });

  return Object.assign(
    async (request: CompletionRequest, next: ToolpackNextFunction): Promise<CompletionResponse> => {
      const messages = request.messages ?? [];

      // Find the last user message for BM25 query
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { lastUserIdx = i; break; }
      }
      const lastUserMsg = lastUserIdx >= 0 ? messages[lastUserIdx] : null;
      const query = lastUserMsg && typeof lastUserMsg.content === 'string' ? lastUserMsg.content.trim() : '';

      if (query) {
        const results = await manager.search(query, maxSkills, minScore);
        if (results.length > 0) {
          const blocks = results
            .map(r => `--- Skill: ${r.skill.title} ---\n${r.skill.instructions.trim()}\n---`)
            .join('\n\n');
          const injected = `<skill-instructions>\n${blocks}\n</skill-instructions>`;
          const newMessages = messages.map((m, i) =>
            i === lastUserIdx && typeof m.content === 'string'
              ? { ...m, content: `${injected}\n\n${m.content}` }
              : m
          );
          return next({ ...request, messages: newMessages });
        }
      }

      return next(request);
    },
    {
      /** Eagerly validate all skill files at Toolpack.init() time. */
      init: () => manager.ensureLoaded(),
    },
  );
}
