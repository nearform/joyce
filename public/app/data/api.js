/**
 * Data layer type definitions for API operations.
 *
 * The data layer exports three functions: search, chat, and posts.
 * These are documented in index.js.
 *
 * @typedef {Object} SearchParams
 * @property {string} query
 * @property {string[]} postType
 * @property {string} minDate
 * @property {string[]} categoryPrimary
 * @property {boolean} withContent
 * @property {string} datastore
 *
 * @typedef {Object} ChatParams
 * @property {string} api - Either "chat" or "responses"
 * @property {string} query
 * @property {string[]} postType
 * @property {string} minDate
 * @property {string[]} categoryPrimary
 * @property {boolean} withContent
 * @property {string} model
 * @property {string} provider
 * @property {number} temperature
 * @property {string} datastore
 *
 * @typedef {Object} PostsParams
 * @property {string[]} postType
 * @property {string} minDate
 * @property {string[]} categoryPrimary
 * @property {boolean} withContent
 */
