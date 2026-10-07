#!/usr/bin/env node
import { main } from "./nou.js";

// `npm run nou -- …` in development; the installed `nou` runs the compiled copy (bin/nou.js).
main(process.argv.slice(2)).then((code) => process.exit(code));
