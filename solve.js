// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's
// answer {columns, rows, errors} for {text, header}, but reads the text with
// bulk scans instead of one character at a time.
//
// Behaviour (from the published spec): the text is read once, left to right.
// A U+FEFF at the very start is dropped. A record ends at LF or CRLF, and a
// line left with no characters is no record. Outside quotes a CR not followed
// by LF is dropped (error stray_cr). A field that opens with a quote runs to
// the next quote that is not doubled ("" inside it is one quote, and each
// CRLF or lone CR inside it is read as LF); what follows its closing quote,
// up to the next comma or line break, is appended as it stands (quote_junk,
// when the field ends); a quote that never closes is a literal character,
// and the text after it is read again as unquoted (unterminated_quote). A
// quote inside an unquoted field is a literal character. Fields stay strings,
// never trimmed or converted. columns is the first record when header is
// true, else null; rows holds the records after it (every record when header
// is false), each padded with empty strings (short_row, with fields: its
// field count) or cut (long_row, with extra: the cut fields) to the first
// record's width. Each error is {code, line, row}, in the order met; line is
// the 1-based line its record starts on, and row is its record's index in
// rows, null for the header.
//
// Speed: most records hold no quote and no stray CR, so a whole record is
// taken in one slice and split on commas. Records that do hold a quote or a
// stray CR go through a field scanner that jumps from delimiter to delimiter
// with indexOf and copies whole field spans, instead of stepping character
// by character. Nothing is kept from one call to the next.

const COMMA = 44; // ','
const QUOTE = 34; // '"'
const LF = 10; // '\n'
const CR = 13; // '\r'
const BOM = 0xfeff;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === BOM) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). The field scanners below report errors against
  // these, so they are read at the time an error is met.
  let recordLine = 1;
  let recordRow = null;

  // The field the scanners below just read: its value, how it ended (0 at
  // a comma, 1 at a line break, 2 at the end of the text) and how many
  // characters were kept onto it. Kept in slots, not returned, so reading a
  // field allocates nothing but the value itself.
  let fValue = '';
  let fEnded = 0;
  let fAdded = 0;

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). fAdded counts the
  // characters kept, so a caller can tell whether a quoted field gained
  // junk after its closing quote.
  //
  // Each step copies one span: the text up to the next comma, cut short at
  // the first line break or stray CR inside it, so the scan never runs past
  // the field it is reading.
  function scanUnquoted(value) {
    let added = 0;
    for (;;) {
      if (pos >= len) {
        fValue = value;
        fEnded = 2;
        fAdded = added;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === COMMA) {
        pos += 1;
        fValue = value;
        fEnded = 0;
        fAdded = added;
        return;
      }
      if (c === LF) {
        pos += 1;
        line += 1;
        fValue = value;
        fEnded = 1;
        fAdded = added;
        return;
      }
      if (c === CR) {
        if (text.charCodeAt(pos + 1) === LF) {
          pos += 2;
          line += 1;
          fValue = value;
          fEnded = 1;
          fAdded = added;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
        continue;
      }
      const comma = text.indexOf(',', pos);
      const span = text.slice(pos, comma === -1 ? len : comma);
      const ni = span.indexOf('\n');
      const ri = span.indexOf('\r');
      if (ni === -1 && ri === -1) {
        // No line break and no CR before the comma: the whole span is kept.
        value += span;
        added += span.length;
        pos += span.length;
        continue;
      }
      if (ri !== -1 && (ni === -1 || ri < ni)) {
        if (ri + 1 === ni) {
          // CRLF: the field ends at the line break, the CR not kept.
          value += span.slice(0, ri);
          added += ri;
          pos += ri + 2;
          line += 1;
          fValue = value;
          fEnded = 1;
          fAdded = added;
          return;
        }
        // A stray CR: dropped, with its error, and the field goes on.
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        value += span.slice(0, ri);
        added += ri;
        pos += ri + 1;
        continue;
      }
      // A line break before any comma or CR: the field ends there.
      value += span.slice(0, ni);
      added += ni;
      pos += ni + 1;
      line += 1;
      fValue = value;
      fEnded = 1;
      fAdded = added;
      return;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    // Find the closing quote, stepping over "" pairs (each one a literal
    // quote inside the field).
    let q = text.indexOf('"', pos + 1);
    let doubled = false;
    while (q !== -1 && text.charCodeAt(q + 1) === QUOTE) {
      doubled = true;
      q = text.indexOf('"', q + 2);
    }
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted, from the line it opened on.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      scanUnquoted('"');
      return;
    }
    let value;
    const inner = text.slice(pos + 1, q);
    if (!doubled && inner.indexOf('\n') === -1 && inner.indexOf('\r') === -1) {
      // No doubled quote and no line break inside: the field is one slice.
      // (A CR or LF past q belongs to a later field, not this one.)
      value = inner;
    } else {
      // Build it up: "" is one quote, each CRLF or lone CR inside is LF,
      // and every line break inside moves the line count on.
      let v = '';
      let i = pos + 1;
      while (i < q) {
        const c = text.charCodeAt(i);
        if (c === QUOTE) {
          v += '"';
          i += 2;
        } else if (c === CR) {
          v += '\n';
          line += 1;
          i += text.charCodeAt(i + 1) === LF ? 2 : 1;
        } else {
          if (c === LF) line += 1;
          v += text[i];
          i += 1;
        }
      }
      value = v;
    }
    pos = q + 1;
    if (pos >= len) {
      fValue = value;
      fEnded = 2;
      fAdded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === COMMA) {
      pos += 1;
      fValue = value;
      fEnded = 0;
      fAdded = 0;
      return;
    }
    if (c === LF) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = 1;
      fAdded = 0;
      return;
    }
    if (c === CR && text.charCodeAt(pos + 1) === LF) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = 1;
      fAdded = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    scanUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record ends at the next LF, and its body holds no
    // quote and no CR, so every field is unquoted and the whole record is
    // one slice split on commas. (A CR just before the LF is the CRLF that
    // ends the record, not part of its body.)
    const nl0 = text.indexOf('\n', pos);
    const hasNl = nl0 !== -1;
    const nl = hasNl ? nl0 : len;
    let bodyEnd = nl;
    if (hasNl && nl > pos && text.charCodeAt(nl - 1) === CR) bodyEnd = nl - 1;
    const body = text.slice(pos, bodyEnd);
    let fields;
    if (body.indexOf('"') === -1 && body.indexOf('\r') === -1) {
      fields = body.split(',');
      pos = hasNl ? nl + 1 : len;
      if (hasNl) line += 1;
    } else {
      // Slow path: a quote or a stray CR is in this record, so read it
      // field by field.
      fields = [];
      let quoted = false;
      do {
        if (text.charCodeAt(pos) === QUOTE) {
          quoted = true;
          readQuoted();
        } else {
          quoted = false;
          scanUnquoted('');
        }
        fields.push(fValue);
      } while (fEnded === 0);

      // A line that held only stray CRs is left with no characters: no
      // record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
