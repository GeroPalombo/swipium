// Typed-text read-back: does a text field hold what was typed? Shared by
// qa_act type and the flow runner's inputText step. Pure.

export type ReadBackVerdict = 'match' | 'reformatted' | 'truncated' | 'mismatch';

/** PURE: what a text-field node may hold, the value first. A hint shown in an empty
 * field counts as empty. A labeled Compose field reads back "<value>, <label>" in both text and
 * content-desc, so its value is the text without that last ", <label>" part; the raw text is
 * kept as a second reading for a value that itself contains ", ".
 * `label` is the field's Compose label when the caller knows it (composeLabelOf on the node
 * before typing): only that ", <label>" suffix is dropped, so text left after ", " by a failed clear
 * is compared as is. null: the field had no Compose label (raw text only). undefined: unknown, any
 * last ", " part of a text == content-desc EditText counts as the label. */
export function textFieldReadings(
  n: { cls: string; text: string; desc: string; attrs: Record<string, string> },
  label?: string | null,
): string[] {
  const hint = (n.attrs['hint'] ?? '').trim();
  if (hint && n.text === hint) return [''];
  if (hint && n.text.endsWith(`, ${hint}`)) return [n.text.slice(0, -(hint.length + 2)), n.text];
  if (!/EditText/.test(n.cls) || !n.desc || n.desc !== n.text || label === null) return [n.text];
  if (label !== undefined) {
    if (n.text === label) return ['', n.text];
    return n.text.endsWith(`, ${label}`) ? [n.text.slice(0, -(label.length + 2)), n.text] : [n.text];
  }
  const cut = n.text.lastIndexOf(', ');
  if (cut >= 0) return [n.text.slice(0, cut), n.text];
  return [n.text];
}

/** PURE: the Compose label of a text field from its node BEFORE typing, for
 * textFieldReadings. A labeled Compose field reads `<label>` empty and `<value>, <label>` filled, in
 * both text and content-desc. undefined when the node can't tell (no node, or no content-desc), null
 * when it has no such label. */
export function composeLabelOf(n?: { cls: string; text: string; desc: string }): string | null | undefined {
  if (!n || !n.desc) return undefined;
  if (!/EditText/.test(n.cls) || (n.text !== n.desc && n.text !== '')) return null;
  const cut = n.desc.lastIndexOf(', ');
  return cut >= 0 ? n.desc.slice(cut + 2) : n.desc;
}

/** PURE: does a field's value read back the typed text? Replace mode wants the whole value,
 * append mode wants it somewhere in the value. Whitespace runs and case are ignored ('match'). The
 * same letters and digits with other punctuation/spacing (an input mask, smart quotes), or a phone
 * country code in front, are 'reformatted'. A replaced value that is a non-empty start of the typed
 * text is 'truncated' (a max length, or a one-digit OTP box that hands the rest to the next box).
 * Anything else (reordered, dropped mid-way, old text left, nothing typed) is 'mismatch'. */
export function typedReadBack(value: string, typed: string, replace: boolean): ReadBackVerdict {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const [v, t] = [norm(value), norm(typed)];
  if (replace ? v === t : v.includes(t)) return 'match';
  const [lv, lt] = [loose(value), loose(typed)];
  if (lt && (replace ? lv === lt : lv.includes(lt))) return 'reformatted';
  // A phone field that shows a country code before the typed number ("+1 555..." for "555...").
  if (replace && lt && /^\s*\+\d/.test(value) && lv.endsWith(lt) && /^\d{1,3}$/.test(lv.slice(0, lv.length - lt.length)))
    return 'reformatted';
  if (replace && lv && lt.startsWith(lv)) return 'truncated';
  // Typed text followed or preceded by other text stays a mismatch in replace mode: old text left
  // behind looks exactly like an inline autocompletion, and leftovers must fail.
  return 'mismatch';
}

/** PURE: the best typedReadBack verdict over a field node's readings, and the length of its value. */
export function fieldReadBack(
  n: { cls: string; text: string; desc: string; attrs: Record<string, string> },
  typed: string,
  replace: boolean,
  label?: string | null,
): { verdict: ReadBackVerdict; valueLength: number } {
  const rank: ReadBackVerdict[] = ['match', 'reformatted', 'truncated', 'mismatch'];
  const readings = textFieldReadings(n, label);
  const verdict = readings.map((r) => typedReadBack(r, typed, replace)).reduce((a, b) => (rank.indexOf(b) < rank.indexOf(a) ? b : a));
  return { verdict, valueLength: readings[0].length };
}
