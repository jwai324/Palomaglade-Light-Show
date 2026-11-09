/**
 * config.js — deployment settings. The Supabase key is the public "publishable" key;
 * every write is authorized server-side by the shared edit code, never by this key.
 */

export const SUPABASE_URL = 'https://heaficaxneggnsayrrzs.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_9zZ7fwGEISNFXsAOMLRL9A_af-YlM04';

/** How often tracker state is refreshed while the page is visible (ms). */
export const POLL_MS = 20000;

/** Abort an API request that has not answered after this long (ms). */
export const REQUEST_TIMEOUT_MS = 12000;
