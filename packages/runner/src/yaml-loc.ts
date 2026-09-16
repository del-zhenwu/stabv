import { isSeq, LineCounter, parseDocument } from "yaml";

export type SourceLoc = { file?: string; line?: number };

/** 1-based line of each `spec.faults` entry, when the document has that sequence. */
export function faultLineNumbers(text: string): (number | undefined)[] {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, keepSourceTokens: true });
  const faults = doc.getIn(["spec", "faults"], true);
  if (!isSeq(faults)) return [];
  return faults.items.map((item) => {
    const range = (item as { range?: [number, number, number] | null }).range;
    if (!range) return undefined;
    return lineCounter.linePos(range[0]).line;
  });
}

export function faultPrefix(index: number, loc?: SourceLoc): string {
  const where = loc?.file && loc.line != null ? `${loc.file}:${loc.line}` : loc?.file ? loc.file : loc?.line != null ? `line ${loc.line}` : undefined;
  return where ? `${where}: faults[${index}]` : `faults[${index}]`;
}
