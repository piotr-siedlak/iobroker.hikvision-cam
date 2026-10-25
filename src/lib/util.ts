/** Make a string safe for use as a single ioBroker object id segment. */
export function sanitizeId(value: string, maxLength = 48): string {
    const cleaned = value
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, maxLength);
    return cleaned || 'unknown';
}

/** Remove secrets from text that is about to be logged or stored. */
export function redact(text: string, secrets: Array<string | undefined>): string {
    let out = text;
    for (const secret of secrets) {
        if (secret && secret.length >= 3) {
            out = out.split(secret).join('***');
        }
    }
    return out.replace(/(authorization|password|passwd|token)(\s*[:=]\s*)[^\s,;"<]+/gi, '$1$2***');
}

/**
 * Validate a camera host name or IP address. Only plain host names and IP
 * addresses are accepted (no URLs, paths, credentials or whitespace).
 * Returns an error message, or undefined when valid.
 */
export function validateHost(host: string): string | undefined {
    if (!host || host.length > 253) {
        return 'Host is empty or too long';
    }
    const isIpv6 = host.includes(':');
    if (isIpv6) {
        if (!/^[0-9a-fA-F:.]+$/.test(host)) {
            return 'Invalid IPv6 address';
        }
    } else if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) {
        return 'Host contains invalid characters (use a plain host name or IP address, no URL)';
    }
    if (/^0\.0\.0\.0$/.test(host) || /^169\.254\./.test(host)) {
        return 'Address is not a valid camera address';
    }
    return undefined;
}

export function describeError(err: unknown): string {
    if (err instanceof Error) {
        const code = (err as NodeJS.ErrnoException).code;
        return code ? `${code}: ${err.message}` : err.message;
    }
    return String(err);
}
