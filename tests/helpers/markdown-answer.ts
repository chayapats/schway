/** Four-column table rows with an unbroken cell wider than the narrow terminal. */
export const MARKDOWN_TABLE_ROWS = [
  ["Name", "State", "Count", "Owner"],
  ["A pneumonoultramicroscopicsilicovolcanoconiosis-with-an-extra-long-suffix", "B ready", "C seven", "D Ada"],
  ["E Beta", "F done", "G nine", "H Lin"],
] as const;

/** Original unwrapped source lines whose display must preserve every character. */
export const MARKDOWN_CODE_LINES = [
  'const message = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";',
  "console.log(message);",
] as const;

/** Scripted Markdown deltas containing a complete table and a long fenced code block. */
export const MARKDOWN_CHUNKS = [
  "Wrapping report\n\n" + MARKDOWN_TABLE_ROWS.map((row, index) => `| ${row.join(" | ")} |\n${index === 0 ? "| --- | --- | --- | --- |\n" : ""}`).join(""),
  "\n```ts\n" + MARKDOWN_CODE_LINES.join("\n") + "\n```\n\nEnd of wrapping report",
] as const;

/** Completed answer shared by rendered contract tests and the screen catalog. */
export const MARKDOWN_ANSWER = MARKDOWN_CHUNKS.join("");
