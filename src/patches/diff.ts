/** Aplicador de unified diff com busca tolerante de contexto (sem dependências). */

interface Hunk {
  oldBlock: string[];
  newBlock: string[];
  removedBlock: string[];
  oldStart: number;
}

function parseHunks(diff: string): Hunk[] {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === "" && i === lines.length - 1) continue;

    const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (header) {
      current = {
        oldBlock: [],
        newBlock: [],
        removedBlock: [],
        oldStart: Math.max(0, Number(header[1]) - 1),
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("\\") || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("@@")) continue;

    if (line.startsWith("+")) {
      current.newBlock.push(line.slice(1));
    } else if (line.startsWith("-")) {
      const value = line.slice(1);
      current.oldBlock.push(value);
      current.removedBlock.push(value);
    } else if (line.startsWith(" ")) {
      const value = line.slice(1);
      current.oldBlock.push(value);
      current.newBlock.push(value);
    } else if (line === "") {
      current.oldBlock.push("");
      current.newBlock.push("");
    }
  }
  return hunks;
}

function findLocation(
  source: string[],
  hunk: Hunk,
  from: number,
): number {
  const exact = hunk.oldBlock.join("\n");
  const removed = hunk.removedBlock.join("\n");
  const hint = hunk.oldStart;
  const window = Math.max(50, source.length);

  const search = (block: string[]): number => {
    const needle = block.join("\n");
    if (!needle) return -1;
    for (let offset = 0; offset <= window; offset += 1) {
      for (const candidate of offset === 0 ? [hint] : [hint + offset, hint - offset]) {
        if (candidate < from || candidate < 0) continue;
        if (source.slice(candidate, candidate + block.length).join("\n") === needle) {
          return candidate;
        }
      }
    }
    return -1;
  };

  // Primeiro o bloco completo (contexto + remoções); só depois apenas as remoções.
  const exactIndex = search(hunk.oldBlock);
  if (exactIndex >= 0) return exactIndex;
  const removedIndex = search(hunk.removedBlock);
  if (removedIndex >= 0) return removedIndex;
  void exact;
  void removed;

  // Último recurso: primeira linha removida isolada.
  const first = hunk.removedBlock[0];
  if (first) {
    for (let i = from; i < source.length; i += 1) {
      if (source[i] === first) return i;
    }
  }
  return -1;
}

export function applyUnifiedDiff(original: string, diff: string): string {
  const source = original === "" ? [] : original.split("\n");
  const hunks = parseHunks(diff);
  if (hunks.length === 0) throw new Error("Diff sem hunks válidos (@@ ... @@).");

  const output: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.oldBlock.length === 0) {
      const at = Math.min(hunk.oldStart, source.length);
      output.push(...source.slice(cursor, at), ...hunk.newBlock);
      cursor = at;
      continue;
    }
    const index = findLocation(source, hunk, cursor);
    if (index < 0) {
      throw new Error(`Não foi possível localizar o hunk na linha ${hunk.oldStart + 1}.`);
    }
    output.push(...source.slice(cursor, index), ...hunk.newBlock);
    cursor = index + hunk.oldBlock.length;
  }
  output.push(...source.slice(cursor));
  return output.join("\n");
}
