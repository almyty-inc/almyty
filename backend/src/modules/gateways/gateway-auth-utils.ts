import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';

import { GatewayAuthType } from '../../entities/gateway-auth.entity';
import { compileSafeRegex, boundRegexInput } from '../../common/security/regex-safety';

/**
 * Pure utilities extracted from GatewayAuthValidators: hashing,
 * IP allow-list / CIDR membership, key-format checks, and the
 * save-time auth-type configuration validator. Kept as plain
 * functions so they can be tested in isolation.
 */

export function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export function validateKeyFormat(key: string, validationRules: any): boolean {
  if (!validationRules) return true;

  if (validationRules.minKeyLength && key.length < validationRules.minKeyLength) {
    return false;
  }
  if (validationRules.maxKeyLength && key.length > validationRules.maxKeyLength) {
    return false;
  }

  // keyFormat is a regex supplied by the gateway owner (admin) and tested
  // on every auth request. Route both compilation and the probe through
  // the shared regex-safety helper so a crafted pattern can't grind the
  // event loop and DoS the platform.
  if (validationRules.keyFormat) {
    const compiled = compileSafeRegex(validationRules.keyFormat);
    if (!compiled.regex) {
      return false;
    }
    if (!compiled.regex.test(boundRegexInput(key))) {
      return false;
    }
  }

  return true;
}

export function isIpInRanges(ip: string, ranges: string[]): boolean {
  return ranges.some((range) => {
    if (range === '*') return true;
    if (range.includes('/')) return isIpInCIDR(ip, range);
    return ip === range;
  });
}

/**
 * IPv4 CIDR membership check. Returns false for malformed input or
 * IPv6 addresses (callers that need IPv6 should use a dedicated lib).
 */
export function isIpInCIDR(ip: string, cidr: string): boolean {
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  if (normalized.includes(':')) {
    return false;
  }

  const [rangeIp, prefixLengthRaw] = cidr.split('/');
  if (prefixLengthRaw === undefined) {
    return normalized === rangeIp;
  }

  const prefix = Number.parseInt(prefixLengthRaw, 10);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const parseIp = (s: string): number | null => {
    const parts = s.split('.');
    if (parts.length !== 4) return null;
    let acc = 0;
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0 || n > 255) return null;
      acc = acc * 256 + n;
    }
    return acc >>> 0;
  };

  const ipBin = parseIp(normalized);
  const rangeBin = parseIp(rangeIp);
  if (ipBin === null || rangeBin === null) return false;

  // `/0` must match everything — explicitly handle prefix=0 because
  // JS left-shift is mod 32, so `(-1 << 32) >>> 0` would otherwise
  // give 0xFFFFFFFF (an exact-IP match).
  const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
  return ((ipBin & mask) >>> 0) === ((rangeBin & mask) >>> 0);
}

export function validateAuthConfiguration(
  type: GatewayAuthType,
  configuration: Record<string, any>,
): void {
  switch (type) {
    case GatewayAuthType.API_KEY:
      if (!configuration.keyHeader && !configuration.keyQuery) {
        throw new BadRequestException(
          'API key auth requires keyHeader or keyQuery configuration',
        );
      }
      break;

    case GatewayAuthType.JWT:
      // Require an explicit secret. The fallback to process.env.JWT_SECRET
      // silently accepted the backend's own login JWTs as gateway auth
      // tokens — a cross-org bypass.
      if (!configuration.secret) {
        throw new BadRequestException(
          'JWT auth requires a gateway-specific secret in configuration.secret',
        );
      }
      break;

    case GatewayAuthType.CUSTOM:
      if (!configuration.headerName && !configuration.queryName) {
        throw new BadRequestException(
          'Custom auth requires headerName or queryName configuration',
        );
      }
      break;
  }
}
