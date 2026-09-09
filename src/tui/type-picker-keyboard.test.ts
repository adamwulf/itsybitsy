import { expect, test } from "bun:test";
import { TypePickerKeyboard } from "./type-picker-keyboard";

test("queued Kitty text preserves Unicode and ignores releases and invalid code points", () => {
  const input: string[] = [];
  const keyboard = new TypePickerKeyboard({ kittyProtocolActive: true, write() {} }, () => false);
  for (const sequence of [
    "\x1b[0;1;104:233:128512u", // composed/IME text
    "\x1b[97;1:2;97u", // repeat
    "\x1b[32;;32u", // omitted default modifier
    "\x1b[97;1:3;97u", // release with associated text
    "\x1b[99;5u", // Ctrl+C remains a shortcut
    "\x1b[0;1;1114112u", // out of Unicode range
    "\x1b[200~paste\x1b[201~",
  ]) keyboard.handleInput(sequence, data => input.push(data));
  expect(input).toEqual(["hé😀", "a", " ", "\x1b[99;5u", "\x1b[0;1u", "\x1b[200~paste\x1b[201~"]);
});
