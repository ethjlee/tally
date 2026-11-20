import { timingSafeEqual } from "node:crypto";

export const MIN_PASSWORD_LENGTH = 14;
export const MAX_PASSWORD_LENGTH = 128;
export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 30;
export const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;

export function setupTokensMatch(candidate: string, expected: string): boolean {
  const received = Buffer.from(candidate, "utf8");
  const configured = Buffer.from(expected, "utf8");
  return received.length === configured.length && timingSafeEqual(received, configured);
}
