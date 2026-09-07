import { getConfig } from "./config.js";

export interface Clock {
  now(): Date;
}

/** Returns the application clock, optionally frozen by TEST_NOW for reproducible runs. */
export function createClock(testNow = getConfig().testNow): Clock {
  if (!testNow) return { now: () => new Date() };
  const fixedDate = new Date(testNow);
  if (Number.isNaN(fixedDate.getTime())) throw new Error("TEST_NOW must be a valid date");
  return { now: () => new Date(fixedDate.getTime()) };
}

export function toSqliteTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").replace(".000Z", "").replace(/\.\d{3}Z$/, "");
}
