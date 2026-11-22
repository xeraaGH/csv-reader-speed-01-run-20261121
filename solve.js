// csv-reader, faster: a drop-in for make.fun's csv-reader 1.0.0 that answers
// exactly as it does on every case ({columns, rows, errors}), in less CPU time.
//
// The reference reads one character at a time and builds every field up a
// character at a time. This reader does the same reading, but in bulk: most
// records are handled by one of two fast paths, and only the records that
// need the reference's care fall back to a field-by-field scan.
//
//   1. Record fast path: a record whose line holds no quote and no stray CR
//      is split by String.split, native code, in one go (a trailing CR right
//      before the LF is the CRLF that ends the record).
//   2. Segment path: the record's line is sliced once and parsed field by
//      field with indexOf scans that never leave the line, so a stray CR or
//      a quote can only be found where it matters. Quoted fields close
//      inside the line, "" collapses to one quote, a lone CR inside quotes
//      becomes LF and counts its line, and junk after a closing quote is
//      appended exactly as the reference appends it (quote_junk when it
//      adds anything). A quoted field whose closing quote is not on this
//      line spans lines, so the record falls back to path 3.
//   3. Global path: the reference's own loop, written with indexOf scans
//      instead of one-character steps: unquoted fields end at the next
//      comma, LF or CR found by a single regex scan, quoted fields close
//      at the next undoubled quote, and an unterminated quote is read
//      again as unquoted, exactly as the reference reads it.
//
// The fallback rolls the error list back to the record's start and re-reads
// the record from its first character, so no error is ever counted twice.
// Every rule of the reference is kept: the U+FEFF at the very start is
// dropped, empty lines are no records, a lone CR outside quotes is dropped
// with stray_cr, a line left with only stray CRs is no record, fields stay
// strings, records are padded (short_row) or cut (long_row) to the first
// record's width, and every error carries the line its record starts on.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. Dependency-free, JavaScript only: no WebAssembly, no native
// addon, no prebuilt binary, as the competition's rules require.

const COMMA = 0, LINE_BREAK = 1, END = 2;
const RE = /[,\r\n]/g;

/** csv-reader 1.0.0's answer for one case's input, faster. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // --- global parser: the reference's loop, with indexOf scans ---
  // Used only when a record spans lines (a quoted field that does not close
  // on its first line) or never closes at all.

  // The text between a and b of a quoted field: CRs become LF, lines counted.
  function chunk(a, b) {
    if (a === b) return '';
    const s = text.slice(a, b);
    const r = s.indexOf('\r');
    if (r === -1) {
      let n = 0, i = -1;
      while ((i = s.indexOf('\n', i + 1)) !== -1) n++;
      line += n;
      return s;
    }
    const m = s.match(/\r\n|\r|\n/g);
    line += m ? m.length : 0;
    return s.replace(/\r\n?/g, '\n');
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and how it ended; `added` counts the characters kept.
  function readUnquoted(value) {
    let added = 0;
    RE.lastIndex = pos;
    for (;;) {
      const m = RE.exec(text);
      if (m === null) {
        const s = text.slice(pos, len);
        value += s; added += s.length; pos = len;
        return { value, ended: END, added };
      }
      const i = m.index;
      const c = m[0];
      if (c === ',') {
        value += text.slice(pos, i); added += i - pos; pos = i + 1;
        return { value, ended: COMMA, added };
      }
      if (c === '\n') {
        value += text.slice(pos, i); added += i - pos; pos = i + 1; line++;
        return { value, ended: LINE_BREAK, added };
      }
      if (text[i + 1] === '\n') {
        value += text.slice(pos, i); added += i - pos; pos = i + 2; line++;
        return { value, ended: LINE_BREAK, added };
      }
      value += text.slice(pos, i); added += i - pos;
      error('stray_cr');
      pos = i + 1;
      RE.lastIndex = pos;
    }
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let value = '';
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (text[q + 1] === '"') {
        value += chunk(pos, q);
        value += '"';
        pos = q + 2;
        continue;
      }
      value += chunk(pos, q);
      pos = q + 1;
      break;
    }
    if (pos >= len) return { value, ended: END };
    const c = text[pos];
    if (c === ',') { pos += 1; return { value, ended: COMMA }; }
    if (c === '\n') { pos += 1; line += 1; return { value, ended: LINE_BREAK }; }
    if (c === '\r' && text[pos + 1] === '\n') { pos += 2; line += 1; return { value, ended: LINE_BREAK }; }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  // Parse one record with the global parser.
  function parseGlobal() {
    const fields = [];
    let field;
    let firstQuoted = false;
    let first = true;
    do {
      const quoted = text[pos] === '"';
      if (first) { firstQuoted = quoted; first = false; }
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);
    return { fields, firstQuoted };
  }

  // --- segment parser: one record, read off its own line ---
  // Parses the line segment [pos, lineEnd) with scans that never leave it.
  // Returns { fields, firstQuoted } on success, or null to fall back to
  // parseGlobal (a quoted field spans lines). Advances pos/line past the
  // record on success; leaves them alone on null.
  function parseSegment(lineEnd, nl) {
    const seg = text.slice(pos, lineEnd);
    const segLen = seg.length;
    const fields = [];
    let p = 0;
    let firstQuoted = false;
    let first = true;
    for (;;) {
      let value = '';
      if (seg[p] === '"') {
        // A field that opens with a quote runs to the next quote that is
        // not doubled; "" inside it is one quote.
        let start = p + 1;
        let closed = -1;
        let q = seg.indexOf('"', start);
        if (q === -1) return null;
        let parts = null;
        for (;;) {
          if (seg[q + 1] === '"') {
            if (parts === null) parts = [];
            parts.push(seg.slice(start, q));
            parts.push('"');
            start = q + 2;
            q = seg.indexOf('"', start);
            if (q === -1) return null;
            continue;
          }
          closed = q;
          break;
        }
        let content = seg.slice(start, closed);
        if (parts !== null) {
          parts.push(content);
          content = parts.join('');
        }
        // Each CRLF or lone CR inside quotes is read as LF.
        const r = content.indexOf('\r');
        if (r !== -1) {
          const m = content.match(/\r\n|\r|\n/g);
          line += m ? m.length : 0;
          content = content.replace(/\r\n?/g, '\n');
        }
        value = content;
        p = closed + 1;
        if (p >= segLen) {
          fields.push(value);
          if (nl === -1) { pos = len; }
          else { pos = nl + 1; line += 1; }
          return { fields, firstQuoted: first ? true : firstQuoted, ended: nl === -1 ? END : LINE_BREAK };
        }
        if (seg[p] === ',') {
          fields.push(value);
          if (first) { firstQuoted = true; first = false; }
          p += 1;
          continue;
        }
        // Junk after the closing quote, appended as it stands, up to the
        // next comma or line break.
        let added = 0;
        let junkComma = false;
        for (;;) {
          const ci = seg.indexOf(',', p);
          const ri = seg.indexOf('\r', p);
          if (ci !== -1 && (ri === -1 || ci < ri)) {
            const j = seg.slice(p, ci);
            value += j; added += j.length;
            p = ci + 1;
            junkComma = true;
            break;
          }
          if (ri !== -1 && ri < (ci === -1 ? segLen : ci)) {
            if (ri === segLen - 1 && nl !== -1) {
              const j = seg.slice(p, ri);
              value += j; added += j.length;
              p = segLen;
              break;
            }
            const j = seg.slice(p, ri);
            value += j; added += j.length;
            error('stray_cr');
            p = ri + 1;
            continue;
          }
          const j = seg.slice(p);
          value += j; added += j.length;
          p = segLen;
          break;
        }
        if (added > 0) error('quote_junk');
        fields.push(value);
        if (first) { firstQuoted = true; first = false; }
        if (junkComma) continue;
        if (p >= segLen) {
          if (nl === -1) { pos = len; }
          else { pos = nl + 1; line += 1; }
          return { fields, firstQuoted, ended: nl === -1 ? END : LINE_BREAK };
        }
        continue;
      }
      // An unquoted field: a quote inside it is a literal character.
      for (;;) {
        const ci = seg.indexOf(',', p);
        const ri = seg.indexOf('\r', p);
        if (ci !== -1 && (ri === -1 || ci < ri)) {
          value += seg.slice(p, ci);
          p = ci + 1;
          fields.push(value);
          if (first) { firstQuoted = false; first = false; }
          break;
        }
        if (ri !== -1 && ri < (ci === -1 ? segLen : ci)) {
          if (ri === segLen - 1 && nl !== -1) {
            value += seg.slice(p, ri);
            fields.push(value);
            if (first) { firstQuoted = false; first = false; }
            pos = nl + 1; line += 1;
            return { fields, firstQuoted, ended: LINE_BREAK };
          }
          value += seg.slice(p, ri);
          error('stray_cr');
          p = ri + 1;
          continue;
        }
        value += seg.slice(p);
        fields.push(value);
        if (first) { firstQuoted = false; first = false; }
        if (nl === -1) { pos = len; }
        else { pos = nl + 1; line += 1; }
        return { fields, firstQuoted, ended: nl === -1 ? END : LINE_BREAK };
      }
    }
  }

  // A record's fields, kept: the header, or a row padded or cut to the
  // first record's width. A line left with no characters is no record.
  function finishRecord(fields, firstQuoted) {
    if (fields.length === 1 && fields[0] === '' && !firstQuoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; return; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text[pos];
      if (c === '\n') { pos += 1; line += 1; }
      else if (c === '\r' && text[pos + 1] === '\n') { pos += 2; line += 1; }
      else break;
    }
    if (pos >= len) break;
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    // Record fast path: no quote, no stray CR — one native split.
    const q0 = text.indexOf('"', pos);
    if (q0 === -1 || q0 >= lineEnd) {
      const r0 = text.indexOf('\r', pos);
      if (r0 === -1 || r0 >= lineEnd) {
        const fields = text.slice(pos, lineEnd).split(',');
        if (nl === -1) { pos = len; }
        else { pos = nl + 1; line += 1; }
        finishRecord(fields, false);
        continue;
      }
      if (nl !== -1 && r0 === lineEnd - 1) {
        const fields = text.slice(pos, lineEnd - 1).split(',');
        pos = nl + 1; line += 1;
        finishRecord(fields, false);
        continue;
      }
    }
    const errMark = errors.length;
    const recStart = pos;
    const seg = parseSegment(lineEnd, nl);
    if (seg !== null) {
      finishRecord(seg.fields, seg.firstQuoted);
    } else {
      // The record spans lines: roll back and read it with the global
      // parser, from its first character.
      errors.length = errMark;
      line = recordLine;
      pos = recStart;
      const g = parseGlobal();
      finishRecord(g.fields, g.firstQuoted);
    }
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
