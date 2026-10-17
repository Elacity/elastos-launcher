/**
 * The one place the launcher names the Home address. Everything else imports
 * these values. Browsers refuse a passkey on an IP-literal origin, so Home is
 * `localhost`, not `127.0.0.1` (runtime docs/LAUNCHER_CONTRACT.md, "Readiness
 * and Home URL").
 */
export const GATEWAY_HOST = 'localhost';
export const GATEWAY_PORT = 8090;
export const GATEWAY_ADDR = `${GATEWAY_HOST}:${GATEWAY_PORT}`;
export const GATEWAY_ORIGIN = `http://${GATEWAY_ADDR}`;
export const HEALTH_PATH = '/healthz';
export const HEALTH_URL = `${GATEWAY_ORIGIN}${HEALTH_PATH}`;
export const HOME_URL = `${GATEWAY_ORIGIN}/home/`;

/**
 * The address a launcher before this one passed to `--addr`. A gateway that
 * recorded it is stopped and started again on `localhost`. Home is never
 * opened on it.
 */
export const LEGACY_GATEWAY_ADDR = `127.0.0.1:${GATEWAY_PORT}`;

/**
 * The addresses `localhost` may resolve to. A resolver that returns anything
 * else is refused: Home would not be on this computer.
 */
export const LOOPBACK_ADDRESSES: readonly string[] = ['127.0.0.1', '::1'];
