// lib/korea/parser/extract-json.ts
//
// Extract the JSON object from a model reply. strict structured outputs cannot compile
// our schema (big object × batch array — rejected 400 "Schema is too complex" / grammar
// timeout), so we ask for JSON in the system prompt and parse defensively: drop any
// ```json fences and any prose around the object by slicing from the first '{' to the
// last '}'. Throws on bad JSON — the caller's try/catch decides what to do on failure.
//
// Shared by parser/run.ts (batch extraction) and ads/moderation.ts (single-ad
// moderation) so both AI callers parse replies IDENTICALLY — one helper, no drift.
export function extractJson(text: string): unknown {
  let s = text.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const inner = fenced?.[1];
  if (inner) s = inner.trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) s = s.slice(first, last + 1);
  return JSON.parse(s);
}
