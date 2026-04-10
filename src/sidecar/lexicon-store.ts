import { readFile, writeFile } from 'node:fs/promises';

export interface LexiconEntry {
  description: string;
  [key: string]: unknown;
}

export type Lexicon = Record<string, LexiconEntry>;

/**
 * Persistent keyword command lexicon backed by config/lexicon.json.
 * Read on demand, written atomically on update.
 */
export class LexiconStore {
  constructor(private readonly path: string) {}

  async load(): Promise<Lexicon> {
    try {
      const raw = await readFile(this.path, 'utf-8');
      return JSON.parse(raw) as Lexicon;
    } catch {
      return {};
    }
  }

  async add(keyword: string, description: string): Promise<void> {
    const lex = await this.load();
    lex[keyword] = { description };
    await writeFile(this.path, JSON.stringify(lex, null, 2) + '\n', 'utf-8');
  }

  async remove(keyword: string): Promise<boolean> {
    const lex = await this.load();
    if (!(keyword in lex)) return false;
    delete lex[keyword];
    await writeFile(this.path, JSON.stringify(lex, null, 2) + '\n', 'utf-8');
    return true;
  }

  async list(): Promise<string> {
    const lex = await this.load();
    const keys = Object.keys(lex).sort();
    if (keys.length === 0) return '_(lexicon empty)_';
    return keys.map((k) => `• \`${k}\` — ${lex[k].description}`).join('\n');
  }
}
