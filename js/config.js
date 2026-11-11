/**
 * config.js — deployment settings for the Neon project "palomaglade-light-show".
 * Both URLs are public. The browser holds only a short-lived anonymous token; every write
 * is authorized server-side by the shared edit code, never by anything shipped here.
 */

/** Neon Data API (PostgREST-compatible) for the `neondb` database. */
export const DATA_API_URL = 'https://ep-aged-rice-bbcebvsj.apirest.c-15.us-east-1.aws.neon.tech/neondb/rest/v1';

/** Neon Auth base URL. Only its anonymous-token endpoint is used. */
export const AUTH_URL = 'https://ep-aged-rice-bbcebvsj.neonauth.c-15.us-east-1.aws.neon.tech/neondb/auth';

/** How often tracker state is refreshed while the page is visible (ms). */
export const POLL_MS = 20000;

/** Abort an API request that has not answered after this long (ms). */
export const REQUEST_TIMEOUT_MS = 12000;
