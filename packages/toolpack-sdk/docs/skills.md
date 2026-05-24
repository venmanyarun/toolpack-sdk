# Skills Reference

This document covers the skills system in Toolpack SDK — `createSkillInterceptor` and `createSkillTools`.

- `createSkillInterceptor(options)` validates `.skill.md` files at startup and injects matching skill instructions into every `Toolpack.generate()` call via BM25 search.
- `createSkillTools(options)` registers four LLM-callable tools for managing the skill library at runtime.

## 1. The `.skill.md` Format

Every skill file must follow this structure:

```markdown
---
name: code-review
title: Code Review
version: 1.0.0
tags: ["coding", "quality"]
updated: 2026-01-15T10:00:00.000Z
---

## Description

Guides the agent through a structured code review process. Used for PR reviews, security audits, and quality checks.

## Triggers

- "review this code"
- "check my pull request"
- "code review"

## Instructions

When reviewing code:
1. Check for security vulnerabilities first
2. Verify test coverage exists
3. Flag naming inconsistencies
4. Be constructive — suggest improvements, not just problems
5. Format feedback as inline comments where possible

## Examples

[Optional — loaded on-demand via skill.read only, never auto-injected]
```

### Field Limits

| Field | Limit |
|-------|-------|
| `name` | Max 50 chars. Must match `^[a-z][a-z0-9-]*$` |
| `title` | Max 100 chars |
| `tags` | Max 10 tags, each max 30 chars |
| `## Description` | Max 300 chars |
| `## Triggers` | 1–10 triggers, each max 100 chars |
| `## Instructions` | Max 2000 chars — the only section injected into context |
| `## Examples` | Max 3000 chars — loaded on-demand via `skill.read` only |

## 2. Directory Layout

```
.toolpack/
  skills/
    code-review.skill.md           # no category
    coding/
      security-review.skill.md    # category: coding
      performance-review.skill.md # category: coding
    communication/
      email-writing.skill.md      # category: communication
```

Subfolder names become the `category` field automatically.

## 3. `createSkillInterceptor`

```ts
import { Toolpack, createSkillInterceptor } from 'toolpack-sdk';

const toolpack = await Toolpack.init({
  provider: 'anthropic',
  interceptors: [
    createSkillInterceptor({
      dir: '.toolpack/skills',
      maxSkills: 3,
      minScore: 0.3,
      onValidationError: 'fail',
    }),
  ],
});
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dir` | string | `.toolpack/skills` | Path to the skill files directory |
| `maxSkills` | number | `3` | Maximum number of skills injected per message |
| `minScore` | number | `0.3` | BM25 relevance threshold. Skills scoring below this are ignored |
| `onValidationError` | `'fail'` \| `'warn'` | `'fail'` | `'fail'` throws at init time on any invalid file; `'warn'` skips invalid files and logs to stderr |

### Activation Flow

1. `Toolpack.generate()` is called with a user message.
2. The interceptor extracts the last user message text.
3. BM25 searches all skill files (name/title ×3, tags/triggers ×2, description ×1).
4. Skills scoring above `minScore` are selected, up to `maxSkills`.
5. Their `## Instructions` sections are prepended to the user message as a `<skill-instructions>` XML block.
6. The LLM runs with behavioral instructions already in context.

### Validation

All `.skill.md` files are validated at `Toolpack.init()` time — not on the first message. This means startup fails fast on malformed files rather than silently degrading at runtime.

**`'fail'` mode (default):** Any invalid file throws with a clear error that names the file and lists exactly what is wrong.

**`'warn'` mode:** Invalid files are skipped and logged to stderr. Valid files load normally.

### BM25 Index

- Built in-memory at startup — no external dependency required.
- Automatically reindexes when any `.skill.md` file's mtime changes.
- Worst-case context cost: `maxSkills × 2000 chars` (e.g., 6000 chars for `maxSkills: 3`).

## 4. `createSkillTools`

```ts
import { Toolpack, createSkillInterceptor, createSkillTools } from 'toolpack-sdk';

const toolpack = await Toolpack.init({
  provider: 'anthropic',
  interceptors: [
    createSkillInterceptor({ dir: '.toolpack/skills' }),
  ],
  customTools: [
    createSkillTools({ dir: '.toolpack/skills' }),
  ],
});
```

Both functions must point to the same `dir`.

### `skill.create`

Write a new `.skill.md` file.

```ts
// LLM calls this tool to create a new skill
{
  name: 'commit-messages',
  title: 'Commit Message Style',
  description: 'Enforces conventional commit format for all git commits.',
  triggers: ['write a commit message', 'commit this'],
  instructions: 'Always use conventional commits: feat|fix|chore|docs(scope): description',
  tags: ['git', 'coding'],
}
```

### `skill.read`

Read a skill by name, optionally specifying a section.

```ts
// Read only the examples section
{ name: 'code-review', section: 'examples' }
```

Valid `section` values: `all` (default), `metadata`, `description`, `triggers`, `instructions`, `examples`.

### `skill.update`

Update fields of an existing skill. Only provided fields are changed.

```ts
// Append new examples and add a tag
{ name: 'code-review', addExamples: '### Example 3\n...', addTags: ['security'] }
```

Parameters: `name` (required), then any of `title`, `description`, `triggers`, `instructions`, `addExamples`, `addTags`.

### `skill.list`

List all skills, optionally filtered by tag.

```ts
// List all coding skills with full details
{ tag: 'coding', verbose: true }
```

## 5. Complete Example

```ts
import { Toolpack, createSkillInterceptor, createSkillTools } from 'toolpack-sdk';

const toolpack = await Toolpack.init({
  provider: 'anthropic',
  interceptors: [
    createSkillInterceptor({
      dir: '.toolpack/skills',
      maxSkills: 3,
      minScore: 0.3,
      onValidationError: 'warn', // Skip invalid files in development
    }),
  ],
  customTools: [
    createSkillTools({ dir: '.toolpack/skills' }),
  ],
});

// User asks to review code → interceptor matches 'code-review' skill,
// prepends its instructions, and the LLM receives behavioral guidance automatically.
const response = await toolpack.generate('Can you review this PR?');
```

## Related

- [Skills Guide](https://toolpacksdk.com/guides/skills) — Full guide with `.skill.md` format, directory layout, and best practices
- [Skill Tools Reference](https://toolpacksdk.com/tools/skills) — Full parameter reference for the 4 skill management tools
- [MCP Integration](./MCP_INTEGRATION.md) — How to integrate MCP tool servers
