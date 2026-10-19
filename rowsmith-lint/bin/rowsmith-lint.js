#!/usr/bin/env node
// rowsmith-lint: flags values in test fixtures that look like real personal or payment data. Local only.
import { main } from "../lib/cli.js";

process.exitCode = main(process.argv.slice(2));
