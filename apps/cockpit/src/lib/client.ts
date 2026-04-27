import { WanmanCockpitClient } from '@wanman/cockpit-client';

// The Vite dev server injects the same local control API as the packaged host,
// so both URLs stay empty in dev. Production builds can point controlUrl at the
// loopback cockpit host, for example http://127.0.0.1:5174.
const baseUrl = (import.meta.env['VITE_WANMAN_URL'] as string | undefined) ?? '';
const controlUrl = (import.meta.env['VITE_WANMAN_CONTROL_URL'] as string | undefined) ?? '';

export const client = new WanmanCockpitClient({ baseUrl, controlUrl });
