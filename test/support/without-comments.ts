/**
 * Returns `source` with every comment blanked to spaces. Newlines are kept, so line numbers in the
 * output match the input, and string and template contents are kept, so import specifiers still
 * read. Unlike a DOM-free guard that blanks only comments, strings are kept as they are here: a guard
 * that reads code must not read TSDoc examples.
 */
export function withoutComments(source: string): string {
  let out = "";
  let index = 0;
  // Brace depth of code, and the depths at which a template literal's `${` expression opened.
  let depth = 0;
  const templateOpens: number[] = [];
  const blank = (text: string): string => text.replace(/[^\n]/g, " ");

  function copyString(quote: string): void {
    const start = index;
    index += 1;
    while (index < source.length && source[index] !== quote) {
      if (source[index] === "\\") index += 1;
      index += 1;
    }
    index += 1;
    out += source.slice(start, Math.min(index, source.length));
  }

  function copyTemplateText(): void {
    // Copies template characters up to a closing backtick, or up to `${` (an expression starts).
    const start = index;
    while (index < source.length) {
      const c = source[index];
      if (c === "\\") {
        index += 2;
        continue;
      }
      if (c === "`") {
        index += 1;
        out += source.slice(start, index);
        return;
      }
      if (c === "$" && source[index + 1] === "{") {
        index += 2;
        out += source.slice(start, index);
        templateOpens.push(depth);
        depth += 1;
        return;
      }
      index += 1;
    }
    out += source.slice(start);
  }

  while (index < source.length) {
    const c = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(index, stop));
      index = stop;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(index, stop));
      index = stop;
    } else if (c === '"' || c === "'") {
      copyString(c);
    } else if (c === "`") {
      out += "`";
      index += 1;
      copyTemplateText();
    } else if (c === "{") {
      depth += 1;
      out += c;
      index += 1;
    } else if (c === "}") {
      index += 1;
      if (templateOpens.length > 0 && templateOpens[templateOpens.length - 1] === depth - 1) {
        // The closing brace of `${ ... }`: the template text continues.
        templateOpens.pop();
        depth -= 1;
        out += "}";
        copyTemplateText();
      } else {
        depth -= 1;
        out += c;
      }
    } else {
      out += c;
      index += 1;
    }
  }
  return out;
}
