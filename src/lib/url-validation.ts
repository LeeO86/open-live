/**
 * URL validation helpers for security-sensitive inputs.
 *
 * Rules:
 * - httpUrlOnly: allow only http/https schemes
 * - graphicUrl:  httpUrlOnly OR safe data: image URIs (no svg, no text/html)
 * - srtUrl:      srt:// scheme only
 * - mxlFlowId:   UUID, optionally prefixed with mxl://
 * - mxlDomain:   absolute filesystem path
 * - decklinkDevice: non-negative integer device index
 */

/**
 * Throws if the URL is not a safe http/https URL.
 */
export function httpUrlOnly(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Disallowed URL scheme "${parsed.protocol}" — only http/https allowed`);
  }
  if (!parsed.hostname) {
    throw new Error('URL must have a hostname');
  }
}

const ALLOWED_DATA_MIME = /^data:(text\/html|image\/(png|jpeg|gif|webp))[;,]/i;
const BLOCKED_SCHEMES = /^(file|javascript|ftp|gopher|chrome|about|data:application):/i;

/**
 * Throws if the value is not a safe graphic URL.
 * Accepts: http/https URLs, data:text/html (inline HTML overlays rendered by Strom's headless browser),
 *          or data:image/(png|jpeg|gif|webp) base64 URIs.
 * Rejects: file://, javascript:, data:application/*, etc.
 */
export function graphicUrl(url: string): void {
  if (BLOCKED_SCHEMES.test(url)) {
    throw new Error(`Disallowed URL scheme in graphic URL`);
  }
  if (url.startsWith('data:')) {
    if (!ALLOWED_DATA_MIME.test(url)) {
      throw new Error('Only data:text/html or data:image/(png|jpeg|gif|webp) URIs are allowed for graphics');
    }
    return;
  }
  // Otherwise must be a safe http/https URL
  httpUrlOnly(url);
}

// srt://<host>:<port>[?params] or srt://:<port>[?params] (empty host = bind all interfaces)
const SRT_URL_RE = /^srt:\/\/[^!; ]*$/i;

/**
 * Throws if the value is not a valid SRT URL.
 */
export function srtUrl(url: string): void {
  if (!url.startsWith('srt://')) {
    throw new Error('Only srt:// URLs are allowed');
  }
  if (!SRT_URL_RE.test(url)) {
    throw new Error('SRT URL contains disallowed characters');
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accepts a bare UUID or `mxl://<uuid>` and returns the UUID string.
 */
export function parseMxlFlowId(value: string): string {
  let id = value.trim();
  if (/^mxl:\/\//i.test(id)) {
    id = id.replace(/^mxl:\/\//i, '').replace(/\/+$/, '');
  }
  return id;
}

/**
 * Throws if the value is not a UUID (optionally prefixed with mxl://).
 */
export function mxlFlowId(value: string): void {
  const id = parseMxlFlowId(value);
  if (!UUID_RE.test(id)) {
    throw new Error('MXL flow ID must be a UUID (optionally prefixed with mxl://)');
  }
}

/**
 * Throws if the value is not an absolute filesystem path.
 */
export function mxlDomain(value: string): void {
  const path = value.trim();
  if (!path.startsWith('/') || path.includes('\0')) {
    throw new Error('MXL domain must be an absolute filesystem path');
  }
}

/**
 * Throws if the value is not a non-negative integer (DeckLink device index).
 */
export function decklinkDevice(value: string): void {
  if (!/^\d+$/.test(value.trim())) {
    throw new Error('DeckLink device must be a non-negative integer');
  }
}
