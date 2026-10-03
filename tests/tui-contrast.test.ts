import { expect, test } from "bun:test";
import { mixColor, readableForeground, resolveTheme, tint } from "../src/tui/theme.ts";

// Independent measurement of the emitted RGB bytes, not the resolver's search intermediates.
function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16) / 255);
    const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("selected sign-in metadata reaches 4.5 on its actual composed dark background", () => {
  const original = "#8b95a7", background = "#33475e";
  expect(contrast(original, background)).toBeCloseTo(3.1560, 4);
  const foreground = readableForeground(original, background);
  expect(foreground).toMatch(/^#[0-9a-f]{6}$/);
  expect(contrast(foreground!, background)).toBeGreaterThanOrEqual(4.5);
});

function expectReadable(role: string, preferred: string, background: string): string {
  const result = readableForeground(preferred, background);
  expect(result, `${role}: resolved RGB inputs must produce a foreground`).toMatch(/^#[0-9a-f]{6}$/i);
  const ratio = contrast(result!, background);
  expect(ratio, `${role}: ${result} on ${background} measures ${ratio}:1`).toBeGreaterThanOrEqual(4.5);
  if (contrast(preferred, background) >= 4.5) expect(result, `${role}: preserve the passing foreground`).toBe(preferred);
  return result!;
}

test("contrast measurement agrees with numeric reference pairs and byte rounding boundaries", () => {
  expect(contrast("#000000", "#ffffff")).toBe(21);
  expect(contrast("#abcdef", "#abcdef")).toBe(1);
  expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.4781, 4);
  expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.5422, 4);
  expect(contrast("#747474", "#000000")).toBeCloseTo(4.4929, 4);
  expect(readableForeground("#777777", "#ffffff")).toBe("#767676");
  expect(readableForeground("#747474", "#000000")).toBe("#757575");
});

// Actual composed style runs from the #245 catalog at 09c943c, plus captured focus/animation states.
const observed = [
  ["NO_COLOR dark selected metadata/diff number", "#8b95a7", "#4a505a", 2.6891],
  ["dark added-line number", "#8b95a7", "#374a48", 3.1110],
  ["dark removed-line number", "#8b95a7", "#4e3f48", 3.2674],
  ["light selected metadata", "#545e6c", "#c7d2d6", 4.2629],
  ["light added-line number", "#545e6c", "#c9d3ca", 4.2741],
  ["light removed-line number", "#545e6c", "#dacbc7", 4.1784],
  ["dark selected deletes metadata", "#beae8e", "#33475e", 4.3720],
  ["NO_COLOR dark selected deletes metadata", "#b9c0cc", "#4a505a", 4.4368],
  ["dark neutral Not connected pill", "#8b95a7", "#303641", 4.0209],
  ["dark search-selected secondary text", "#8b95a7", "#2c3444", 4.1354],
  ["light search-selected secondary text", "#545e6c", "#c5c9cf", 3.9535],
  ["light search-selected You heading", "#0a5894", "#c5c9cf", 4.4527],
  ["NO_COLOR light selected metadata/diff number", "#545e6c", "#c9ccca", 4.0611],
  ["dark flash success label", "#8fd19e", "#466157", 3.7909],
  ["light flash success label", "#19612f", "#9bb6a1", 3.4379],
  ["NO_COLOR dark flash disclosure/output", "#8b95a7", "#646973", 1.8254],
  ["NO_COLOR light flash disclosure/output", "#545e6c", "#9ca0a0", 2.4884],
  ["dark Waiting pill at fade start", "#0e1117", "#31433f", 1.8045],
  ["light Waiting pill at fade start", "#ffffff", "#d3dcd4", 1.4040],
  ["NO_COLOR dark Waiting pill at fade start", "#0e1117", "#444951", 2.0856],
  ["NO_COLOR light Waiting pill at fade start", "#f7f7f4", "#d3d5d3", 1.3751],
  ["light Waiting pill during fade", "#ffffff", "#467fa7", 4.3262],
] as const;

for (const [role, preferred, background, measured] of observed) test(`${role} is readable on the observed background`, () => {
  expect(contrast(preferred, background), role).toBeCloseTo(measured, 4);
  const result = expectReadable(role, preferred, background);
  expect(result).not.toBe(preferred);
  // Keep intermediate semantic colors; a global black/white replacement would flatten every role.
  expect(result).not.toBe("#000000");
  expect(result).not.toBe("#ffffff");
});

for (const mode of ["dark", "light"] as const) for (const noColor of [false, true]) {
  const label = `${noColor ? "NO_COLOR " : ""}${mode}`;
  test(`${label} preserves passing roles and adjusts resolved selections and dynamic fills`, () => {
    const theme = resolveTheme(mode, null, noColor ? { NO_COLOR: "1" } : {});
    const before = JSON.stringify(theme);
    for (const background of [theme.background, theme.surface, theme.surface2]) {
      for (const role of ["text", "muted", "accent", "success", "warning", "error", "code"] as const) {
        expectReadable(`${label} ${role} base`, theme[role], background);
      }
    }
    for (const background of [tint(theme, theme.accent), tint(theme, theme.success), tint(theme, theme.error), theme.border]) {
      for (const role of ["text", "muted", "accent", "success", "warning", "error"] as const) {
        expectReadable(`${label} ${role} selected/diff`, theme[role], background);
      }
      expectReadable(`${label} deletes metadata`, mixColor(theme.warning, theme.muted, 0.5), background);
    }
    expectReadable(`${label} neutral pill`, theme.muted, tint(theme, theme.muted, theme.surface));
    for (const fraction of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      const flash = mixColor(mixColor(theme.surface2, theme.success, 0.35), theme.surface2, fraction);
      expectReadable(`${label} flash output/disclosure at ${fraction}`, theme.muted, flash);
      expectReadable(`${label} flash status at ${fraction}`, theme.success, flash);
      const fill = mixColor(tint(theme, theme.success, theme.surface), theme.accent, fraction);
      expectReadable(`${label} pill fade at ${fraction}`, theme.onFill, fill);
      expectReadable(`${label} pill sweep at ${fraction}`, theme.onFill, mixColor(fill, theme.core, 0.28));
    }
    expect(JSON.stringify(theme)).toBe(before);
  });
}

test("already-readable foreground spelling and case stay byte-for-byte unchanged", () => {
  for (const preferred of ["#abcdef", "#ABCDEF", "#aBcDeF", "#FFFFFF"]) {
    expect(readableForeground(preferred, "#000000")).toBe(preferred);
  }
  expect(readableForeground("#0A0b0C", "#FFFFFF")).toBe("#0A0b0C");
});

test("rounded grayscale adjustments match the nearest passing byte across every background", () => {
  const gray = (value: number) => `#${value.toString(16).padStart(2, "0").repeat(3)}`;
  for (let value = 0; value <= 255; value++) {
    const background = gray(value);
    // Exhaustive byte-domain oracle, independent of the resolver's bounded blend search.
    const candidates = Array.from({ length: 256 }, (_, byte) => byte)
      .filter(byte => contrast(gray(byte), background) >= 4.5)
      .sort((a, b) => Math.abs(a - value) - Math.abs(b - value) || a - b);
    const result = expectReadable(`gray background ${value}`, background, background);
    expect(result).toBe(gray(candidates[0]!));
  }
});

test("unresolved or unsupported colors return no numerical contrast claim", () => {
  for (const unresolved of ["default", "idx7", "red", "transparent", "#abc", "#ffffff80", "#00000000", "#ffffffFF", "#gggggg", "#1234567", " #ffffff", "#ffffff\n", ""]) {
    expect(readableForeground("#8b95a7", unresolved), `background ${JSON.stringify(unresolved)}`).toBeUndefined();
    expect(readableForeground(unresolved, "#33475e"), `foreground ${JSON.stringify(unresolved)}`).toBeUndefined();
  }
});
