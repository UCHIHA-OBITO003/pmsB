import { logger } from './logger';

let intervalHandle: NodeJS.Timeout | undefined;
let starterTimeout: NodeJS.Timeout | undefined;

/**
 * Periodic GET to this service's **public** URL so hosts that spin down on idle HTTP
 * HTTP (e.g. Render free) see traffic before the cutoff. Must use an external-facing
 * origin (Render sets `RENDER_EXTERNAL_URL`; override with `KEEPALIVE_PUBLIC_URL`).
 */
export function startHttpKeepalive(): void {
  stopHttpKeepalive();

  const enabled = process.env.HTTP_KEEPALIVE_ENABLED === 'true';
  if (!enabled) return;

  const base =
    (process.env.KEEPALIVE_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '');
  if (!base) {
    logger.warn(
      'HTTP_KEEPALIVE_ENABLED=true but KEEPALIVE_PUBLIC_URL and RENDER_EXTERNAL_URL are empty; skipping keepalive',
    );
    return;
  }

  const pathRaw = (process.env.KEEPALIVE_PATH || '/health').trim();
  const path = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`;
  const target = `${base}${path}`;

  const intervalMs = Math.max(
    60_000,
    parseInt(process.env.KEEPALIVE_INTERVAL_MS || String(10 * 60_000), 10),
  );
  const timeoutMs = Math.min(120_000, Math.max(5_000, parseInt(process.env.KEEPALIVE_TIMEOUT_MS || '25000', 10)));

  const ping = (): void => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    fetch(target, { method: 'GET', signal: ctrl.signal })
      .then((res) => {
        clearTimeout(t);
        if (!res.ok) logger.warn({ target, status: res.status }, 'HTTP keepalive: non-OK response');
      })
      .catch((err: unknown) => {
        clearTimeout(t);
        logger.warn({ err, target }, 'HTTP keepalive: request failed');
      });
  };

  const bootDelayMs = Math.max(0, parseInt(process.env.KEEPALIVE_BOOT_DELAY_MS || '15000', 10));
  starterTimeout = setTimeout(() => {
    starterTimeout = undefined;
    ping();
  }, bootDelayMs);
  intervalHandle = setInterval(ping, intervalMs);

  logger.info(
    { target, intervalMs, bootDelayMs },
    'HTTP keepalive enabled (hits public URL — set KEEPALIVE_PUBLIC_URL when not using Render)',
  );
}

export function stopHttpKeepalive(): void {
  if (starterTimeout) {
    clearTimeout(starterTimeout);
    starterTimeout = undefined;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
  }
}
