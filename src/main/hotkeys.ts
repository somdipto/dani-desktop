/** Map a keyboard event to an Electron accelerator. Uses `code` (physical key)
 *  so Option-modified glyphs on macOS don't become invalid accelerators. */

const CODE_TO_KEY: Record<string, string> = {
  Space: "Space",
  Escape: "Escape",
  Enter: "Return",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

export type KeyChord = {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

export function acceleratorFromKeyEvent(e: KeyChord): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const main = physicalKey(e.code);
  if (!main) return null;
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (parts.length === 0 && !/^F\d+$/.test(main)) return null;
  parts.push(main);
  return parts.join("+");
}

function physicalKey(code: string): string | null {
  if (code === "Space") return "Space";
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_TO_KEY[code] ?? null;
}
