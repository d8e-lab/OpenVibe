export type MmOutputType = 'EDIT' | 'SHELL';

export interface MmExtractResult {
  ok: boolean;
  type?: MmOutputType;
  /** Raw extracted payload (no trimming, preserves exact bytes between tags). */
  payload?: string;
  /** True when all expected closing tags were found. */
  strict?: boolean;
  /** Human-readable parse failure reason(s). */
  errors?: string[];
}

function findFirst(re: RegExp, text: string, startIndex = 0): RegExpExecArray | null {
  re.lastIndex = 0;
  const slice = text.slice(startIndex);
  const m = re.exec(slice);
  if (!m) return null;
  // Convert indices back to the original string space.
  (m as any).index = (m as any).index + startIndex;
  return m;
}

/**
 * Extracts the FIRST <MM_OUTPUT type="EDIT|SHELL"> ... </MM_OUTPUT> block,
 * then extracts its inner payload (<MM_PATCH>...</MM_PATCH> or <MM_SHELL>...</MM_SHELL>).
 *
 * Tolerance goals (per design):
 * - Case-insensitive tags/attrs, flexible whitespace
 * - type may use single or double quotes
 * - Missing closing tags => best-effort truncation (strict=false)
 * - If BOTH EDIT and SHELL blocks appear, fail (protocol violation)
 */
export function extractFirstMmOutput(text: string | null | undefined): MmExtractResult {
  const src = String(text ?? '');
  if (!src.trim()) {
    return { ok: false, errors: ['Empty content'] };
  }

  const openOuterRe = /<\s*mm_output\b([^>]*)>/i;
  const mOuterOpen = findFirst(openOuterRe, src, 0);
  if (!mOuterOpen) {
    return { ok: false, errors: ['No <MM_OUTPUT> block found'] };
  }

  // Ensure protocol: only accept the FIRST block; if there is another, fail.
  const mSecondOuter = findFirst(openOuterRe, src, (mOuterOpen.index ?? 0) + mOuterOpen[0].length);
  if (mSecondOuter) {
    return { ok: false, errors: ['Multiple <MM_OUTPUT> blocks found (protocol violation)'] };
  }

  const outerAttrs = mOuterOpen[1] ?? '';
  const typeAttrRe = /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i;
  const mType = typeAttrRe.exec(outerAttrs);
  const typeRaw = (mType?.[1] ?? mType?.[2] ?? mType?.[3] ?? '').trim().toUpperCase();
  const type = typeRaw === 'EDIT' || typeRaw === 'SHELL' ? (typeRaw as MmOutputType) : null;
  if (!type) {
    return { ok: false, errors: [`Invalid or missing type attribute on <MM_OUTPUT>: "${typeRaw || '(missing)'}"`] };
  }

  const outerStart = (mOuterOpen.index ?? 0) + mOuterOpen[0].length;
  const closeOuterRe = /<\s*\/\s*mm_output\s*>/i;
  const mOuterClose = findFirst(closeOuterRe, src, outerStart);
  const outerEnd = mOuterClose ? (mOuterClose.index ?? 0) : src.length;
  const outerBody = src.slice(outerStart, outerEnd);

  // If there is another MM_OUTPUT in the outerBody (e.g. nested), treat as violation.
  if (openOuterRe.test(outerBody)) {
    return { ok: false, errors: ['Nested <MM_OUTPUT> detected (protocol violation)'] };
  }

  const innerTag = type === 'EDIT' ? 'MM_PATCH' : 'MM_SHELL';
  const innerOpenRe = new RegExp(`<\\s*${innerTag}\\b[^>]*>`, 'i');
  const mInnerOpen = findFirst(innerOpenRe, outerBody, 0);
  if (!mInnerOpen) {
    return { ok: false, errors: [`Missing <${innerTag}> inside <MM_OUTPUT type="${type}">`] };
  }

  const innerStart = (mInnerOpen.index ?? 0) + mInnerOpen[0].length;
  const innerCloseRe = new RegExp(`<\\s*\\/\\s*${innerTag}\\s*>`, 'i');
  const mInnerClose = findFirst(innerCloseRe, outerBody, innerStart);
  const innerEnd = mInnerClose ? (mInnerClose.index ?? 0) : outerBody.length;
  const payload = outerBody.slice(innerStart, innerEnd);

  const strict = Boolean(mOuterClose && mInnerClose);

  // Protocol: do not allow mixed blocks. If the outerBody contains the OTHER inner tag, fail.
  const otherInnerTag = type === 'EDIT' ? 'MM_SHELL' : 'MM_PATCH';
  const otherInnerRe = new RegExp(`<\\s*${otherInnerTag}\\b`, 'i');
  if (otherInnerRe.test(outerBody)) {
    return { ok: false, errors: [`Found <${otherInnerTag}> inside <MM_OUTPUT type="${type}"> (protocol violation)`] };
  }

  return { ok: true, type, payload, strict, errors: [] };
}

