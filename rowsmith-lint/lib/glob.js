// Minimal glob matching on forward-slash relative paths: ** (any number of directories), * and ? (within one path
// segment), {a,b} (alternatives). A pattern without a slash matches the file's base name, like .gitignore.

export const DEFAULT_INCLUDE = Object.freeze([
  "**/fixtures/**",
  "**/__fixtures__/**",
  "**/testdata/**",
  "**/seed*/**",
  "*.seed.*",
  "**/test*/**/*.{json,csv,sql,yaml,yml}",
]);

export function globToRegExp(glob) {
  let re = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        const atSegmentStart = i === 0 || glob[i - 1] === "/";
        if (atSegmentStart && slashAfter) {
          re += "(?:[^/]*/)*";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      re += "(?:";
      depth++;
    } else if (c === "}" && depth > 0) {
      re += ")";
      depth--;
    } else if (c === "," && depth > 0) re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  if (depth !== 0) throw new Error("unbalanced braces in glob");
  return new RegExp(`^${re}$`);
}

export function compileGlobs(globs) {
  return globs.map((g) => {
    const re = globToRegExp(g.replace(/^\.\//, ""));
    return g.includes("/") ? (p) => re.test(p) : (p) => re.test(p.slice(p.lastIndexOf("/") + 1));
  });
}
