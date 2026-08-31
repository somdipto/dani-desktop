import { acceleratorFromKeyEvent } from "../src/main/hotkeys";

function chord(
  partial: Partial<{
    key: string;
    code: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }>,
) {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

const cases: Array<[string, ReturnType<typeof chord>, string | null]> = [
  ["option-space", chord({ key: " ", code: "Space", altKey: true }), "Alt+Space"],
  [
    "cmd-option-space",
    chord({ key: " ", code: "Space", metaKey: true, altKey: true }),
    "CommandOrControl+Alt+Space",
  ],
  [
    "option-s-glyph",
    chord({ key: "ß", code: "KeyS", altKey: true }),
    "Alt+S",
  ],
  ["arrow-up-invalid-name", chord({ key: "ArrowUp", code: "ArrowUp", metaKey: true }), "CommandOrControl+Up"],
  ["lone-letter", chord({ key: "a", code: "KeyA" }), null],
  ["modifier-only", chord({ key: "Meta", code: "MetaLeft", metaKey: true }), null],
  ["escape-cmd", chord({ key: "Escape", code: "Escape", metaKey: true }), "CommandOrControl+Escape"],
];

let failed = 0;
for (const [name, input, expected] of cases) {
  const got = acceleratorFromKeyEvent(input);
  if (got !== expected) {
    console.error(`[smoke-hotkeys] FAIL ${name}: got ${got} expected ${expected}`);
    failed++;
  }
}
if (failed) process.exit(1);
process.stdout.write(`[smoke-hotkeys] ok ${cases.length} cases\n`);
