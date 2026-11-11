import { env } from "../config/env";

// Loads the configuration and reports success. Used by the tests; handy before a deployment too.
console.log(`ENV_OK ${env.NODE_ENV}`);
