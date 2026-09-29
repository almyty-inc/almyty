/**
 * Protocol surfaces a caller reaches with an almyty identity (an access
 * key, an OAuth token). Only these can be private: a chat channel is reached
 * by people who never sign in to almyty, so the server refuses a private
 * one. Mirrors PRIVATE_CAPABLE_GATEWAY_TYPES on the backend.
 */
export const PRIVATE_CAPABLE_GATEWAY_TYPES = new Set(['tools', 'mcp', 'utcp', 'skills', 'a2a', 'acp', 'openai_chat'])
