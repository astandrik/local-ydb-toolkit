import type { JsonValue } from "./sql-parameter-types.js";

export const MAX_DATE_DAYS = 49_673n;
export const MAX_TIMESTAMP_MICROS = 4_291_747_200_000_000n;
export const MIN_DATE32_DAYS = -53_375_809n;
export const MAX_DATE32_DAYS = 53_375_807n;
export const MIN_DATETIME64_SECONDS = -4_611_669_897_600n;
export const MAX_DATETIME64_SECONDS = 4_611_669_811_199n;
export const MIN_TIMESTAMP64_MICROS = -4_611_669_897_600_000_000n;
export const MAX_TIMESTAMP64_MICROS = 4_611_669_811_199_999_999n;
export const MAX_INTERVAL64_MICROS = 9_223_339_708_799_999_999n;

export function parseIsoDate(value: JsonValue, label: string): bigint {
  if (typeof value !== "string") {
    throw new Error(`${label} value must be an ISO date string`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`${label} value must use YYYY-MM-DD`);
  }
  return parseIsoDateMatch(match, label);
}

export function parseWideIsoDate(value: JsonValue, label: string): bigint {
  if (typeof value !== "string") {
    throw new Error(`${label} value must be an ISO date string`);
  }
  const match = /^([+-]?\d{4,6})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`${label} value must use a wide ISO date`);
  }
  return parseIsoDateMatch(match, label);
}

export function parseIsoDateTime(
  value: JsonValue,
  fractional: boolean,
  label: string,
): { seconds: bigint; micros: bigint } {
  if (typeof value !== "string") {
    throw new Error(`${label} value must be an ISO UTC date-time string`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/
    .exec(value);
  if (!match || (!fractional && match[7] !== undefined)) {
    throw new Error(`${label} value must be an ISO UTC date-time string`);
  }
  return parseIsoDateTimeMatch(match, label, parseIsoDate);
}

export function parseWideIsoDateTime(
  value: JsonValue,
  fractional: boolean,
  label: string,
): { seconds: bigint; micros: bigint } {
  if (typeof value !== "string") {
    throw new Error(`${label} value must be an ISO UTC date-time string`);
  }
  const match = /^([+-]?\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/
    .exec(value);
  if (!match || (!fractional && match[7] !== undefined)) {
    throw new Error(`${label} value must be a wide ISO UTC date-time string`);
  }
  return parseIsoDateTimeMatch(match, label, parseWideIsoDate);
}

export function parseIsoInterval(value: JsonValue, label: string): bigint {
  if (typeof value !== "string") {
    throw new Error(`${label} value must be an ISO 8601 interval string`);
  }
  const match = /^(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d{1,6}))?S)?)?$/
    .exec(value);
  if (!match || match.slice(2).every((part) => part === undefined)) {
    throw new Error(`${label} value must be an ISO 8601 interval without years or months`);
  }
  const seconds = BigInt(match[2] ?? 0) * 7n * 86_400n
    + BigInt(match[3] ?? 0) * 86_400n
    + BigInt(match[4] ?? 0) * 3_600n
    + BigInt(match[5] ?? 0) * 60n
    + BigInt(match[6] ?? 0);
  const fraction = BigInt((match[7] ?? "").padEnd(6, "0") || "0");
  const micros = seconds * 1_000_000n + fraction;
  return match[1] ? -micros : micros;
}

export function parseTzValue(
  value: JsonValue,
  kind: "date" | "datetime" | "timestamp",
  label: string,
): string {
  if (typeof value !== "string") {
    throw new Error(`${label} value must be a timezone-qualified string`);
  }
  const comma = value.lastIndexOf(",");
  if (comma <= 0 || comma === value.length - 1) {
    throw new Error(`${label} value must end with an IANA timezone name`);
  }
  const dateTime = value.slice(0, comma);
  const timeZone = value.slice(comma + 1);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(`${label} value has an unknown timezone: ${timeZone}`);
  }
  if (kind === "date") {
    requireRange(parseIsoDate(dateTime, label), 0n, MAX_DATE_DAYS - 1n, label);
  } else {
    const parsed = parseIsoDateTime(`${dateTime}Z`, kind === "timestamp", label);
    requireRange(parsed.micros, 0n, MAX_TIMESTAMP_MICROS - 1n, label);
  }
  return value;
}

export function formatIsoDate(days: bigint): string {
  const { year, month, day } = daysToCivil(days);
  return `${formatYear(year)}-${pad2(month)}-${pad2(day)}`;
}

export function formatIsoDateTime(micros: bigint, fractional: boolean): string {
  const seconds = floorDiv(micros, 1_000_000n);
  const subsecond = micros - seconds * 1_000_000n;
  const days = floorDiv(seconds, 86_400n);
  const secondOfDay = seconds - days * 86_400n;
  const hour = Number(secondOfDay / 3_600n);
  const minute = Number(secondOfDay % 3_600n / 60n);
  const second = Number(secondOfDay % 60n);
  const suffix = fractional ? `.${subsecond.toString().padStart(6, "0")}` : "";
  return `${formatIsoDate(days)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}${suffix}Z`;
}

export function formatIsoInterval(microsValue: bigint): string {
  const negative = microsValue < 0n;
  let micros = negative ? -microsValue : microsValue;
  const days = micros / 86_400_000_000n;
  micros %= 86_400_000_000n;
  const hours = micros / 3_600_000_000n;
  micros %= 3_600_000_000n;
  const minutes = micros / 60_000_000n;
  micros %= 60_000_000n;
  const seconds = micros / 1_000_000n;
  const fraction = micros % 1_000_000n;
  let result = "P";
  if (days > 0n) {
    result += `${days}D`;
  }
  if (hours > 0n || minutes > 0n || seconds > 0n || fraction > 0n || days === 0n) {
    result += "T";
    if (hours > 0n) result += `${hours}H`;
    if (minutes > 0n) result += `${minutes}M`;
    const fractionText = fraction === 0n
      ? ""
      : `.${fraction.toString().padStart(6, "0").replace(/0+$/, "")}`;
    result += `${seconds}${fractionText}S`;
  }
  return negative && microsValue !== 0n ? `-${result}` : result;
}

function parseIsoDateMatch(match: RegExpExecArray, label: string): bigint {
  const year = BigInt(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new Error(`${label} value is not a valid calendar date`);
  }
  return civilToDays(year, month, day);
}

function parseIsoDateTimeMatch(
  match: RegExpExecArray,
  label: string,
  parseDate: (value: JsonValue, label: string) => bigint,
): { seconds: bigint; micros: bigint } {
  const days = parseDate(`${match[1]}-${match[2]}-${match[3]}`, label);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`${label} value is not a valid clock time`);
  }
  const seconds = days * 86_400n + BigInt(hour * 3_600 + minute * 60 + second);
  const subsecond = BigInt((match[7] ?? "").padEnd(6, "0") || "0");
  return { seconds, micros: seconds * 1_000_000n + subsecond };
}

function civilToDays(yearValue: bigint, month: number, day: number): bigint {
  let year = yearValue;
  if (month <= 2) year -= 1n;
  const era = floorDiv(year, 400n);
  const yearOfEra = year - era * 400n;
  const adjustedMonth = BigInt(month + (month > 2 ? -3 : 9));
  const dayOfYear = (153n * adjustedMonth + 2n) / 5n + BigInt(day - 1);
  const dayOfEra = yearOfEra * 365n + yearOfEra / 4n
    - yearOfEra / 100n + dayOfYear;
  return era * 146_097n + dayOfEra - 719_468n;
}

function daysToCivil(days: bigint): { year: bigint; month: number; day: number } {
  const z = days + 719_468n;
  const era = floorDiv(z, 146_097n);
  const dayOfEra = z - era * 146_097n;
  const yearOfEra = (
    dayOfEra - dayOfEra / 1_460n + dayOfEra / 36_524n - dayOfEra / 146_096n
  ) / 365n;
  let year = yearOfEra + era * 400n;
  const dayOfYear = dayOfEra - (
    365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n
  );
  const monthPrime = (5n * dayOfYear + 2n) / 153n;
  const day = Number(dayOfYear - (153n * monthPrime + 2n) / 5n + 1n);
  const month = Number(monthPrime + (monthPrime < 10n ? 3n : -9n));
  if (month <= 2) year += 1n;
  return { year, month, day };
}

function daysInMonth(year: bigint, month: number): number {
  if (month === 2) {
    const leap = year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function requireRange(
  value: bigint,
  minimum: bigint,
  maximum: bigint,
  label: string,
): void {
  if (value < minimum || value > maximum) {
    throw new Error(`${label} value must be between ${minimum} and ${maximum}`);
  }
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  const remainder = value % divisor;
  return remainder < 0n ? quotient - 1n : quotient;
}

function formatYear(year: bigint): string {
  if (year >= 0n && year <= 9_999n) {
    return year.toString().padStart(4, "0");
  }
  const sign = year < 0n ? "-" : "+";
  const magnitude = year < 0n ? -year : year;
  return `${sign}${magnitude.toString().padStart(6, "0")}`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}
