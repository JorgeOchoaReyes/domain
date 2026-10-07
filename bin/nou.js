#!/usr/bin/env node
// nou: your command line for the office (run `nou help`). It needs the server built: npm run build.
import { main } from "../dist/server/cli/nou.js";

main(process.argv.slice(2)).then((code) => process.exit(code));
