// Stock quantities arrive as decimal text with 3 places ("2.500"). Shown
// without trailing zeros ("2.5", "10"), exactly; never through floating point.
export function formatQuantity(text: string | number): string {
  const str = String(text ?? "0");
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(str.trim());
  if (match === null) return str;
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const whole = match[2]?.replace(/^0+(?=\d)/, "") ?? "0";
  const sign = whole === "0" && fraction === "" ? "" : (match[1] ?? "");
  return `${sign}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}
