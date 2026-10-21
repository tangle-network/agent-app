/**
 * Media generation: the Router's media client, the request checks every
 * generation type runs, speech scripts, and the record a generation leaves on
 * its row. Products bind the client once with their router base URL and keys;
 * pricing, default models and persistence stay with the product. The row's
 * drizzle table is `./media/drizzle`.
 */
export * from './router-client'
export * from './router-generation'
export * from './generate-request'
export * from './speech-script'
export * from './generation-record'
export * from './model-catalog'
