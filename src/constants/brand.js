/** Nombre de producto centralizado (emails, AI, logs). */
const APP_NAME = process.env.APP_NAME || 'Meryt';
const APP_BRAND_BADGE = process.env.APP_BRAND_BADGE || 'Meryt';
const COMPANY_NAME = process.env.COMPANY_NAME || 'JNSIX';

/**
 * Esquema de deep links de la app.
 * El build nativo registra `meryt://` y también `jnsix://` para links viejos,
 * así que se puede cambiar sin romper instalaciones anteriores.
 */
const APP_SCHEME = process.env.APP_SCHEME || 'meryt';

/** Esquema anterior al rebranding, aún registrado por la app para links viejos. */
const LEGACY_APP_SCHEME = 'jnsix';

module.exports = { APP_NAME, APP_BRAND_BADGE, COMPANY_NAME, APP_SCHEME, LEGACY_APP_SCHEME };
