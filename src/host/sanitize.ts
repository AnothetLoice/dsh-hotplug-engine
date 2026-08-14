/**
 * Terminal / log output sanitization (M5 M2, plan A3).
 *
 * Child-process output (pnpm stdout/stderr) is untrusted text: package
 * scripts can emit ANSI escape sequences, terminal control characters, or
 * forged log lines. Before embedding such output into an EngineError
 * message (which tools render and the panel displays), strip C0/C1 control
 * characters and ESC sequences and cap the length.
 *
 * @module dsh-hotplug-engine/host/sanitize
 */

/** C0 (0x00-0x1F) + C1 (0x7F-0x9F) control range (ESC is 0x1B). */
const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g

/**
 * Strip control characters and ESC sequences, keeping visible characters.
 * Non-ASCII printable text (CJK, emoji) is preserved.
 * @param value raw string (child-process output)
 * @param maxLen optional length cap (default 2000, matching the old slice)
 */
export function sanitizeTerminal(value: string, maxLen = 2000): string {
  const cleaned = value.replace(CONTROL_RE, '')
  return cleaned.length <= maxLen ? cleaned : cleaned.slice(0, maxLen)
}
