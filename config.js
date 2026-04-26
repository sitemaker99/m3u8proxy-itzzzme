export const CONFIG = {
    PORT: process.env.PORT || 3000,

    // Comma-separated list of allowed origins, or * to allow all.
    // Default is * so it works out of the box. Restrict in production.
    // e.g. ALLOWED_ORIGINS=https://myapp.com,https://staging.myapp.com
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
        : ['*'],

    DEFAULT_REFERER: 'https://kwik.cx',
    ANIMEPAHE_BASE: process.env.ANIMEPAHE_BASE || 'https://animepahe.ru',
    DEFAULT_USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    FORWARD_HEADERS: ['range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since', 'authorization', 'cookie'],
    UPSTREAM_HEADERS: ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'],
    CORS: {
        ALLOW_METHODS: 'GET, POST, OPTIONS, HEAD',
        ALLOW_HEADERS: 'Content-Type, X-Requested-With, Range, Authorization, Cookie',
        EXPOSE_HEADERS: 'Content-Range, Content-Length, Accept-Ranges, Content-Type',
        ALLOW_CREDENTIALS: true
    },
    CACHE_CONTROL: 'no-store, no-cache, must-revalidate, proxy-revalidate',
    ERROR_PAGE_SIZE_THRESHOLD: 2000
};
