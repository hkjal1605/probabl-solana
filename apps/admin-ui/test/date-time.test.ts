import { expect, test } from "bun:test";
import { dateTimeInputToUnixSeconds, unixSecondsToDateTimeInput } from "../src/lib/date-time";

test("UTC date/time inputs round trip Unix seconds exactly, including nonzero seconds and range boundaries", () => {
  for (const [seconds, display] of [
    ["0", "1970-01-01T00:00:00"],
    ["1", "1970-01-01T00:00:01"],
    ["1798761600", "2027-01-01T00:00:00"],
    ["1798761657", "2027-01-01T00:00:57"],
    ["2147483648", "2038-01-19T03:14:08"],
    ["253402300799", "9999-12-31T23:59:59"],
  ] as const) {
    expect(unixSecondsToDateTimeInput(seconds)).toBe(display);
    expect(dateTimeInputToUnixSeconds(display)).toBe(seconds);
  }
});

test("browser minute-only input means zero seconds; UTC does not depend on local offsets or daylight saving", () => {
  expect(dateTimeInputToUnixSeconds("2027-01-01T00:00")).toBe("1798761600");
  for (const date of ["2026-03-08T02:30:17", "2026-11-01T01:30:59", "2028-02-29T12:34:56"]) {
    const seconds = dateTimeInputToUnixSeconds(date);
    expect(seconds).toBe(String(Date.parse(`${date}Z`) / 1000));
    expect(unixSecondsToDateTimeInput(seconds)).toBe(date);
  }
});

test("incomplete, invalid, fractional and timezone-bearing edits fail rather than silently changing the instant", () => {
  for (const value of [
    "",
    "2027-01-01",
    "2027-1-1T00:00",
    "2027-01-01T00:",
    "2026-02-29T00:00",
    "2028-02-30T00:00",
    "2027-04-31T00:00",
    "2027-00-01T00:00",
    "2027-13-01T00:00",
    "2027-01-00T00:00",
    "2027-01-32T00:00",
    "2027-01-01T24:00",
    "2027-01-01T00:60",
    "2027-01-01T00:00:60",
    "2027-01-01T00:00:00.123",
    "2027-01-01T00:00Z",
    "2027-01-01T00:00+05:30",
    "1969-12-31T23:59:59",
    "0000-01-01T00:00",
    "10000-01-01T00:00",
    " 2027-01-01T00:00",
    "1798761600",
  ])
    expect(() => dateTimeInputToUnixSeconds(value)).toThrow();
});

test("invalid or undisplayable raw timestamps are not truncated or rounded", () => {
  for (const value of [
    "",
    "-1",
    "01",
    "1.5",
    "1e3",
    "NaN",
    "Infinity",
    "253402300800",
    "9007199254740993",
    "1798761600000",
  ])
    expect(() => unixSecondsToDateTimeInput(value)).toThrow();
});
