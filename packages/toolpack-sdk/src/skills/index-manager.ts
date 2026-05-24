import * as fs from 'fs/promises';
import * as path from 'path';
import { BM25Engine } from './bm25.js';
import { parseSkillFile } from './parser.js';
import { validateSkill } from './validator.js';
import type { Skill, SkillSearchResult, SkillValidationMode } from './types.js';

interface IndexManagerOptions {
  dir: string;
  onValidationError: SkillValidationMode;
}

/**
 * Manages the BM25 index for skill files.
 * Loads on first use, auto-reindexes when file mtimes change.
 */
export class SkillIndexManager {
  private readonly dir: string;
  private readonly onValidationError: SkillValidationMode;

  private loaded = false;
  private skills: Map<string, Skill> = new Map(); // name -> Skill
  private fileMtimes: Map<string, number> = new Map(); // filePath -> mtime (all files, valid + invalid)
  private index: BM25Engine = new BM25Engine();
  /** In-flight build promise — prevents concurrent rebuilds from corrupting the BM25 index. */
  private _buildPromise: Promise<void> | null = null;

  constructor(options: IndexManagerOptions) {
    // Resolve to absolute path so path.relative() is always consistent,
    // regardless of how the caller specified the directory.
    this.dir = path.resolve(options.dir);
    this.onValidationError = options.onValidationError;
  }

  /**
   * Recursively find all .skill.md files under a directory.
   */
  private async findSkillFiles(dir: string): Promise<string[]> {
    const result: string[] = [];
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return result;
    }

    for (const name of names) {
      const fullPath = path.join(dir, name);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const nested = await this.findSkillFiles(fullPath);
        result.push(...nested);
      } else if (stat.isFile() && name.endsWith('.skill.md')) {
        result.push(fullPath);
      }
    }

    return result;
  }

  /**
   * Build the searchable content for a skill with field weighting.
   * name/title ×3, tags/triggers ×2, description ×1
   */
  private buildIndexContent(skill: Skill): string {
    const parts: string[] = [];

    // name and title: high weight (×3)
    parts.push(skill.name, skill.name, skill.name);
    parts.push(skill.title, skill.title, skill.title);

    // tags and triggers: medium weight (×2)
    for (const tag of skill.tags) {
      parts.push(tag, tag);
    }
    for (const trigger of skill.triggers) {
      parts.push(trigger, trigger);
    }

    // description: base weight (×1)
    parts.push(skill.description);

    return parts.join(' ');
  }

  /**
   * Check if the index needs to be rebuilt by comparing mtimes.
   */
  private async needsRebuild(filePaths: string[]): Promise<boolean> {
    if (!this.loaded) return true;
    if (filePaths.length !== this.fileMtimes.size) return true;

    for (const filePath of filePaths) {
      try {
        const stat = await fs.stat(filePath);
        const cached = this.fileMtimes.get(filePath);
        // Also triggers when a previously unseen file appears (cached === undefined).
        if (cached === undefined || stat.mtimeMs !== cached) return true;
      } catch {
        return true;
      }
    }

    return false;
  }

  /**
   * Build the in-memory index from all skill files.
   */
  private async buildIndex(filePaths: string[]): Promise<void> {
    // Reset loaded first so that if we throw, the next ensureLoaded() call
    // knows the index is in an inconsistent state and tries again.
    this.loaded = false;
    this.skills.clear();
    this.fileMtimes.clear();
    this.index.clear();

    const validationErrors: { file: string; errors: string[] }[] = [];
    const validSkills: Skill[] = [];
    // Track names seen so far to detect duplicate skill names across files.
    const seenNames = new Map<string, string>(); // name -> first relFile

    for (const filePath of filePaths) {
      let content: string;
      let mtime: number;

      try {
        const [fileContent, stat] = await Promise.all([
          fs.readFile(filePath, 'utf-8'),
          fs.stat(filePath),
        ]);
        // Normalize CRLF → LF so all regexes work on any platform.
        content = fileContent.replace(/\r\n/g, '\n');
        mtime = stat.mtimeMs;
      } catch {
        continue;
      }

      // Record mtime for ALL files (valid and invalid) so needsRebuild
      // can correctly compare filePaths.length to fileMtimes.size even
      // when some skills are skipped due to validation errors in 'warn' mode.
      this.fileMtimes.set(filePath, mtime);

      const skill = parseSkillFile(content, filePath, this.dir);
      skill.lastModified = mtime;

      const relFile = path.relative(this.dir, filePath);
      const validation = validateSkill(skill, relFile);

      if (validation.warnings.length > 0) {
        for (const w of validation.warnings) {
          console.warn(`[skills] ${relFile}: ${w}`);
        }
      }

      if (validation.errors.length > 0) {
        validationErrors.push({ file: relFile, errors: validation.errors });
        if (this.onValidationError === 'warn') {
          console.warn(`[skills] Skipping invalid skill "${relFile}": ${validation.errors.join('; ')}`);
        }
        continue;
      }

      // Detect duplicate skill names — two files with the same name: field would
      // corrupt the BM25 index (term frequencies accumulate without a clear).
      const firstName = seenNames.get(skill.name);
      if (firstName) {
        const dupError = `duplicate skill name "${skill.name}" — already defined in "${firstName}"`;
        validationErrors.push({ file: relFile, errors: [dupError] });
        if (this.onValidationError === 'warn') {
          console.warn(`[skills] Skipping "${relFile}": ${dupError}`);
        }
        continue;
      }
      seenNames.set(skill.name, relFile);

      validSkills.push(skill);
    }

    if (validationErrors.length > 0 && this.onValidationError === 'fail') {
      const detail = validationErrors
        .map(e => `  ${e.file}:\n    ${e.errors.join('\n    ')}`)
        .join('\n');
      throw new Error(`Skills validation failed — fix the following files before starting:\n${detail}`);
    }

    for (const skill of validSkills) {
      this.skills.set(skill.name, skill);
      this.index.addDocument(skill.name, this.buildIndexContent(skill));
    }

    this.loaded = true;
  }

  /**
   * Ensure the index is loaded and up to date.
   *
   * Concurrent callers share the same in-flight build promise so the BM25
   * engine is never rebuilt from two goroutines simultaneously (which would
   * cause duplicate term-frequency accumulation and corrupt scores).
   */
  async ensureLoaded(): Promise<void> {
    // Fast path: a build is already in flight — join it and return.
    if (this._buildPromise) return this._buildPromise;

    const filePaths = await this.findSkillFiles(this.dir);

    // After the async file scan, a concurrent caller may have started a build.
    if (this._buildPromise) return this._buildPromise;

    if (!await this.needsRebuild(filePaths)) return;

    // One more check: a concurrent call may have finished a build during
    // the needsRebuild scan and set loaded = true.
    if (this._buildPromise) return this._buildPromise;

    // We are the designated builder. Set the promise synchronously (no await
    // between here and the assignment) so any concurrent caller that resumes
    // next will see it and join rather than starting a second build.
    this._buildPromise = this.buildIndex(filePaths).finally(() => {
      this._buildPromise = null;
    });
    return this._buildPromise;
  }

  /**
   * Search skills by query, returning top results above minScore.
   */
  async search(query: string, limit: number, minScore: number): Promise<SkillSearchResult[]> {
    await this.ensureLoaded();

    const results = this.index.search(query, limit);
    const output: SkillSearchResult[] = [];

    for (const result of results) {
      if (result.score < minScore) continue;
      const skill = this.skills.get(result.id);
      if (!skill) continue;
      output.push({ skill, score: result.score });
    }

    return output;
  }

  /**
   * Find a skill by name.
   */
  async get(name: string): Promise<Skill | undefined> {
    await this.ensureLoaded();
    return this.skills.get(name);
  }

  /**
   * List all valid skills, optionally filtered by tag.
   */
  async list(options?: { tag?: string }): Promise<Skill[]> {
    await this.ensureLoaded();
    const all = Array.from(this.skills.values());
    if (options?.tag) {
      return all.filter(s => s.tags.includes(options.tag!));
    }
    return all;
  }
}
