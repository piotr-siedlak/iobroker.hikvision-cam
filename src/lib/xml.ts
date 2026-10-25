/**
 * Minimal, safe XML reader for ISAPI alert payloads.
 *
 * - Rejects any DTD / ENTITY declaration (no entity expansion, no XXE).
 * - Strips namespace prefixes and ignores attributes.
 * - Enforces depth and node limits.
 */
export interface XmlNode {
    name: string;
    text: string;
    children: XmlNode[];
}

export class XmlError extends Error {}

const MAX_DEPTH = 32;
const MAX_NODES = 5000;

function decodeEntities(s: string): string {
    if (!s.includes('&')) {
        return s;
    }
    return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
        switch (e) {
            case 'lt':
                return '<';
            case 'gt':
                return '>';
            case 'amp':
                return '&';
            case 'quot':
                return '"';
            case 'apos':
                return "'";
            default: {
                const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
                if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
                    return '';
                }
                return String.fromCodePoint(code);
            }
        }
    });
}

function localName(name: string): string {
    return name.slice(name.lastIndexOf(':') + 1);
}

function trimTree(node: XmlNode): void {
    node.text = node.text.trim();
    for (const child of node.children) {
        trimTree(child);
    }
}

export function parseXml(input: string): XmlNode {
    const s = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    const n = s.length;
    const stack: XmlNode[] = [];
    let root: XmlNode | undefined;
    let nodes = 0;
    let i = 0;

    while (i < n) {
        const lt = s.indexOf('<', i);
        if (lt < 0) {
            break;
        }
        if (lt > i && stack.length) {
            stack[stack.length - 1].text += decodeEntities(s.slice(i, lt));
        }
        i = lt;

        if (s.startsWith('<?', i)) {
            const e = s.indexOf('?>', i + 2);
            if (e < 0) {
                throw new XmlError('Unterminated processing instruction');
            }
            i = e + 2;
            continue;
        }
        if (s.startsWith('<!--', i)) {
            const e = s.indexOf('-->', i + 4);
            if (e < 0) {
                throw new XmlError('Unterminated comment');
            }
            i = e + 3;
            continue;
        }
        if (s.startsWith('<![CDATA[', i)) {
            const e = s.indexOf(']]>', i + 9);
            if (e < 0) {
                throw new XmlError('Unterminated CDATA section');
            }
            if (stack.length) {
                stack[stack.length - 1].text += s.slice(i + 9, e);
            }
            i = e + 3;
            continue;
        }
        if (s.startsWith('<!', i)) {
            throw new XmlError('DTD and ENTITY declarations are not allowed');
        }
        if (s[i + 1] === '/') {
            const e = s.indexOf('>', i + 2);
            if (e < 0) {
                throw new XmlError('Unterminated closing tag');
            }
            const name = localName(s.slice(i + 2, e).trim());
            const top = stack.pop();
            if (!top || top.name !== name) {
                throw new XmlError(`Unexpected closing tag </${name}>`);
            }
            i = e + 1;
            if (!stack.length) {
                root = top;
                break;
            }
            continue;
        }

        let j = i + 1;
        let quote = '';
        while (j < n) {
            const c = s[j];
            if (quote) {
                if (c === quote) {
                    quote = '';
                }
            } else if (c === '"' || c === "'") {
                quote = c;
            } else if (c === '>') {
                break;
            }
            j++;
        }
        if (j >= n) {
            throw new XmlError('Unterminated tag');
        }
        let inner = s.slice(i + 1, j);
        const selfClosing = inner.endsWith('/');
        if (selfClosing) {
            inner = inner.slice(0, -1);
        }
        const m = /^[^\s/]+/.exec(inner);
        if (!m) {
            throw new XmlError('Empty tag name');
        }
        if (++nodes > MAX_NODES) {
            throw new XmlError('Too many XML nodes');
        }
        if (stack.length >= MAX_DEPTH) {
            throw new XmlError('XML nesting too deep');
        }
        const node: XmlNode = { name: localName(m[0]), text: '', children: [] };
        if (stack.length) {
            stack[stack.length - 1].children.push(node);
        }
        if (selfClosing) {
            if (!stack.length) {
                root = node;
                break;
            }
        } else {
            stack.push(node);
        }
        i = j + 1;
    }

    if (!root) {
        throw new XmlError(stack.length ? 'Unclosed element' : 'No root element');
    }
    trimTree(root);
    return root;
}

/**
 * Collect leaf values into `out` keyed by lower-cased local name.
 * The first occurrence of a key wins.
 */
export function flattenXml(node: XmlNode, out: Map<string, string>): void {
    if (node.children.length === 0) {
        const key = node.name.toLowerCase();
        if (node.text && !out.has(key)) {
            out.set(key, node.text);
        }
        return;
    }
    for (const child of node.children) {
        flattenXml(child, out);
    }
}

export function flattenJson(value: unknown, out: Map<string, string>, depth = 0): void {
    if (depth > MAX_DEPTH || value === null || value === undefined) {
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value.slice(0, 100)) {
            flattenJson(item, out, depth + 1);
        }
        return;
    }
    if (typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (v !== null && typeof v === 'object') {
                flattenJson(v, out, depth + 1);
            } else if (v !== null && v !== undefined) {
                const key = k.toLowerCase();
                const str = String(v);
                if (str !== '' && !out.has(key)) {
                    out.set(key, str);
                }
            }
        }
    }
}
