import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { CONFIG } from './config.js';

const require = createRequire(import.meta.url);
const cloudscraper = require('cloudscraper');

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cookieJar = new Map();

// ─── Helpers ────────────────────────────────────────────────────────────────

function createSafeSender(res) {
    let sent = false;
    return (statusCode, data) => {
        if (!sent) {
            sent = true;
            res.status(statusCode).send(data);
        }
    };
}

function isOriginAllowed(origin) {
    if (!CONFIG.ALLOWED_ORIGINS.length || CONFIG.ALLOWED_ORIGINS.includes('*')) return true;
    return CONFIG.ALLOWED_ORIGINS.includes(origin);
}

/**
 * AnimePahe disguises .ts video segments as .jpg files to bypass CDN blocks.
 * Detect them so we can correct the Content-Type before sending to HLS.js.
 */
function resolveContentType(url, upstreamContentType) {
    const pathname = url.pathname.toLowerCase();

    // Segment files disguised as images — treat as MPEG-TS
    if (
        (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg') || pathname.endsWith('.png')) &&
        (upstreamContentType.includes('image/') || upstreamContentType.includes('application/octet-stream'))
    ) {
        return 'video/mp2t';
    }

    // Explicit TS segments
    if (pathname.endsWith('.ts')) return 'video/mp2t';

    // Key files
    if (pathname.endsWith('.key')) return 'application/octet-stream';

    return upstreamContentType;
}

function buildUpstreamHeaders(req, url, headersParam) {
    const headers = {
        'User-Agent': CONFIG.DEFAULT_USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Upgrade-Insecure-Requests': '1'
    };

    CONFIG.FORWARD_HEADERS.forEach(h => {
        if (req.headers[h]) headers[h] = req.headers[h];
    });

    let referer = CONFIG.DEFAULT_REFERER;

    if (headersParam) {
        try {
            const additionalHeaders = JSON.parse(headersParam);
            Object.entries(additionalHeaders).forEach(([key, value]) => {
                const lk = key.toLowerCase();
                headers[lk] = value;
                if (lk === 'referer' || lk === 'referrer') referer = value;
            });
        } catch (e) { /* malformed headers param — skip */ }
    }

    if (referer) {
        let refStr = decodeURIComponent(referer);

        if (url.hostname.includes('kwik')) {
            refStr = CONFIG.ANIMEPAHE_BASE;
            if (!refStr.endsWith('/')) refStr += '/';
        } else if (url.hostname.includes('owocdn') || url.hostname.includes('uwucdn') || url.hostname.includes('cdn')) {
            if (!refStr.includes('kwik.cx')) refStr = CONFIG.DEFAULT_REFERER;
        }

        if (refStr.includes('kwik.cx') && !refStr.endsWith('/')) refStr += '/';

        headers['referer'] = refStr;
        try {
            headers['origin'] = new URL(refStr).origin;
        } catch (e) {
            headers['origin'] = refStr;
        }
    }

    if (url.hostname.includes('owocdn') || url.hostname.includes('uwucdn')) {
        headers['Sec-Fetch-Dest'] = 'iframe';
        headers['Sec-Fetch-Mode'] = 'navigate';
        headers['Sec-Fetch-Site'] = 'cross-site';
    } else {
        headers['Sec-Fetch-Dest'] = 'empty';
        headers['Sec-Fetch-Mode'] = 'cors';
        headers['Sec-Fetch-Site'] = 'cross-site';
    }

    const storedCookies = cookieJar.get(url.hostname);
    if (storedCookies) {
        headers['cookie'] = headers['cookie']
            ? `${headers['cookie']}; ${storedCookies}`
            : storedCookies;
    }

    return headers;
}

function updateCookieJar(url, targetResponse) {
    const setCookie = targetResponse.headers['set-cookie'];
    if (!setCookie) return;

    const current = cookieJar.get(url.hostname) || '';
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const merged = [...new Set([
        ...current.split('; '),
        ...cookies.map(c => c.split(';')[0])
    ])].filter(Boolean).join('; ');

    cookieJar.set(url.hostname, merged);
}

function setCorsHeaders(req, res) {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', CONFIG.CORS.ALLOW_METHODS);
    res.setHeader('Access-Control-Allow-Headers', CONFIG.CORS.ALLOW_HEADERS);
    res.setHeader('Access-Control-Expose-Headers', CONFIG.CORS.EXPOSE_HEADERS);
    res.setHeader('Access-Control-Allow-Credentials', CONFIG.CORS.ALLOW_CREDENTIALS);
    res.setHeader('Cache-Control', CONFIG.CACHE_CONTROL);
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Proxy-By', 'm3u8-proxy');
    res.setHeader('X-Content-Type-Options', 'nosniff');
}

function generateProxyUrl(targetUrl, headersParam) {
    let proxyUrl = `/m3u8-proxy?url=${encodeURIComponent(targetUrl)}`;
    if (headersParam) proxyUrl += `&headers=${encodeURIComponent(headersParam)}`;
    return proxyUrl;
}

function proxyPlaylistContent(content, url, headersParam) {
    return content.split('\n').map(line => {
        const trimmed = line.trim();

        if (trimmed === '' || trimmed.startsWith('#EXTM3U') || trimmed.startsWith('#EXT-X-VERSION')) {
            return line;
        }

        if (trimmed.startsWith('#')) {
            let out = line;

            // Strip CODECS and AUDIO attributes from #EXT-X-STREAM-INF lines.
            // HLS.js uses these to pre-select a SourceBuffer codec — if the codec
            // string doesn't exactly match what the browser registered, it throws
            // bufferAddCodecError. Removing them lets HLS.js sniff the codec from
            // the actual segment bytes instead, which is always reliable.
            out = out.replace(/,?\s*CODECS="[^"]*"/gi, '');
            out = out.replace(/,?\s*AUDIO="[^"]*"/gi, '');

            // Rewrite any URI="..." attributes inside HLS tags (e.g. EXT-X-KEY, EXT-X-MAP)
            out = out.replace(/(URI\s*=\s*")([^"]+)(")/gi, (match, prefix, uri, suffix) => {
                try {
                    const abs = new URL(uri, url.href).href;
                    return `${prefix}${generateProxyUrl(abs, headersParam)}${suffix}`;
                } catch (e) {
                    return match;
                }
            });

            return out;
        }

        // Non-comment lines are segment/sub-playlist URLs
        try {
            const abs = new URL(trimmed, url.href).href;
            return generateProxyUrl(abs, headersParam);
        } catch (e) {
            return line;
        }
    }).join('\n');
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.options('*', (req, res) => {
    setCorsHeaders(req, res);
    res.sendStatus(204);
});

app.get('/', (req, res) => {
    const origin = req.headers.origin || '';
    if (!isOriginAllowed(origin)) {
        return res.status(403).send(`The origin "${origin}" was blacklisted by the operator of this proxy.`);
    }
    res.sendFile(path.join(__dirname, 'html', 'playground.html'));
});

app.get('/m3u8-proxy', async (req, res) => {
    const safeSend = createSafeSender(res);
    const origin = req.headers.origin || '';

    if (!isOriginAllowed(origin)) {
        return safeSend(403, `The origin "${origin}" was blacklisted by the operator of this proxy.`);
    }

    const urlStr = req.query.url;
    if (!urlStr) {
        return safeSend(400, { message: 'URL is required' });
    }

    let url;
    try {
        url = new URL(urlStr);
    } catch (e) {
        return safeSend(400, { message: 'Invalid URL provided' });
    }

    const headersParam = req.query.headers ? decodeURIComponent(req.query.headers) : '';
    const headers = buildUpstreamHeaders(req, url, headersParam);

    // Only disable TLS verification for MP4 (some CDNs have self-signed certs)
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = url.pathname.endsWith('.mp4') ? '0' : '1';

    try {
        const targetResponse = await cloudscraper({
            method: 'GET',
            url: url.href,
            headers,
            encoding: null,
            resolveWithFullResponse: true,
            timeout: 20000
        });

        updateCookieJar(url, targetResponse);
        setCorsHeaders(req, res);

        const upstreamContentType = targetResponse.headers['content-type'] || '';
        const pathname = url.pathname.toLowerCase();

        const isPlaylist =
            pathname.endsWith('.m3u8') ||
            upstreamContentType.includes('mpegURL') ||
            upstreamContentType.includes('application/x-mpegurl');

        if (isPlaylist) {
            // ── M3U8 Playlist ──────────────────────────────────────────────
            const content = targetResponse.body.toString('utf8');
            const proxied = proxyPlaylistContent(content, url, headersParam);

            console.log(`[M3U8-STRIP] url=${url.href.substring(0, 60)} isPlaylist=true ct=${upstreamContentType}`);

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.status(200).send(proxied);
        }

        // ── Segment / Key / Other ──────────────────────────────────────────
        if (targetResponse.statusCode >= 400) {
            const bodyStr = targetResponse.body.toString('utf8');
            return safeSend(targetResponse.statusCode, {
                message: 'Upstream returned error',
                upstreamStatus: targetResponse.statusCode,
                body: bodyStr.substring(0, 1000)
            });
        }

        // Fix disguised segment content types BEFORE forwarding headers
        const correctedContentType = resolveContentType(url, upstreamContentType);
        const wasDisguised = correctedContentType !== upstreamContentType;

        if (wasDisguised) {
            console.log(`[M3U8-STRIP] url=${url.href.substring(0, 60)} isPlaylist=false ct=${upstreamContentType} → corrected to ${correctedContentType}`);
        } else {
            console.log(`[M3U8-STRIP] url=${url.href.substring(0, 60)} isPlaylist=false ct=${upstreamContentType}`);
        }

        Object.entries(targetResponse.headers).forEach(([k, v]) => {
            const lk = k.toLowerCase();
            if (CONFIG.UPSTREAM_HEADERS.includes(lk)) {
                // Use our corrected content type, not the upstream one
                res.setHeader(k, lk === 'content-type' ? correctedContentType : v);
            }
        });

        res.writeHead(targetResponse.statusCode);
        res.end(targetResponse.body);

    } catch (err) {
        console.error('Cloudscraper error:', err.message);
        if (err.response) {
            return safeSend(err.response.statusCode || 502, {
                message: 'Upstream error (Cloudscraper)',
                error: err.message
            });
        }
        return safeSend(500, { message: err.message });
    }
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(CONFIG.PORT, () => {
    console.log(`Server listening on PORT: ${CONFIG.PORT}`);
});
