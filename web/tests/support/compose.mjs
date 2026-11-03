// Reads compose.yaml for the contract tests: block maps and sequences with scalars, as that file is
// written; anything else throws. The web has no YAML library and the tests do not add one.
function stripComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function scalar(raw) {
  const text = raw.trim();
  if (text === "") return null;
  if (/^".*"$/.test(text) || /^'.*'$/.test(text)) return text.slice(1, -1);
  if (/^\[.*\]$/.test(text)) return JSON.parse(text);
  return text;
}

const KEY = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/;

function parseBlock(lines, start, indent) {
  let at = start;
  const first = lines[at];
  if (first.text.startsWith("- ")) {
    const items = [];
    while (at < lines.length && lines[at].indent === indent && lines[at].text.startsWith("- ")) {
      items.push(scalar(lines[at].text.slice(2)));
      at += 1;
    }
    return { value: items, next: at };
  }
  const map = {};
  while (at < lines.length && lines[at].indent === indent) {
    const match = KEY.exec(lines[at].text);
    if (!match) throw new Error(`compose: cannot read line ${lines[at].number}: ${lines[at].text}`);
    const [, key, rest] = match;
    at += 1;
    if (rest !== undefined && rest !== "") {
      map[key] = scalar(rest);
    } else if (at < lines.length && (lines[at].indent > indent || (lines[at].indent === indent && lines[at].text.startsWith("- ")))) {
      const nested = parseBlock(lines, at, lines[at].indent);
      map[key] = nested.value;
      at = nested.next;
    } else {
      map[key] = null;
    }
  }
  if (at < lines.length && lines[at].indent > indent) throw new Error(`compose: bad indent at line ${lines[at].number}`);
  return { value: map, next: at };
}

export function parseCompose(text) {
  const lines = text.split("\n").map((line, index) => ({ line: stripComment(line), number: index + 1 }))
    .filter(({ line }) => line.trim() !== "")
    .map(({ line, number }) => ({ indent: line.length - line.trimStart().length, text: line.trim(), number }));
  return parseBlock(lines, 0, 0).value;
}
