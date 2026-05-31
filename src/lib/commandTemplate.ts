export type CommandTemplate = string | string[];

export interface ResolvedCommand {
  command: string;
  args: string[];
  argv: string[];
  deprecatedString: boolean;
}

export function displayArgv(argv: string[]): string {
  return argv.map((arg) => (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(' ');
}

export function shellSplit(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let escape = false;
  for (const ch of input) {
    if (escape) {
      cur += ch;
      escape = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (escape) cur += '\\';
  if (quote) throw new Error(`Unclosed ${quote} quote in command template`);
  if (cur) out.push(cur);
  return out;
}

export function resolveCommandTemplate(template: CommandTemplate, vars: Record<string, string>): ResolvedCommand {
  const parts = Array.isArray(template) ? template : shellSplit(template);
  if (!parts.length || !parts[0]) throw new Error('Command template is empty');
  const replace = (value: string) => value.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, key: string) => vars[key] ?? m);
  const argv = parts.map(replace);
  return { command: argv[0], args: argv.slice(1), argv, deprecatedString: !Array.isArray(template) };
}
