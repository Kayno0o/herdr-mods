// The Review tab's data, apart from drawing: a file's diff as side-by-side rows with its notes under their lines, the list of a whole item with each row's height, and the prompts handed to a Claude.

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
const GIT_HEADER = /^diff --git a\/.* b\/(.*)$/;
const TAB = /\t/g;

export const ROW_H = 22;
// each further line of a line too long for its column
export const WRAP_H = 18;
export const CODE_SIZE = 12;
// the monospace font's advance is 0.6 of its size
const CHAR_W = CODE_SIZE * 0.6;
// the cursor bar, the line number and the +/- sign before a line's text, then a margin after it
const GUTTER = 3 + 46 + 12 + 8;
export const FILE_H = 40;
export const HUNK_H = 28;
// a note card's margins, padding, border and author line
const NOTE_HEAD_H = 46;
const NOTE_LINE_H = 18;
const NOTE_LINES = 4;
const NOTE_COLUMNS = 110;

const show = (text) => text.replace(TAB, "    ");

// The changed middle of a line replaced by another: what both keep at the start and the end is left out, so the marks show only what changed.
export function marks(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  if (start === 0 && end === 0) return null;
  return { left: [start, before.length - end], right: [start, after.length - end] };
}

// One file's patch as rows side by side: a hunk's header, then pairs of an old and a new line, each removal run beside the additions that replace it.
export function sideRows(patch) {
  const rows = [];
  let old = 0, next = 0, inHunk = false, dels = [], adds = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const left = dels[i] ?? null, right = adds[i] ?? null;
      rows.push({ kind: "pair", left, right, marks: left && right ? marks(left.text, right.text) : null });
    }
    dels = []; adds = [];
  };
  for (const line of patch.split("\n")) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      flush();
      old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true;
      rows.push({ kind: "hunk", text: hunk[3].trim(), old, next });
      continue;
    }
    if (!inHunk) continue;
    const kind = line[0], text = show(line.slice(1));
    if (kind === "-") dels.push({ line: old++, text, kind });
    else if (kind === "+") adds.push({ line: next++, text, kind });
    else if (kind === " ") { flush(); rows.push({ kind: "pair", left: { line: old++, text, kind }, right: { line: next++, text, kind }, marks: null }); }
  }
  flush();
  return rows;
}

const sideOf = (row, side) => row.kind === "pair" ? (side === "old" ? row.left : row.right) : null;

// Where each note of a file goes: under the row holding its line on its side; else, once later commits moved the line, under the row holding the text it was written on, nearest first; else under the file's header.
export function placeNotes(rows, notes) {
  const placed = new Map();
  const put = (at, note, moved) => placed.set(at, [...(placed.get(at) ?? []), { note, moved }]);
  for (const note of notes) {
    if (note.line === null || note.line === undefined) { put(-1, note, false); continue; }
    const at = rows.findIndex((r) => sideOf(r, note.side)?.line === note.line);
    if (at >= 0 && (!note.text || sideOf(rows[at], note.side).text === show(note.text))) { put(at, note, false); continue; }
    if (!note.text) { put(-1, note, true); continue; }
    const distance = (i) => Math.abs(sideOf(rows[i], note.side).line - note.line);
    const near = rows.map((r, i) => sideOf(r, note.side)?.text === show(note.text) ? i : -1).filter((i) => i >= 0).sort((a, b) => distance(a) - distance(b))[0];
    put(near ?? -1, note, true);
  }
  return placed;
}

// A note's body as the lines its card shows, long lines cut at a space (mid-word only for a word wider than the card) and the rest left for the panel under the list.
export function noteLines(body) {
  const lines = body.trim().split("\n").flatMap((line) => {
    const cut = [];
    let rest = line;
    while (rest.length > NOTE_COLUMNS) {
      const space = rest.lastIndexOf(" ", NOTE_COLUMNS);
      const at = space > 0 ? space : NOTE_COLUMNS;
      cut.push(rest.slice(0, at));
      rest = rest.slice(space > 0 ? at + 1 : at);
    }
    cut.push(rest);
    return cut;
  });
  return lines.length > NOTE_LINES ? [...lines.slice(0, NOTE_LINES - 1), `${lines[NOTE_LINES - 1]}…`] : lines;
}

export const noteHeight = (note) => NOTE_HEAD_H + NOTE_LINE_H * noteLines(note.body).length;

// How many characters fit on a line of a diff `width` wide: side by side, or in one column for a file only added or only deleted.
export function columnsOf(width) {
  const fit = (room) => width > 0 ? Math.max(10, Math.floor((room - GUTTER) / CHAR_W)) : Infinity;
  return { half: fit((width - 1) / 2), whole: fit(width) };
}

// A line cut into the pieces that fit its column, each with the part of the changed-middle marks it holds.
export function wrapLine(text, marks, cols) {
  const pieces = [];
  for (let start = 0; start === 0 || start < text.length; start += cols) {
    const end = Math.min(start + cols, text.length);
    const from = marks ? Math.max(marks[0], start) : 0, to = marks ? Math.min(marks[1], end) : 0;
    pieces.push({ text: text.slice(start, end), marks: from < to ? [from - start, to - start] : null });
  }
  return pieces;
}

// A file only added or only deleted shows in one column, its existing side.
export const singleSide = (file) => file.status === "added" ? "new" : file.status === "deleted" ? "old" : null;

// A whole item as the list draws it: each file's header, then, unless it is read and folded, its rows with their notes; every entry knows its file. The mechanical files, last in a reading order, sit under one group row and show only once it is opened.
export function buildList(files, notes, open = new Set(), groupOpen = false) {
  const list = [];
  const notesOf = (file) => notes.filter((n) => n.path === file.path && (!n.repo || !file.repo || n.repo === file.repo));
  const from = files.findIndex((f) => f.mechanical);
  files.forEach((file, fi) => {
    const own = notesOf(file);
    if (fi === from) {
      const group = files.slice(from);
      list.push({ kind: "group", fi, from, to: files.length, count: group.length, read: group.filter((f) => f.read).length, open: group.flatMap(notesOf).filter((n) => n.state === "open").length });
    }
    if (from >= 0 && fi >= from && !groupOpen) return;
    list.push({ kind: "file", fi, open: own.filter((n) => n.state === "open").length });
    if (file.read && !open.has(fi)) return;
    if (file.binary) { list.push({ kind: "meta", fi, text: "Binary file" }); return; }
    const rows = sideRows(file.patch), placed = placeNotes(rows, own);
    for (const { note, moved } of placed.get(-1) ?? []) list.push({ kind: "note", fi, note, moved });
    rows.forEach((row, i) => {
      list.push({ ...row, fi, ri: i });
      for (const { note, moved } of placed.get(i) ?? []) list.push({ kind: "note", fi, note, moved });
    });
  });
  return list;
}

// An item's requirements against its diff: each with its status and the hunks doing it (`ri` a hunk's row in its file's sideRows), each hunk's requirements under `fi:ri`, and the hunks doing none, mechanical files left out. An anchor follows its line as a note does; a requirement whose every anchor lost its line is gone.
export function traceMap(files, trace) {
  const tags = new Map(), outside = [];
  const reqs = trace.map((r) => ({ ...r, hunks: [] }));
  files.forEach((file, fi) => {
    const own = reqs.flatMap((r, k) => r.anchors.filter((a) => a.path === file.path && (!a.repo || !file.repo || a.repo === file.repo)).map((a) => ({ ...a, k })));
    const rows = sideRows(file.patch);
    for (const [at, placed] of placeNotes(rows, own)) {
      if (at < 0) continue;
      const ri = rows.findLastIndex((row, i) => i <= at && row.kind === "hunk");
      const key = `${fi}:${ri}`;
      for (const { note } of placed) {
        const req = reqs[note.k];
        if (!req.hunks.some((h) => h.fi === fi && h.ri === ri)) req.hunks.push({ fi, ri });
        if (!(tags.get(key) ?? []).includes(note.k)) tags.set(key, [...tags.get(key) ?? [], note.k]);
      }
    }
    if (!trace.length || file.mechanical) return;
    rows.forEach((row, ri) => { if (row.kind === "hunk" && !tags.has(`${fi}:${ri}`)) outside.push({ fi, ri }); });
  });
  for (const r of reqs) r.status = r.hunks.length ? (r.partly ? "partly" : "covered") : r.anchors.length ? "gone" : "missing";
  return { reqs, tags, outside };
}

const linesOf = (side, cols) => side ? Math.max(1, Math.ceil(side.text.length / cols)) : 1;

// An entry's height, a line too long for its column taking a further line per piece; `cols` comes from columnsOf, `files` tells which file is in one column.
export function heightOf(entry, cols = columnsOf(0), files = []) {
  if (entry.kind === "file" || entry.kind === "group") return FILE_H;
  if (entry.kind === "hunk") return HUNK_H;
  if (entry.kind === "note") return noteHeight(entry.note);
  if (entry.kind !== "pair") return ROW_H;
  const single = files[entry.fi] && singleSide(files[entry.fi]);
  const lines = single ? linesOf(single === "new" ? entry.right : entry.left, cols.whole) : Math.max(linesOf(entry.left, cols.half), linesOf(entry.right, cols.half));
  return ROW_H + (lines - 1) * WRAP_H;
}

// The next file still to read after `from`, wrapping around; -1 once all are read.
export function nextUnread(files, from) {
  for (let k = 1; k <= files.length; k++) {
    const fi = (from + k) % files.length;
    if (!files[fi].read) return fi;
  }
  return -1;
}

// The file J (step 1) or K (step -1) goes to from the list row `cursor`: the next or previous file, K first going back to the header of the file it is inside; -1 past either end. From the mechanical group's row, J enters it only while it is open.
export function fileJump(list, cursor, step, count) {
  const e = list[cursor];
  if (e?.kind === "group") return step < 0 ? (e.from > 0 ? e.from - 1 : -1) : list[cursor + 1]?.kind === "file" ? e.from : -1;
  const fi = e?.fi ?? -1, header = list.findIndex((x) => x.kind === "file" && x.fi === fi);
  const to = step < 0 && header >= 0 && cursor > header ? fi : fi + step;
  return to >= 0 && to < count ? to : -1;
}

// The rail's items in its order: tickets, loose commits, then the approved ones, newest first, while shown.
export function railGroups(items) {
  return { tickets: items.filter((i) => i.ticket && !i.approved), loose: items.filter((i) => !i.ticket && !i.approved), done: items.filter((i) => i.approved).reverse() };
}

export function railOrder(items, history) {
  const { tickets, loose, done } = railGroups(items);
  return [...tickets, ...loose, ...history ? done : []];
}

// The list index of the next open note after `from`, wrapping around.
export function nextOpenNote(list, from) {
  for (let k = 1; k <= list.length; k++) {
    const i = (from + k) % list.length;
    if (list[i].kind === "note" && list[i].note.state === "open") return i;
  }
  return -1;
}

// A Working diff (git diff output) as files the same list draws, none read.
export function splitFiles(patch) {
  const files = [];
  for (const line of patch.split("\n")) {
    const header = GIT_HEADER.exec(line);
    if (header) files.push({ repo: "", path: header[1], patch: "", added: 0, removed: 0, binary: false, read: false, status: "modified" });
    const file = files.at(-1);
    if (!file) continue;
    file.patch += `${line}\n`;
    if (line.startsWith("Binary files ")) file.binary = true;
    else if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line[0] === "+" && !line.startsWith("+++ ")) file.added++;
    else if (line[0] === "-" && !line.startsWith("--- ")) file.removed++;
  }
  return files;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_MS = 86400000;

// When an item's commits were made, as a short label: "today", "yesterday", "5 nov", or a span "4–5 nov".
export function daysLabel(timestamps, now = Date.now()) {
  const day = (ts) => { const d = new Date(ts * 1000); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const today = day(now / 1000);
  const name = (t) => t === today ? "today" : t === today - DAY_MS ? "yesterday" : `${new Date(t).getDate()} ${MONTHS[new Date(t).getMonth()]}`;
  const days = [...new Set(timestamps.map(day))].sort((a, b) => a - b);
  if (!days.length) return "";
  if (days.length === 1) return name(days[0]);
  const first = new Date(days[0]), last = new Date(days.at(-1));
  if (first.getMonth() === last.getMonth() && days.at(-1) < today - DAY_MS) return `${first.getDate()}–${last.getDate()} ${MONTHS[last.getMonth()]}`;
  return `${name(days[0])} – ${name(days.at(-1))}`;
}

// A path under the home folder written from "~", as the pane headers show it.
export const tildePath = (path, home) => home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

// What a comment on a line of the Working diff reads like once pasted into a Claude.
export const commentText = (path, at, body) => `${path}${at ? `:${at.line}${at.side === "old" ? " (old side)" : ""}` : ""}: ${body.trim()}`;

// The tree of a work tree as it is now, untracked files included, built on a copy of the index so the real one and the files are left alone.
export const SNAPSHOT = `set -e
idx=$(mktemp)
trap 'rm -f "$idx"' EXIT
cp "$(git rev-parse --git-path index)" "$idx" 2>/dev/null || true
GIT_INDEX_FILE="$idx" git add -A
GIT_INDEX_FILE="$idx" git write-tree`;

// The Claude an item's work goes back to: the live terminal that made its latest commit, else the one picked.
export function claudeFor(commits, live, picked) {
  const alive = new Set(live);
  return commits.findLast((c) => c.terminal && alive.has(c.terminal))?.terminal ?? picked ?? null;
}

// What the Ask buttons hand a Claude; `cli` is how it runs the review CLI.
export const PROMPTS = {
  review: (cli, project, item) => `Review ${item.title} in the ${project} review inbox. Read it with \`${cli} show ${project} ${item.key}\`, then add a note on each line that is wrong, risky or unclear: \`${cli} note ${project} ${item.key} <path> <body> --at "<text of the line>"\`. Notes are exceptions, not a summary: none on a line that is fine.`,
  describe: (cli, project, item) => `Describe ${item.title} for its review: read \`${cli} show ${project} ${item.key}\`, then write in French, in one to three sentences, what it changes and why: \`${cli} prose ${project} ${item.key} "<text>"\`. Then give the order to read its files in, as the review skill says: \`${cli} order ${project} ${item.key}\` with one line per file on stdin, \`<path> <why it changed, a few words in French>\`, or \`<path> mechanical\`.`,
  file: (cli, project, shas) => `File the loose commits ${shas.join(", ")} of the ${project} review inbox under their Tilid tickets: for each, find the ticket it belongs to in Tilid and run \`${cli} file ${project} <sha> "#<number> - [<USE_CASE>] <title>"\`. Leave a commit that belongs to no ticket alone.`,
  trace: (cli, project, item) => `Trace ${item.title} to its requirements, as the review skill says: read the ticket and the spec of the use case it names (a forge issue's checklist when it is no Tilid ticket), read \`${cli} show ${project} ${item.key}\`, then run \`${cli} trace ${project} ${item.key}\` with on stdin one \`- <requirement, in the spec's own words>\` line per requirement, each followed by indented \`<path> <text of a line doing it>\` lines and \`partly: <what is left, in French>\` when it is only partly done. A requirement nothing does gets no line under it.`,
  shots: (cli, project, item) => `Take before and after screenshots of the screens ${item.title} changes, following the review skill: write its scenario, then \`${cli} shoot ${project} ${item.key} --stack <dir>\` on a disposable stack, never mine, and look at every image it takes.`,
};
