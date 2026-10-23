/**
 * Peer address parsing and normalization.
 *
 * Formats accepted:
 *   host:port        (port > 0 and <= 65535)
 *   ipLiteral:port
 *   [v6Literal]:port
 * Hosts may be DNS names or IP literals — provided at RUNTIME by operators
 * and discovery services, never hardcoded into the source tree (see
 * SECURITY.md).
 */
export function parsePeerAddress(input: string): string | null {
  if (!input || typeof input !== "string" || input.length > 255) return null;
  const raw = input.trim();
  // [host]:port
  const bracket = raw.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracket) {
    return validHost(bracket[1]) && validPort(bracket[2]) ? raw.toLowerCase() : null;
  }
  const parts = raw.split(":");
  if (parts.length !== 2) return null;
  const [host, port] = parts;
  if (!validHost(host) || !validPort(port)) return null;
  return `${host.toLowerCase()}:${port}`;
}

function validPort(port: string): boolean {
  const n = Number(port);
  return Number.isInteger(n) && n > 0 && n <= 65_535;
}

function validHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return validIPv4(host);
  if (host.includes(":")) return /^([0-9a-fA-F:]+)$/.test(host);
  // Hosts that start with a digit must be valid IPv4 literals — rejects
  // look-alike traps such as "10-1.2.3.4".
  if (/^\d/.test(host)) return false;
  // DNS name: permit letters, digits, hyphens, dots.
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(host);
}

function validIPv4(host: string): boolean {
  const octets = host.split(".");
  return octets.every((o) => {
    const n = Number(o);
    return n >= 0 && n <= 255 && String(n) === o.replace(/^0+(\d)/, "$1") || /^0$/.test(o);
  });
}

export function splitPeerAddress(address: string): { host: string; port: number } | null {
  const normalized = parsePeerAddress(address);
  if (!normalized) return null;
  const withoutBrackets = normalized.replace(/^\[([^\]]+)\]:/, "$1@@");
  const idx = withoutBrackets.lastIndexOf("@@");
  const hostPort = idx >= 0 ? [withoutBrackets.slice(0, idx), withoutBrackets.slice(idx + 2)] : normalized.split(":");
  return { host: hostPort[0], port: Number(hostPort[1]) };
}
