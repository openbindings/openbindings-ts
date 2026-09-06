/** Opt-in consumer policy; never an implicit binding or native-engine default.
 * Matches the Go adapter's DecimalParameterConversion on shared JSON values.
 */
export function decimalParameterConversion(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error("parameter requires a string, boolean, or interoperable finite number");
  }
  if (value === 0) return "0";
  const text = String(value);
  if (!text.includes("e")) return text;
  const [mantissa, exponent] = text.split("e") as [string, string];
  const sign = mantissa.startsWith("-") ? "-" : "";
  const unsigned = sign ? mantissa.slice(1) : mantissa;
  const [whole, fraction = ""] = unsigned.split(".") as [string, string?];
  const digits = whole + fraction;
  const position = whole.length + Number(exponent);
  return sign + (position <= 0
    ? "0." + "0".repeat(-position) + digits
    : position >= digits.length
      ? digits + "0".repeat(position - digits.length)
      : digits.slice(0, position) + "." + digits.slice(position));
}
