import { Injectable } from '../decorators/core/injectable.decorator.js';
import { Optional } from '../decorators/core/optional.decorator.js';
import { HttpStatus } from '../enums/http-status.enum.js';
import { PipeTransform } from '../interfaces/features/pipe-transform.interface.js';
import {
  ErrorHttpStatusCode,
  HttpErrorByCode,
} from '../utils/http-error-by-code.util.js';
import { isNil, isNumber, isString } from '../utils/shared.utils.js';

/**
 * @publicApi
 */
export interface ParseDatePipeOptions {
  /**
   * If true, the pipe will return null or undefined if the value is not provided
   * @default false
   */
  optional?: boolean;
  /**
   * A factory whose result is returned when the value is `null` or `undefined`,
   * regardless of `optional`
   */
  default?: () => Date;
  /**
   * The HTTP status code to be used in the response when the validation fails.
   */
  errorHttpStatusCode?: ErrorHttpStatusCode;
  /**
   * A factory function that returns an exception object to be thrown
   * if validation fails.
   * @param error Error message
   * @returns The exception object
   */
  exceptionFactory?: (error: string) => any;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
// The offset from UTC, in hours, of the time zones `new Date()` reads by name
const TIME_ZONE_OFFSETS: Record<string, number> = {
  ut: 0,
  utc: 0,
  z: 0,
  gmt: 0,
  cdt: -5,
  cst: -6,
  edt: -4,
  est: -5,
  mdt: -6,
  mst: -7,
  pdt: -7,
  pst: -8,
};

type DateToken =
  | { type: 'number'; value: number; length: number }
  | { type: 'word'; value: string }
  | { type: 'symbol'; value: string }
  | { type: 'separator' };

const isDigit = (char: string | undefined) =>
  char !== undefined && char >= '0' && char <= '9';
// A run of characters from "A" up is a word, up to white space other than
// the line breaks U+2028 and U+2029, which V8's date parser reads in a word
const isWordChar = (char: string | undefined) =>
  char !== undefined &&
  char >= 'A' &&
  (!/\s/.test(char) ||
    char.charCodeAt(0) === 0x2028 ||
    char.charCodeAt(0) === 0x2029);
const isSymbol = (
  token: DateToken | undefined,
  symbol: string,
): token is { type: 'symbol'; value: string } =>
  token?.type === 'symbol' && token.value === symbol;
const isDay = (value: number) => value >= 1 && value <= 31;

/**
 * Splits a date string as V8's date parser does: into numbers, words (runs of
 * characters from "A" up, lowercased), the symbols ":", "-", "+", "." and ")",
 * and separators (text in parentheses, or any other character).
 */
function tokenizeDate(value: string): DateToken[] {
  const tokens: DateToken[] = [];
  let index = 0;
  while (index < value.length) {
    const start = index;
    const char = value[index];
    if (isDigit(char)) {
      while (isDigit(value[index])) {
        index++;
      }
      tokens.push({
        type: 'number',
        value: Number(value.slice(start, index)),
        length: index - start,
      });
    } else if (':-+.)'.includes(char)) {
      index++;
      tokens.push({ type: 'symbol', value: char });
    } else if (isWordChar(char)) {
      while (isWordChar(value[index])) {
        index++;
      }
      tokens.push({
        type: 'word',
        value: value.slice(start, index).toLowerCase(),
      });
    } else if (char === '(') {
      let depth = 0;
      do {
        if (value[index] === '(') {
          depth++;
        } else if (value[index] === ')') {
          depth--;
        }
        index++;
      } while (depth > 0 && index < value.length);
      tokens.push({ type: 'separator' });
    } else {
      index++;
      tokens.push({ type: 'separator' });
    }
  }
  return tokens;
}

/**
 * Reads the year, month and day of a date string the way `new Date()` does in
 * V8, before it rolls a day past the end of its month into the next month.
 * Returns `undefined` when the string has no date part to check.
 *
 * As in V8, an ISO date ("2024-02-30", "+002024-02-30T10:00:00Z") is read
 * first. The rest of the string, or a string that isn't one, is read as
 * a legacy date: a month name may stand anywhere ("Feb 30 2024", "30 Feb
 * 2024", "2024 Feb 30"), and a number is a part of the date unless it is part
 * of a time ("10:00:00.123") or of a UTC offset ("GMT+0300"). Missing parts
 * are 1, then the parts are ordered by whether the first one can be a day.
 *
 * @see https://github.com/v8/v8/blob/main/src/date/dateparser-inl.h
 */
function readDateParts(
  value: string,
): [year: number, month: number, day: number] | undefined {
  const tokens = tokenizeDate(value);
  let position = 0;
  const skipSymbol = (symbol: string) => {
    const isNext = isSymbol(tokens[position], symbol);
    if (isNext) {
      position++;
    }
    return isNext;
  };
  const readFixedLengthNumber = (length: number) => {
    const token = tokens[position];
    return token?.type === 'number' && token.length === length
      ? token.value
      : undefined;
  };

  const parts: number[] = [];
  let namedMonth: number | undefined;

  // "[+-yyyyyy|yyyy][-MM[-DD]]", then the end or a time after "T". Where the
  // string stops matching, the rest is read as a legacy date
  const readIsoDate = (): boolean => {
    const sign = tokens[position];
    if (isSymbol(sign, '+') || isSymbol(sign, '-')) {
      // Without a year after it, the sign is ignored
      position++;
      const year = readFixedLengthNumber(6);
      if (year === undefined) {
        return false;
      }
      position++;
      // "-000000" isn't a year, and is skipped
      if (sign.value === '-' && year === 0) {
        return false;
      }
      parts.push(sign.value === '-' ? -year : year);
    } else {
      const year = readFixedLengthNumber(4);
      if (year === undefined) {
        return false;
      }
      parts.push(year);
      position++;
    }
    if (skipSymbol('-')) {
      const month = readFixedLengthNumber(2);
      if (month === undefined || month < 1 || month > 12) {
        return false;
      }
      parts.push(month);
      position++;
      if (skipSymbol('-')) {
        const day = readFixedLengthNumber(2);
        if (day === undefined || !isDay(day)) {
          return false;
        }
        parts.push(day);
        position++;
      }
    }
    const next = tokens[position];
    // An ISO date is either read whole, with the time after "T", or invalid
    return next === undefined || (next.type === 'word' && next.value === 't');
  };
  const isIsoDate = readIsoDate();

  let hasReadNumber = parts.length > 0;
  // The parts of a time read so far: hours, minutes, seconds, milliseconds
  let timeParts = 0;
  let offsetHours: number | undefined;
  let offsetMinutes: number | undefined;
  const isTimeExpecting = (value: number) =>
    timeParts === 1 || timeParts === 2
      ? value <= 59
      : timeParts === 3 && value <= 999;

  while (!isIsoDate && position < tokens.length) {
    const token = tokens[position++];
    if (token.type === 'number') {
      hasReadNumber = true;
      if (skipSymbol(':')) {
        // "10:00", or "10::" for 10:00
        timeParts += skipSymbol(':') ? 2 : 1;
        skipSymbol('.');
      } else if (skipSymbol('.') && isTimeExpecting(token.value)) {
        // "10:00:00.123", whose milliseconds end the time
        position++;
        timeParts = 4;
      } else if (
        offsetHours !== undefined &&
        offsetMinutes === undefined &&
        token.value <= 59
      ) {
        // The minutes of "+03:00"
        offsetMinutes = token.value;
      } else if (isTimeExpecting(token.value)) {
        // The number after the last ":" of a time ends it
        timeParts = 4;
      } else {
        if (parts.length === 3) {
          return undefined;
        }
        parts.push(token.value);
        skipSymbol('-');
      }
    } else if (token.type === 'word') {
      const month = MONTH_NAMES.indexOf(token.value.slice(0, 3)) + 1;
      if (month > 0) {
        namedMonth = month;
        skipSymbol('-');
      } else if (
        hasReadNumber &&
        Object.hasOwn(TIME_ZONE_OFFSETS, token.value)
      ) {
        offsetHours = Math.abs(TIME_ZONE_OFFSETS[token.value]);
        offsetMinutes = 0;
      }
    } else if (
      (isSymbol(token, '+') || isSymbol(token, '-')) &&
      ((offsetHours === 0 && offsetMinutes === 0) || timeParts > 0)
    ) {
      // A UTC offset after a time or "GMT": "+3", "+03", "+0300" or "+03:00"
      const offset = tokens[position];
      const hours = offset?.type === 'number' ? offset.value : 0;
      const length = offset?.type === 'number' ? offset.length : 0;
      if (offset?.type === 'number') {
        position++;
      }
      hasReadNumber = true;
      if (isSymbol(tokens[position], ':')) {
        offsetHours = hours;
        offsetMinutes = undefined;
      } else if (length <= 2) {
        offsetHours = hours;
        offsetMinutes = 0;
      } else {
        offsetHours = Math.floor(hours / 100);
        offsetMinutes = hours % 100;
      }
    }
  }

  if (parts.length === 0) {
    return undefined;
  }
  while (parts.length < 3) {
    parts.push(1);
  }
  let [year, month, day] = parts;
  if (namedMonth !== undefined) {
    // "Feb 30 2024" and "30 Feb 2024", or "2024 Feb 30"
    month = namedMonth;
    [day, year] = isDay(parts[0]) ? parts : [parts[1], parts[0]];
  } else if (!isIsoDate && isDay(parts[0])) {
    // "02/30/2024", unless the first number can't be a day ("2024 02 30")
    [month, day, year] = parts;
  }
  // A year below 100 outside an ISO date is in the 2000s up to 49 ("2/29/24")
  if (!isIsoDate && year >= 0 && year <= 99) {
    year += year <= 49 ? 2000 : 1900;
  }
  return [year, month, day];
}

/**
 * @publicApi
 */
@Injectable()
export class ParseDatePipe implements PipeTransform {
  protected exceptionFactory: (error: string) => any;

  constructor(
    @Optional() protected readonly options: ParseDatePipeOptions = {},
  ) {
    const { exceptionFactory, errorHttpStatusCode = HttpStatus.BAD_REQUEST } =
      options;

    this.exceptionFactory =
      exceptionFactory ||
      (error => new HttpErrorByCode[errorHttpStatusCode](error));
  }

  /**
   * Method that accesses and performs optional transformation on argument for
   * in-flight requests.
   *
   * @param value currently processed route argument
   * @param metadata contains metadata about the currently processed route argument
   */
  transform(value: unknown): Date | null | undefined {
    if (isNil(value)) {
      // `default` applies to nil values whether or not `optional` is set.
      if (this.options.default) {
        return this.options.default();
      }
      if (this.options.optional) {
        return value;
      }
    }

    if (isNil(value) || value === '') {
      throw this.exceptionFactory('Validation failed (no Date provided)');
    }

    const transformedValue =
      isString(value) || isNumber(value) || value instanceof Date
        ? new Date(value)
        : new Date(NaN);

    if (
      isNaN(transformedValue.getTime()) ||
      (isString(value) && this.hasDayPastMonthEnd(value))
    ) {
      throw this.exceptionFactory('Validation failed (invalid date format)');
    }

    return transformedValue;
  }

  /**
   * `new Date()` rolls a day past the end of its month into the next month
   * ("2024-02-30" becomes March 1), so date strings are checked against
   * the length of their month.
   */
  protected hasDayPastMonthEnd(value: string): boolean {
    const parts = readDateParts(value);
    if (!parts) {
      return false;
    }
    const [year, month, day] = parts;
    const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const daysInMonth =
      month === 2 && isLeapYear ? 29 : DAYS_IN_MONTH[month - 1];
    return daysInMonth !== undefined && day > daysInMonth;
  }
}
