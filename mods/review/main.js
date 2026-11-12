// The Review tab of a space (Ctrl+Shift+R, or a commit's ticket from Changes). Inbox: the project's tickets and loose commits still to review, each one's net diff side by side with its notes under their lines, read file by file, approved, its notes handed back to a Claude. Working: what a Claude changed since you last looked, a line's comment pasted into it.
// The layout's copy only listens for review.open and review.request (Changes' ask, its props in shared REQUEST); the view is a tab whose only pane is this mod, reused while the space has one.
// Keys, while the tab has the keyboard: r read and next (unread again on a read file), n next open note, c comment, a approve, s send the notes, j/k move, enter open, v/x/d resolve, reject, delete the picked note.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle, TextView } from "gpui-base";
import { agents, panes, spaces, focused, exec, hc, home, appHome, readTextFile, writeTextFile, watchFolder, theme, settings, props, shared, setShared, closeOverlay, nextCommand, run, notify } from "herdr";
import { buildList, heightOf, columnsOf, wrapLine, singleSide, ROW_H, WRAP_H, CODE_SIZE, nextUnread, nextOpenNote, noteLines, splitFiles, daysLabel, commentText, SNAPSHOT, claudeFor, PROMPTS, tildePath } from "./model.js";
import { BUN, CLI, REVIEWS } from "./paths.js";
import { PICKS, folderOf, pickRepo, repoName } from "./repos.js";

const RESTORE_CLIPBOARD_MS = 1500;
const STATE_DIR = () => `${home()}/.local/state/herdr-review`;
const SHOTS = "cache/review-shots";
const TAB_NAME = "Review";
const REQUEST = "review.request";
// what the scrollbar laid over the diff takes from its lines
const SCROLLBAR_W = 10;
// how far from a file header's right end its Read box and label reach
const READ_BOX_W = 96;
const MONO = () => settings().font_family ?? "JetBrains Mono";
const STATUS = { added: "A", deleted: "D", renamed: "R", modified: "M" };
const KEYS = [["r", "read, next"], ["n", "next note"], ["c", "comment"], ["a", "approve"], ["s", "send notes"], ["j k", "move"], ["enter", "open"], ["esc", "close"]];

const lastLine = (text) => text.trim().split("\n").filter(Boolean).at(-1) ?? "";
const messageOf = (e) => e instanceof Error ? e.message : String(e);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);
const short = (sha) => sha.slice(0, 8);
const fail = (e) => notify({ title: "Review", body: messageOf(e), level: "error" });
const PNG_SIZE = /(\d+) x (\d+)/;

// An image has no aspect-ratio style, so a shot is sized from its own pixels to fit the room.
function fitted(shot, width, height) {
  const scale = Math.min(width / shot.w, height / shot.h);
  return image(shot.path).w(Math.floor(shot.w * scale)).h(Math.floor(shot.h * scale));
}

// Shows the space's Review tab on what `extra` asks for (a tab, a repo, an item and commit), opening one when the space has none.
function openReview(extra = {}) {
  const request = { ...extra, from: focused()?.terminal ?? null, space: focused()?.space ?? null, at: Date.now() };
  const tab = spaces().find((s) => s.id === focused()?.space)?.tabs.find((t) => t.named && t.name === TAB_NAME);
  if (!tab) return run("tab.new", { name: TAB_NAME, space: focused()?.space, mod: "review", props: { ...request, view: true } });
  setShared(REQUEST, request);
  run("tab.select", { id: tab.id });
}

// The review CLI of the herdr-mods checkout setup installed this from; every command prints JSON.
async function cli(...args) {
  if (!CLI) throw new Error("Run `bun run setup` in herdr-mods: the Review tab does not know where its CLI is");
  const r = await exec(BUN, [CLI, ...args, "--json"]);
  if (r.code !== 0) throw new Error(lastLine(r.stderr || r.stdout) || `review ${args[0]} failed`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

async function readText(path) {
  try { return await readTextFile(path); } catch { return null; }
}

export default class Review extends View {
  // init is handed no props: props() holds what the layout or tab.new passed.
  init(_props, cx) {
    const p = props() ?? {};
    // A window left from when the view was an overlay: nothing draws in it anymore, so it closes.
    if (p.overlay) { closeOverlay(p.overlay); return; }
    if (!p.view) {
      cx.spawn(async () => {
        for (;;) {
          const command = await nextCommand();
          if (command === "open") openReview();
          if (command === "request") openReview(shared(REQUEST) ?? {});
        }
      });
      return;
    }
    this.view = true;
    this.async = cx;
    // Every space has its own Review tab, and the shared request reaches them all: each keeps to its space's requests and Claudes. A tab opened before its space was a prop takes it at its first draw, since a tab draws only while its space shows.
    this.space = p.space ?? null;
    this.h = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.tab = "inbox";
    this.root = null; this.from = null; this.on = null; this.error = null; this.busy = null;
    this.families = new Map(); this.family = null; this.picksSeen = shared(PICKS);
    // Inbox
    this.project = null; this.summary = null; this.itemKey = null; this.commit = null; this.item = null;
    this.watching = null; this.loading = false; this.again = false; this.pending = 0; this.edits = 0; this.history = false; this.shots = new Map(); this.shot = null; this.shotRoom = { w: 0, h: 0 };
    // Working
    this.seen = {}; this.now = null; this.base = "HEAD"; this.statusSeen = null; this.workFiles = [];
    // The diff shown
    this.files = []; this.notes = []; this.list = []; this.heights = []; this.opened = new Set(); this.cursor = 0;
    // diffW: the diff's width; pressX: where the last press in it landed, since a list's click only names the row
    this.diffW = 0; this.cols = columnsOf(0); this.pressX = null;
    this.target = null; this.picked = null; this.text = "";
    this.input = InputState.new({ placeholder: "What is wrong, risky or unclear here" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.ask(p);
    cx.spawn(async (cx) => {
      for (;;) if (await nextCommand() === "focus") { this.h.focus(); cx.notify(); }
    });
    cx.spawn(async (cx) => {
      this.seen = JSON.parse(await readText(`${STATE_DIR()}/seen.json`) ?? "{}");
      this.h.focus();
      this.reload(cx);
    });
  }

  // Takes an open request: its tab, repo, item and commit, and the Claude it came from, else the space's first.
  ask(p) {
    this.requested = p.at ?? 0;
    if (p.tab === "working" || p.tab === "inbox") this.tab = p.tab;
    if (p.item || p.commit) { this.tab = "inbox"; this.itemKey = p.item ?? null; this.commit = p.commit ?? null; this.wanted = p.commit ?? null; }
    this.from = p.root ?? null;
    const list = this.claudes();
    this.claude = list.find((a) => a.address === p.from)?.address ?? list.find((a) => a.address === this.claude)?.address ?? list[0]?.address ?? null;
  }

  // The Claudes of the shown space, each with its folder.
  claudes() {
    const cwd = new Map(panes().map((p) => [p.pane, p.cwd]));
    return agents().filter((a) => a.program?.agent && a.space === this.space).map((a) => ({ ...a, cwd: cwd.get(a.pane) ?? null }));
  }

  // The repo the tab is about: the one Changes opened it on, else the picked Claude's, else the focused pane's; within its family (a docker checkout and the app repos it holds), the one picked here or in Changes.
  async locate() {
    const space = spaces().find((s) => s.id === this.space) ?? spaces().find((s) => s.active), on = space?.machine ?? null;
    this.on = on;
    const f = focused()?.space === space?.id ? focused() : null;
    const cwd = this.from ?? this.claudes().find((a) => a.address === this.claude)?.cwd ?? folderOf(space, f, panes(), agents());
    if (!cwd) return null;
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
    if (top.code !== 0) return null;
    const picked = await pickRepo(top.stdout.trim(), (cmd, args, at) => exec(cmd, args, { cwd: at, on }), shared(PICKS), this.families, on);
    this.family = picked.family ? picked : null;
    return picked.shown;
  }

  // The picked Claude follows the repo shown: one working in it, when the picked one is not.
  followRepo() {
    const list = this.claudes(), root = this.root;
    const inRepo = (a) => Boolean(a.cwd) && (a.cwd === root || a.cwd.startsWith(`${root}/`));
    if (list.some((a) => a.address === this.claude && inRepo(a))) return;
    this.claude = list.find(inRepo)?.address ?? list.find((a) => a.address === this.claude)?.address ?? list[0]?.address ?? null;
  }

  showRepo(repo) {
    setShared(PICKS, { ...(shared(PICKS) ?? {}), [this.family.at]: repo });
  }

  // A commit made by hand, filed into the inbox the hook fills with the Claudes' ones.
  fileHead(cx) {
    const root = this.root;
    this.write(async () => {
      const added = await cli("add", "--repo", root);
      notify({ title: "Review", body: `${short(added.sha)} ${added.result} in ${added.project}`, level: "success", timeout: 2500 });
    }, cx);
  }

  // Loads what the tab shows; a reload asked while one runs runs once it ends, and none runs while a write is on its way, so what was just changed on screen does not flick back. One already running when a change lands is dropped, the change's own write reloading after it.
  reload(cx, quiet = false) {
    if (this.pending) return;
    if (this.loading) { this.again = true; return; }
    this.loading = true; this.error = null;
    if (!quiet) { this.busy = "Loading…"; cx.notify(); }
    const edits = this.edits, stale = () => this.edits !== edits;
    cx.spawn(async (cx) => {
      try {
        const root = await this.locate();
        if (!root) { this.error = "No git repository here"; this.show([]); return; }
        this.root = root;
        this.followRepo();
        if (this.tab === "working") await this.loadWorking();
        else await this.loadInbox(cx, stale);
      } catch (e) { this.error = messageOf(e); }
      finally {
        this.busy = null; this.loading = false; cx.notify();
        if (this.again) { this.again = false; this.reload(cx, true); }
      }
    });
  }

  // Everything is fetched before anything is shown, so a load gone stale on the way leaves the screen as it is.
  async loadInbox(cx, stale) {
    if (this.on) throw new Error("Review inboxes are read on this machine only");
    // commits made in a terminal or rewritten by a rebase, which the commit hook does not see
    await cli("sync", "--repo", this.root);
    let summary;
    try { summary = await cli("inbox", "--repo", this.root); }
    catch (e) {
      if (!messageOf(e).startsWith("no inbox")) throw e;
      if (stale()) return;
      this.summary = null; this.project = null; this.item = null; this.show([]);
      return;
    }
    const items = summary.items, project = summary.project;
    const wanted = this.wanted && items.find((i) => i.commits.some((c) => c.sha.startsWith(this.wanted)));
    const key = wanted?.key ?? items.find((i) => i.key === this.itemKey || i.ticket && `#${i.ticket.number}` === this.itemKey)?.key ?? items.find((i) => !i.approved)?.key ?? null;
    const item = key ? await cli("show", project, key, ...(this.commit ? ["--commit", this.commit] : [])) : null;
    if (stale()) return;
    this.wanted = null;
    this.summary = summary;
    if (project !== this.project) { this.project = project; this.watch(cx); }
    this.showItem(key, item);
    await this.copyShots();
  }

  showItem(key, item) {
    const same = key && key === this.item?.key;
    if (!same) { this.opened = new Set(); this.cursor = 0; this.target = null; this.picked = null; this.shot = null; }
    this.itemKey = key;
    this.item = item;
    if (!item) { this.show([]); return; }
    if (item.commit === null) this.commit = null;
    this.show(item.files, item.notes.filter((n) => n.path));
    if (!same) this.scroll.scroll_to_item(0);
  }

  // Shots are drawn from Herdr's own folder only, so each item's are copied under it once.
  async copyShots() {
    const files = (this.item?.shots ?? []).flatMap((s) => [s.before, s.after]).filter((f) => f && !this.shots.has(f));
    if (!files.length) return;
    const dir = `${SHOTS}/${this.project}`;
    await exec("mkdir", ["-p", `${appHome()}/${dir}`]);
    const r = await exec("cp", ["-u", ...files, `${appHome()}/${dir}/`]);
    if (r.code !== 0) throw new Error(lastLine(r.stderr));
    const sizes = (await exec("file", ["-b", ...files])).stdout.split("\n");
    files.forEach((f, i) => {
      const size = PNG_SIZE.exec(sizes[i] ?? "");
      this.shots.set(f, { path: `${dir}/${baseName(f)}`, w: size ? Number(size[1]) : 16, h: size ? Number(size[2]) : 10 });
    });
  }

  // An agent writing notes, prose or shots redraws the tab as it lands.
  watch(cx) {
    const project = this.project;
    if (!REVIEWS || this.watching === project) return;
    this.watching = project;
    cx.spawn(async (cx) => {
      try {
        while (this.watching === project) {
          await watchFolder(`${REVIEWS}/${project}`);
          if (this.watching === project && this.tab === "inbox") this.reload(cx, true);
        }
      } catch { if (this.watching === project) this.watching = null; }
    });
  }

  show(files, notes = []) {
    this.files = files;
    this.notes = notes;
    this.rebuild();
  }

  rebuild() {
    this.list = buildList(this.files, this.notes, this.opened);
    this.heights = this.list.map((e) => heightOf(e, this.cols, this.files));
    this.cursor = Math.min(this.cursor, Math.max(this.list.length - 1, 0));
    if (this.picked && !this.notes.some((n) => n.id === this.picked)) this.picked = null;
  }

  // Runs a CLI write, then shows the inbox as it now is.
  write(work, cx) {
    this.pending++; this.edits++;
    cx.spawn(async (cx) => {
      try { await work(); }
      catch (e) { fail(e); }
      finally { if (--this.pending === 0) this.reload(cx, true); }
    });
  }

  pickItem(key, cx) {
    if (key === this.itemKey && !this.commit) return;
    this.itemKey = key; this.commit = null;
    this.reload(cx);
  }

  pickCommit(sha, cx) {
    this.commit = sha;
    this.opened = new Set(); this.cursor = 0; this.target = null;
    this.reload(cx);
    this.scroll.scroll_to_item(0);
  }

  fileAt(i = this.cursor) {
    return this.files[this.list[i]?.fi ?? -1] ?? null;
  }

  headerOf(fi) {
    return this.list.findIndex((e) => e.kind === "file" && e.fi === fi);
  }

  moveTo(i, cx, where = "center") {
    if (i < 0 || i >= this.list.length) return;
    this.cursor = i;
    this.scroll.scroll_to_item(i, where);
    cx.notify();
  }

  // Marks a file read, folding it, or unread; the file's own change is shown at once and written behind.
  toggleRead(fi, cx, read = !this.files[fi].read) {
    const file = this.files[fi];
    if (this.tab !== "inbox" || !file || file.read === read) return;
    file.read = read;
    this.opened.delete(fi);
    this.rebuild(); this.tally();
    cx.notify();
    const key = this.item.key;
    this.write(() => cli("read", this.project, key, `${file.repo}:${file.path}`, ...(read ? [] : ["--undo"])), cx);
  }

  // r: the file under the cursor is read, and the next one to read comes up; on a file already read, it is unread again.
  readAndNext(cx) {
    const fi = this.list[this.cursor]?.fi ?? nextUnread(this.files, -1);
    if (fi < 0 || !this.files[fi]) return;
    if (this.files[fi].read) { this.toggleRead(fi, cx, false); return; }
    this.toggleRead(fi, cx, true);
    const next = nextUnread(this.files, fi);
    if (next < 0) { this.moveTo(this.headerOf(fi), cx); notify({ title: "Review", body: this.openCount() ? "Every file read: n goes through the open notes" : "Every file read: a approves", level: "success", timeout: 2500 }); return; }
    this.moveTo(this.headerOf(next), cx, "top");
  }

  readAll(cx) {
    for (const f of this.files) f.read = true;
    this.opened.clear(); this.rebuild(); this.tally(); cx.notify();
    const key = this.item.key;
    this.write(() => cli("read", this.project, key, "--all"), cx);
  }

  // The rail's row of the shown item follows a change made here at once, as the diff does; a single commit's files say nothing of the item's read count.
  tally() {
    const row = this.summary?.items.find((i) => i.key === this.item?.key);
    if (!row) return;
    if (!this.commit) row.read = this.files.filter((f) => f.read).length;
    row.open = this.openCount();
    row.approved = this.item.approved;
  }

  openCount() {
    return this.notes.filter((n) => n.state === "open").length + (this.item?.notes.filter((n) => !n.path && n.state === "open").length ?? 0);
  }

  // a: the item is approved and the next one still to review comes up.
  approve(cx, tilid = false) {
    const item = this.item;
    if (!item) return;
    const undo = item.approved;
    const after = this.summary.items.slice(this.summary.items.findIndex((i) => i.key === item.key) + 1).find((i) => !i.approved);
    item.approved = !undo; this.tally(); cx.notify();
    this.write(async () => {
      await cli("approve", this.project, item.key, ...(undo ? ["--undo"] : []));
      if (!undo && after) { this.itemKey = after.key; this.commit = null; }
      if (!tilid) return;
      const moved = await cli("advance", this.project, item.key);
      notify({ title: "Review", body: moved.moved ? `#${moved.number} is now "${moved.status}" in Tilid` : `#${moved.number} stays where it is in Tilid: ${moved.skipped}`, level: moved.moved ? "success" : "warning" });
    }, cx);
  }

  // Opens the composer on a row: a line on its new side (else its old one), or a whole file from its header.
  compose(i, cx, side = null) {
    const e = this.list[i], file = this.fileAt(i);
    if (!e || !file) return;
    if (e.kind === "note") { this.pickNote(e.note.id, cx); return; }
    let at = null;
    if (e.kind === "pair") {
      const s = side ?? (e.right ? "new" : "old"), half = s === "new" ? e.right : e.left;
      if (!half) return;
      at = { line: half.line, side: s };
    }
    this.target = { index: i, repo: file.repo, path: file.path, at };
    this.picked = null; this.cursor = i;
    this.input.set_value(""); this.text = "";
    this.input.focus();
    cx.notify();
  }

  submit(cx, send = false) {
    const target = this.target, body = this.text.trim();
    if (!target || !body) return;
    if (this.tab === "working") {
      cx.spawn(async (cx) => { if (await this.deliver(commentText(target.path, target.at, body), send, cx)) this.closeComposer(cx); });
      return;
    }
    const at = target.at ? ["--line", String(target.at.line), "--side", target.at.side] : [];
    const key = this.item.key;
    this.closeComposer(cx);
    this.write(() => cli("note", this.project, key, `${target.repo}:${target.path}`, body, ...at, "--author", "me"), cx);
  }

  closeComposer(cx) {
    this.input.set_value(""); this.text = ""; this.target = null;
    this.h.focus();
    cx.notify();
  }

  pickNote(id, cx) {
    this.picked = this.picked === id ? null : id;
    this.target = null;
    const i = this.list.findIndex((e) => e.kind === "note" && e.note.id === id);
    if (i >= 0) this.cursor = i;
    this.h.focus();
    cx.notify();
  }

  note(id = this.picked) {
    return this.item?.notes.find((n) => n.id === id) ?? null;
  }

  setState(state, cx) {
    const note = this.note();
    if (!note || note.state === state) return;
    note.state = state; this.tally(); cx.notify();
    this.write(() => cli("state", this.project, state, note.id), cx);
  }

  dropNote(cx) {
    const note = this.note();
    if (!note) return;
    this.picked = null;
    this.item.notes = this.item.notes.filter((n) => n !== note);
    this.show(this.files, this.notes.filter((n) => n !== note));
    this.tally(); cx.notify();
    this.write(() => cli("drop", this.project, note.id), cx);
  }

  nextNote(cx) {
    const i = nextOpenNote(this.list, this.cursor);
    if (i < 0) { notify({ title: "Review", body: "No open note left", level: "info", timeout: 2000 }); return; }
    this.picked = this.list[i].note.id; this.target = null;
    this.moveTo(i, cx);
  }

  // Into a Claude's prompt: pasted for you to finish and send, or sent at once.
  async deliver(text, send, cx, to = this.claude) {
    if (!to) { notify({ title: "Review", body: "No Claude in this space to hand it to", level: "warning" }); return false; }
    if (send) {
      const r = await hc(["send", to, text]);
      if (r.code !== 0) { notify({ title: "Review", body: lastLine(r.stderr || r.stdout), level: "error" }); return false; }
      return true;
    }
    run("agent.focus", { terminal: to });
    const held = cx.read_from_clipboard();
    cx.write_to_clipboard(text);
    run("terminal.paste");
    if (held !== undefined) cx.timer.after(RESTORE_CLIPBOARD_MS, (cx) => cx.write_to_clipboard(held));
    return true;
  }

  // The item's work goes to the Claude that made its latest commit while it still runs, else the picked one.
  handTo() {
    return claudeFor(this.item?.commits ?? [], agents().map((a) => a.address), this.claude);
  }

  // s: the open notes, as a brief for the Claude to fix them and mark them resolved.
  sendNotes(cx, all = false) {
    if (!this.project) return;
    if (!all && !this.openCount()) { notify({ title: "Review", body: "No open note to send", level: "info", timeout: 2000 }); return; }
    const to = all ? this.claude : this.handTo();
    cx.spawn(async (cx) => {
      try { await this.deliver(await cli("brief", this.project, ...(all ? [] : [this.item.key])), false, cx, to); }
      catch (e) { fail(e); }
    });
  }

  askClaude(what, cx) {
    const item = this.item, cliLine = `${BUN} ${CLI}`;
    if (what === "file") {
      const loose = this.summary.items.filter((i) => !i.ticket && !i.approved).map((i) => short(i.key));
      cx.spawn(async (cx) => { await this.deliver(PROMPTS.file(cliLine, this.project, loose), false, cx); });
      return;
    }
    if (!item) return;
    cx.spawn(async (cx) => { await this.deliver(PROMPTS[what](cliLine, this.project, item), false, cx, this.handTo()); });
  }

  seenKey() { return `${this.on ?? ""}:${this.root}`; }

  // What changed since the last Mark seen (since HEAD before the first), commits included: both ends are trees, the work tree's now taken on a copy of the index.
  async loadWorking() {
    const opts = { cwd: this.root, on: this.on };
    const snap = await exec("sh", ["-c", SNAPSHOT], opts);
    if (snap.code !== 0) throw new Error(lastLine(snap.stderr) || "snapshot failed");
    this.now = snap.stdout.trim();
    this.base = this.seen[this.seenKey()] ?? "HEAD";
    const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
    let diff = await exec("git", [...args, this.base, this.now], opts);
    if (diff.code !== 0 && this.base !== "HEAD") { this.base = "HEAD"; diff = await exec("git", [...args, "HEAD", this.now], opts); }
    if (diff.code !== 0) throw new Error(lastLine(diff.stderr));
    this.workFiles = splitFiles(diff.stdout);
    this.show(this.workFiles);
  }

  markSeen(cx) {
    if (!this.now) return;
    const key = this.seenKey(), tree = this.now;
    cx.spawn(async (cx) => {
      try {
        await exec("mkdir", ["-p", STATE_DIR()]);
        const file = `${STATE_DIR()}/seen.json`, before = await readTextFile(file);
        this.seen = { ...JSON.parse(before ?? "{}"), [key]: tree };
        await writeTextFile(file, JSON.stringify(this.seen, null, 1), before);
        this.reload(cx);
      } catch (e) { fail(e); }
    });
  }

  setTab(tab, cx) {
    if (this.tab === tab) return;
    this.tab = tab; this.target = null; this.picked = null; this.cursor = 0; this.opened = new Set();

    this.reload(cx);
  }

  // Working follows the picked Claude: its diff is taken again once it stops working.
  followStatus() {
    if (this.tab !== "working" || !this.claude) return;
    const status = agents().find((a) => a.address === this.claude)?.status ?? null;
    if (this.statusSeen === "working" && status !== "working") this.async.timer.after(0, (cx) => this.reload(cx, true));
    this.statusSeen = status;
  }

  key(e, cx) {
    const k = e.keystroke;
    if (k === "escape") {
      if (this.target) this.closeComposer(cx);
      else if (this.shot) { this.shot = null; cx.notify(); }
      else if (this.picked) { this.picked = null; cx.notify(); }
      return;
    }
    if (!this.h.is_focused()) return;
    const inbox = this.tab === "inbox" && this.item;
    const e0 = this.list[this.cursor];
    switch (k) {
      case "j": case "down": this.moveTo(Math.min(this.cursor + 1, this.list.length - 1), cx, "top"); break;
      case "k": case "up": this.moveTo(Math.max(this.cursor - 1, 0), cx, "top"); break;
      // pressX belongs to the last mouse press, not to this key
      case "enter": if (e0) { this.pressX = null; this.click(String(this.cursor), cx); } break;
      case "c": this.compose(this.cursor, cx); break;
      case "r": if (inbox) this.readAndNext(cx); break;
      case "n": if (inbox) this.nextNote(cx); break;
      case "a": if (inbox) this.approve(cx); break;
      case "s": if (inbox) this.sendNotes(cx); break;
      case "v": this.setState("resolved", cx); break;
      case "x": this.setState("rejected", cx); break;
      case "d": this.dropNote(cx); break;
      default: return;
    }
  }

  // A file's header folds it (read) or opens it; a line opens the composer on it; a note picks it.
  click(key, cx) {
    const i = Number(key), e = this.list[i];
    if (!e) return;
    this.cursor = i;
    if (e.kind === "file") {
      const file = this.files[e.fi];
      const onBox = this.pressX !== null && this.pressX >= this.diffW + SCROLLBAR_W - READ_BOX_W;
      if (this.tab === "inbox" && (!file.read || onBox)) this.toggleRead(e.fi, cx);
      else { if (this.opened.has(e.fi)) this.opened.delete(e.fi); else this.opened.add(e.fi); this.rebuild(); }
      this.h.focus(); cx.notify();
      return;
    }
    if (e.kind === "note") { this.pickNote(e.note.id, cx); return; }
    if (e.kind === "pair") { this.compose(i, cx); return; }
    this.h.focus(); cx.notify();
  }

  button(id, label, onClick, t, tip = null, kind = "plain") {
    const bg = kind === "primary" ? t.solid : kind === "ghost" ? null : t.raised;
    return div().id(id).h(26).px(10).flex().flex_none().items_center().gap(6).rounded(7).text_size(12).cursor_pointer()
      .when(Boolean(bg), (e) => e.bg(bg)).text_color(kind === "primary" ? t.solid_foreground : kind === "ghost" ? t.muted : t.foreground)
      .hover((s) => kind === "ghost" ? s.bg(t.hover).text_color(t.foreground) : s.opacity(0.85))
      .when(Boolean(tip), (e) => e.tooltip(tip)).on_click((_e, cx) => { onClick(cx); })
      .child(label);
  }

  // The repos of the folder's family, each with its uncommitted files, the shown one raised; the same pick as the Changes pane's.
  repoSwitch(t) {
    const { family, changed } = this.family;
    return h_flex().p(2).gap(2).rounded(8).bg(t.raised).children(family.repos.map((repo) => {
      const on = repo === this.root, count = changed[repo] ?? 0;
      return h_flex().id(`repo-${repo}`).h(26).px(10).gap(6).items_center().rounded(6).text_size(12.5).cursor_pointer()
        .when(on, (e) => e.bg(t.background).border_1().border_color(t.border)).text_color(on ? t.foreground : t.muted)
        .tooltip(repo).on_click(() => { if (!on) this.showRepo(repo); })
        .child(repoName(family, repo))
        .when(count > 0, (e) => e.child(div().px(5).rounded(4).bg(t.ansi3 + "26").text_color(t.ansi3).text_size(10.5).child(String(count))));
    }));
  }

  hint(key, t) {
    return div().px(5).h(16).flex().items_center().rounded(4).border_1().border_color(t.border).text_size(10.5).text_color(t.muted).font_family(MONO()).child(key);
  }

  // The rail: what is left to review, loose commits apart, the approved ones folded away.
  rail(t) {
    const items = this.summary?.items ?? [];
    const tickets = items.filter((i) => i.ticket && !i.approved), loose = items.filter((i) => !i.ticket && !i.approved), done = items.filter((i) => i.approved);
    const heading = (label, extra = null) => h_flex().px(12).pt(14).pb(6).items_center().gap(6)
      .child(div().flex_1().text_size(10.5).font_semibold().text_color(t.dim).child(label)).when(Boolean(extra), (e) => e.child(extra));
    const progress = (i) => {
      const ready = i.read === i.files && !i.open;
      return h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().w(44).h(4).flex_none().rounded(2).bg(t.border).child(div().h_full().rounded(2).bg(ready ? t.ansi2 : t.accent).w(i.files ? Math.round(44 * i.read / i.files) : 0)))
        .child(div().child(`${i.read}/${i.files}`))
        .when(i.open > 0, (e) => e.child(div().px(5).rounded(4).bg(t.ansi3 + "26").text_color(t.ansi3).child(`${i.open} open`)))
        .when(ready && !i.approved, (e) => e.child(div().text_color(t.ansi2).child("ready")));
    };
    const row = (i) => {
      const on = i.key === this.itemKey;
      return v_flex().id(`item-${i.key}`).mx(6).px(8).py(7).gap(4).rounded(7).cursor_pointer()
        .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(on ? t.selected : t.hover))
        .on_click((_e, cx) => this.pickItem(i.key, cx))
        .child(h_flex().gap(7).items_baseline().min_w(0)
          .child(div().flex_none().font_family(MONO()).text_size(11.5).text_color(i.approved ? t.ansi2 : t.accent).child(i.ticket ? `#${i.ticket.number}` : short(i.key)))
          .child(div().flex_1().min_w(0).truncate().text_color(i.approved ? t.muted : t.foreground).child(i.ticket ? i.ticket.title : i.subject)))
        .child(h_flex().gap(8).items_center().text_size(11).text_color(t.dim)
          .child(div().flex_none().child(daysLabel(i.ts)))
          .when(i.ticket && i.ticket.screen, (e) => e.child(div().min_w(0).truncate().child(i.ticket.screen)))
          .child(div().flex_1())
          .when(!i.approved, (e) => e.child(progress(i)))
          .when(i.approved, (e) => e.child(div().text_color(t.ansi2).child("✓"))));
    };
    return v_flex().id("rail").w(320).flex_none().h_full().bg(t.chrome).border_r(1).border_color(t.border).overflow_y_scrollbar().pb(12).text_size(12.5)
      .when(!this.summary, (e) => e.child(v_flex().p(14).gap(10).items_start().text_color(t.dim)
        .child(div().child(this.busy ?? (this.error ? "" : `No review inbox for ${this.root ? baseName(this.root) : "this repo"} yet: the commits a Claude makes here land in it.`)))
        .when(!this.busy && Boolean(this.root) && !this.on, (e) => e.child(this.button("file-head", "File HEAD", (cx) => this.fileHead(cx), t, "File the last commit into the inbox, for one made by hand")))))
      .when(Boolean(this.summary), (e) => e
        .child(heading(`TO REVIEW · ${tickets.length}`))
        .when(!tickets.length, (e) => e.child(div().px(14).text_color(t.dim).child("Nothing left to review")))
        .children(tickets.map(row))
        .when(loose.length > 0, (e) => e
          .child(heading(`WITHOUT A TICKET · ${loose.length}`, this.button("file-loose", "File them", (cx) => this.askClaude("file", cx), t, "Ask the Claude to file them under their Tilid tickets", "ghost")))
          .children(loose.map(row)))
        .when(done.length > 0, (e) => e
          .child(h_flex().id("history").mx(6).mt(10).px(8).h(28).items_center().gap(6).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover)).text_size(11.5).text_color(t.dim)
            .on_click((_e, cx) => { this.history = !this.history; cx.notify(); })
            .child(this.history ? "▾" : "▸").child(`Approved · ${done.length}`))
          .when(this.history, (e) => e.children(done.slice().reverse().map(row)))));
  }

  // The item's head: its ticket, prose, commits to filter on, shots and actions.
  header(t) {
    const item = this.item, files = this.files;
    const read = files.filter((f) => f.read).length, open = this.openCount();
    const added = files.reduce((n, f) => n + f.added, 0), removed = files.reduce((n, f) => n + f.removed, 0);
    const chip = (id, label, on, onClick, tip = null) => div().id(id).h(24).px(9).flex().flex_none().items_center().gap(6).rounded(6).text_size(11.5).cursor_pointer().max_w(260)
      .border_1().border_color(on ? t.accent : t.border).when(on, (e) => e.bg(t.accent + "1f")).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).when(Boolean(tip), (e) => e.tooltip(tip)).on_click((_e, cx) => onClick(cx)).child(label);
    const ticket = item.ticket, tilid = item.tilid && ticket ? `https://${item.tilid.instance}.tilid.io/project/${item.tilid.code}?ticket=${ticket.number}` : null;
    const loose = item.notes.filter((n) => !n.path);
    return v_flex().flex_none().px(18).pt(14).pb(10).gap(10).border_b(1).border_color(t.border)
      .child(h_flex().gap(10).items_center().min_w(0)
        .child(div().flex_none().font_family(MONO()).text_size(15).text_color(item.approved ? t.ansi2 : t.accent).child(ticket ? `#${ticket.number}` : short(item.key)))
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(ticket ? ticket.title : item.commits[0]?.subject ?? ""))
        .when(Boolean(ticket?.screen), (e) => e.child(div().flex_none().px(7).h(20).flex().items_center().rounded(5).bg(t.raised).font_family(MONO()).text_size(10.5).text_color(t.muted).child(ticket.screen)))
        .when(Boolean(tilid), (e) => e.child(this.button("tilid", "Tilid ↗", (cx) => cx.open_url(tilid), t, "Open the ticket in Tilid", "ghost"))))
      .child(item.prose
        ? div().text_size(12.5).text_color(t.muted).child(item.prose)
        : h_flex().gap(8).items_center().text_size(12).text_color(t.dim).child("No description yet").child(this.button("describe", "Describe", (cx) => this.askClaude("describe", cx), t, "Ask the Claude to describe what it changes and why", "ghost")))
      .children(loose.map((n) => h_flex().id(`item-note-${n.id}`).gap(8).px(10).py(6).rounded(7).cursor_pointer().bg(this.noteColour(n, t) + "14").border_l_2().border_color(this.noteColour(n, t))
        .on_click((_e, cx) => this.pickNote(n.id, cx))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`${n.author} · ${n.state}`))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(n.body.split("\n")[0]))))
      .when(item.commits.length > 1 || Boolean(this.commit), (e) => e.child(h_flex().gap(6).flex_wrap()
        .child(chip("commit-all", `All ${item.commits.length} commits`, !this.commit, (cx) => this.pickCommit(null, cx), "The ticket's net change, what its commits add up to"))
        .children(item.commits.map((c) => chip(`commit-${c.sha}`, h_flex().gap(6).min_w(0)
          .child(div().flex_none().font_family(MONO()).text_size(11).text_color(t.accent).child(c.sha.slice(0, 7)))
          .child(div().min_w(0).truncate().child(c.subject))
          .when(c.copies.length > 0, (e) => e.child(div().flex_none().text_color(t.dim).child(`↻${c.copies.length}`))),
        this.commit === c.sha, (cx) => this.pickCommit(c.sha, cx), `${c.subject}\n${c.author}, ${daysLabel([c.ts])}${c.copies.length ? `\nreplaces ${plural(c.copies.length, "rebased copy")}` : ""}`)))))
      .when(item.shots.length > 0, (e) => e.child(h_flex().id("shots").gap(8).overflow_x_scrollbar()
        .children(item.shots.map((s) => {
          const at = this.shots.get(s.after ?? s.before);
          return v_flex().id(`shot-${s.id}`).flex_none().w(132).gap(4).cursor_pointer().on_click((_e, cx) => { this.shot = { shot: s, before: false }; cx.notify(); })
            .tooltip(s.error ? `${s.label}\nfailed: ${s.error}` : s.label)
            .child(div().w(132).h(78).rounded(6).overflow_hidden().border_1().border_color(this.shot?.shot.id === s.id ? t.accent : s.error ? t.ansi1 : t.border).bg(t.chrome)
              .flex().items_center().justify_center().when(Boolean(at), (e) => e.child(fitted(at, 130, 76))))
            .child(div().truncate().text_size(11).text_color(s.error ? t.ansi1 : t.muted).child(s.label));
        }))))
      .child(h_flex().gap(6).items_center()
        .child(this.button("approve", item.approved ? "Unapprove" : h_flex().gap(6).items_center().child("Approve").child(div().text_size(10.5).opacity(0.7).child("a")), (cx) => this.approve(cx), t, item.approved ? "Back into the inbox" : "Approve it and go to the next one", item.approved ? "plain" : "primary"))
        .when(Boolean(item.advance) && !item.approved, (e) => e.child(this.button("approve-tilid", "Approve and move in Tilid", (cx) => this.approve(cx, true), t, `Approve, and move the ticket from "${item.advance.from}" to "${item.advance.to}"`)))
        .when(read < files.length, (e) => e.child(this.button("read-all", "Read all", (cx) => this.readAll(cx), t, "Mark every file read")))
        .when(open > 0, (e) => e.child(this.button("send", `Send ${plural(open, "note")}`, (cx) => this.sendNotes(cx), t, "Paste the open notes into the Claude that made these commits (s)")))
        .child(div().w(8))
        .child(this.button("ask-review", "Review", (cx) => this.askClaude("review", cx), t, "Ask the Claude to read it and note what is wrong, risky or unclear", "ghost"))
        .child(this.button("ask-shots", "Screens", (cx) => this.askClaude("shots", cx), t, "Ask the Claude for before and after screenshots of the screens it changes", "ghost"))
        .child(div().flex_1())
        .child(h_flex().gap(8).text_size(11.5).text_color(t.dim)
          .child(div().text_color(t.ansi2).child(`+${added}`)).child(div().text_color(t.ansi1).child(`−${removed}`))
          .child(div().child(`${read}/${plural(files.length, "file")} read`))))
      .when(!item.exact, (e) => e.child(div().text_size(11.5).text_color(t.ansi3).child("Its commits do not apply one onto the other: shown is the touched files from before the first to after the last.")));
  }

  noteColour(n, t) {
    return n.state === "open" ? t.ansi3 : n.state === "resolved" ? t.ansi2 : t.dim;
  }

  // One side of a line: its number, its sign, then its text cut into the pieces its column holds.
  half(side, marks, t, kind, cols) {
    const empty = !side;
    const tint = kind === "-" ? t.ansi1 : kind === "+" ? t.ansi2 : null;
    const cell = h_flex().flex_1().min_w(0).h_full().items_start().overflow_hidden().when(empty, (e) => e.bg(t.chrome)).when(Boolean(tint), (e) => e.bg(tint + "1c"));
    if (empty) return cell;
    const piece = (p, k) => {
      const line = h_flex().h(k ? WRAP_H : ROW_H).items_center().whitespace_nowrap();
      return p.marks
        ? line.child(div().child(p.text.slice(0, p.marks[0]))).child(div().bg(tint + "4d").rounded(2).child(p.text.slice(p.marks[0], p.marks[1]))).child(div().child(p.text.slice(p.marks[1])))
        : line.child(p.text || " ");
    };
    return cell
      .child(div().w(46).h(ROW_H).flex_none().pr(8).flex().items_center().justify_end().text_color(tint ?? t.dim).opacity(tint ? 0.9 : 0.6).child(String(side.line)))
      .child(div().w(12).h(ROW_H).flex_none().flex().items_center().text_color(tint ?? t.dim).child(kind === " " ? "" : kind))
      .child(v_flex().flex_1().min_w(0).text_color(t.foreground).children(wrapLine(side.text, marks, cols).map(piece)));
  }

  row(e, i, t) {
    const on = i === this.cursor, picked = e.kind === "note" && e.note.id === this.picked, target = this.target?.index === i;
    const wrap = h_flex().h(this.heights[i]).flex_none().w_full().items_center().overflow_hidden()
      .child(div().w(3).h_full().flex_none().when(on || target, (x) => x.bg(t.accent)));
    if (e.kind === "file") {
      const f = this.files[e.fi], dir = f.path.slice(0, f.path.lastIndexOf("/") + 1);
      const colour = f.status === "added" ? t.ansi2 : f.status === "deleted" ? t.ansi1 : f.status === "renamed" ? t.ansi5 : t.accent;
      return wrap.bg(t.raised).border_t(1).border_color(t.border).text_size(12.5)
        .child(h_flex().flex_1().min_w(0).px(10).gap(9).items_center()
          .child(div().size(18).flex_none().flex().items_center().justify_center().rounded(4).bg(colour + "26").text_color(colour).text_size(10.5).font_semibold().child(STATUS[f.status] ?? "M"))
          .child(h_flex().flex_1().min_w(0).items_baseline().overflow_hidden().whitespace_nowrap()
            .when(this.tab === "inbox" && Object.keys(this.item?.repos ?? {}).length > 1, (x) => x.child(div().flex_none().text_color(t.dim).child(`${f.repo} · `)))
            .child(div().flex_none().text_color(t.dim).child(dir)).child(div().flex_none().font_semibold().text_color(f.read ? t.muted : t.foreground).child(baseName(f.path)))
            .when(Boolean(f.oldPath) && f.oldPath !== f.path, (x) => x.child(div().pl(8).text_color(t.dim).truncate().child(`from ${f.oldPath}`))))
          .when(e.open > 0, (x) => x.child(div().flex_none().px(6).rounded(4).bg(t.ansi3 + "26").text_color(t.ansi3).text_size(11).child(`${e.open} open`)))
          .child(div().flex_none().text_size(11.5).text_color(t.ansi2).child(f.added ? `+${f.added}` : ""))
          .child(div().flex_none().text_size(11.5).text_color(t.ansi1).child(f.removed ? `−${f.removed}` : ""))
          .when(this.tab === "inbox", (x) => x.child(h_flex().flex_none().gap(5).items_center().pl(6).text_size(11.5).text_color(f.read ? t.ansi2 : t.dim)
            .child(div().size(14).flex().items_center().justify_center().rounded(4).border_1().border_color(f.read ? t.ansi2 : t.border).when(f.read, (y) => y.bg(t.ansi2)).text_size(10).text_color(t.background).child(f.read ? "✓" : ""))
            .child(f.read && this.opened.has(e.fi) ? "Read, open" : "Read"))));
    }
    if (e.kind === "hunk") {
      return wrap.bg(t.chrome).text_color(t.dim).font_family(MONO()).text_size(11.5).child(div().pl(16).truncate().child(`@@ ${e.old} → ${e.next}${e.text ? `   ${e.text}` : ""}`));
    }
    if (e.kind === "meta") return wrap.text_color(t.dim).child(div().pl(16).child(e.text));
    if (e.kind === "note") {
      const n = e.note, colour = this.noteColour(n, t), lines = noteLines(n.body);
      const card = v_flex().flex_1().min_w(0).h_full().my(4).mr(12).px(10).py(5).gap(1).rounded(7).border_l_2().border_color(colour).bg(picked ? t.selected : colour + "14")
        .text_size(12)
        .child(h_flex().gap(8).items_center().h(18).text_size(11).text_color(t.dim)
          .child(div().text_color(n.author === "me" ? t.accent : t.ansi5).child(n.author === "me" ? "you" : "claude"))
          .child(div().text_color(colour).child(n.state))
          .when(e.moved, (x) => x.child(div().child(n.line ? `was on line ${n.line}` : "line gone")))
          .child(div().flex_1())
          .when(picked, (x) => x.child(div().child("v resolve · x reject · d delete"))))
        .children(lines.map((l) => div().h(18).truncate().text_color(n.state === "open" ? t.foreground : t.muted).child(l)));
      const lineless = n.line === null || n.line === undefined, whole = lineless || Boolean(singleSide(this.files[e.fi]));
      return wrap.child(h_flex().flex_1().min_w(0).h_full()
        .when(!whole && n.side === "new", (x) => x.child(div().flex_1().min_w(0)))
        .child(div().w(lineless ? 16 : 58).flex_none())
        .child(card)
        .when(!whole && n.side === "old", (x) => x.child(div().flex_1().min_w(0))));
    }
    const code = wrap.font_family(MONO()).text_size(CODE_SIZE), single = singleSide(this.files[e.fi]);
    if (single === "new") return code.child(this.half(e.right, null, t, e.right?.kind ?? null, this.cols.whole));
    if (single === "old") return code.child(this.half(e.left, null, t, e.left?.kind ?? null, this.cols.whole));
    return code.child(this.half(e.left, e.marks?.left, t, e.left?.kind ?? null, this.cols.half))
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(this.half(e.right, e.marks?.right, t, e.right?.kind ?? null, this.cols.half));
  }

  diff(t) {
    const list = this.list;
    if (this.shot) return this.shotView(t);
    if (!list.length) {
      const empty = this.tab === "working" ? "Nothing changed since you last looked" : !this.summary ? "" : this.item ? "Nothing in this commit" : "Nothing left to review";
      return div().flex_1().p(18).text_color(t.dim).child(this.busy ?? empty);
    }
    return div().id("diff-room").flex_1().min_h(0).relative()
      // lines wrap to the room the diff has, so each row's height follows its width
      .on_size_change((size, cx) => {
        const w = size.width / (Number(settings().zoom) || 1) - SCROLLBAR_W;
        if (Math.abs(w - this.diffW) <= 1) return;
        this.diffW = w; this.cols = columnsOf(w);
        this.heights = this.list.map((e) => heightOf(e, this.cols, this.files));
        cx.notify();
      })
      .on_mouse_down("left", (ev) => { this.pressX = ev.local_position ? ev.local_position.x / (Number(settings().zoom) || 1) : null; })
      .child(v_virtual_list(`diff-${this.tab}`, list.length, this.heights, String, (range) => list.slice(range.start, range.end).map((e, k) => this.row(e, range.start + k, t)))
        .size_full().track_scroll(this.scroll).on_item_click((key, cx) => this.click(key, cx)))
      .child(Scrollbar.vertical(`diff-${this.tab}`).viewport_from_layout().absolute().inset_0());
  }

  // A shot full size, after by default; hovering it shows before.
  shotView(t) {
    const { shot, before } = this.shot, path = this.shots.get(before ? shot.before : shot.after ?? shot.before);
    const side = (label, on, has) => div().id(`shot-${label}`).h(24).px(10).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .when(on, (e) => e.bg(t.raised)).text_color(has ? (on ? t.foreground : t.muted) : t.dim)
      .when(has, (e) => e.on_click((_e, cx) => { this.shot = { shot, before: label === "Before" }; cx.notify(); })).child(label);
    return v_flex().flex_1().min_h(0).p(14).gap(10)
      .child(h_flex().gap(6).items_center()
        .child(side("Before", before, Boolean(shot.before))).child(side("After", !before, Boolean(shot.after)))
        .child(div().pl(8).flex_1().min_w(0).truncate().text_color(t.muted).child(`${shot.label}${shot.route ? `  ${shot.route}` : ""}`))
        .child(this.button("shot-close", "Close", (cx) => { this.shot = null; cx.notify(); }, t, "Back to the diff (esc)", "ghost")))
      .child(div().id("shot-full").flex_1().min_h(0).flex().items_center().justify_center().rounded(8).overflow_hidden().border_1().border_color(t.border).bg(t.chrome)
        .on_size_change((size, cx) => {
          const zoom = Number(settings().zoom) || 1, w = size.width / zoom - 2, h = size.height / zoom - 2;
          if (Math.abs(w - this.shotRoom.w) > 1 || Math.abs(h - this.shotRoom.h) > 1) { this.shotRoom = { w, h }; cx.notify(); }
        })
        .when(Boolean(shot.before && shot.after), (e) => e.on_hover((hovered, cx) => { this.shot = { shot, before: hovered }; cx.notify(); }))
        .when(Boolean(path) && this.shotRoom.w > 0, (e) => e.child(fitted(path, this.shotRoom.w, this.shotRoom.h))));
  }

  // Under the diff: the composer on the picked line, or the picked note in full with its states.
  panel(t) {
    const target = this.target, note = this.note();
    const bar = v_flex().flex_none().px(14).py(10).gap(8).border_t(1).border_color(t.border).bg(t.chrome);
    if (note && !target) {
      return bar.child(h_flex().gap(8).items_center().text_size(11.5).text_color(t.dim)
        .child(div().text_color(note.author === "me" ? t.accent : t.ansi5).child(note.author === "me" ? "you" : "claude"))
        .child(div().text_color(this.noteColour(note, t)).child(note.state))
        .child(div().flex_1().min_w(0).truncate().font_family(MONO()).child(`${note.path || "the whole item"}${note.line ? `:${note.line}${note.side === "old" ? " (old side)" : ""}` : ""}`))
        .when(note.state !== "resolved", (e) => e.child(this.button("note-resolve", h_flex().gap(6).child("Resolve").child(this.hint("v", t)), (cx) => this.setState("resolved", cx), t, "It is handled")))
        .when(note.state !== "rejected", (e) => e.child(this.button("note-reject", h_flex().gap(6).child("Reject").child(this.hint("x", t)), (cx) => this.setState("rejected", cx), t, "It needs no change")))
        .when(note.state !== "open", (e) => e.child(this.button("note-reopen", "Reopen", (cx) => this.setState("open", cx), t)))
        .child(this.button("note-drop", h_flex().gap(6).child("Delete").child(this.hint("d", t)), (cx) => this.dropNote(cx), t, "Remove the note"))
        .child(this.button("note-close", "Close", (cx) => { this.picked = null; cx.notify(); }, t, null, "ghost")))
        .child(div().id("note-body").max_h(180).overflow_y_scrollbar().text_size(12.5).child(TextView.markdown(`note-${note.id}`, note.body)));
    }
    if (!target) return null;
    const where = `${target.path}${target.at ? `:${target.at.line}${target.at.side === "old" ? " (old side)" : ""}` : ", whole file"}`;
    const ready = Boolean(this.text.trim()), working = this.tab === "working";
    const row = this.list[target.index];
    const sides = row?.kind === "pair" && row.left && row.right && row.left.kind !== " ";
    return bar.child(h_flex().gap(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).font_family(MONO()).child(working ? `For the Claude, on ${where}` : `Note on ${where}`))
      .when(sides, (e) => e.child(h_flex().gap(2).children(["old", "new"].map((s) => div().id(`side-${s}`).h(20).px(7).flex().items_center().rounded(5).text_size(11).cursor_pointer()
        .when(target.at?.side === s, (x) => x.bg(t.raised)).text_color(target.at?.side === s ? t.foreground : t.dim)
        .on_click((_e, cx) => this.compose(target.index, cx, s)).child(s === "old" ? "Old line" : "New line"))))))
      .child(h_flex().gap(8).items_center()
        .child(div().id("comment").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(t.accent).bg(t.input).cursor_text()
          .child(Input.new(this.input).h_full().text_size(12.5).text_color(t.foreground)))
        .when(working, (e) => e
          .child(this.button("paste", "Paste", (cx) => this.submit(cx), t, "Paste into the Claude's prompt, unsent", ready ? "primary" : "plain"))
          .child(this.button("send-now", "Send", (cx) => this.submit(cx, true), t, "Send it to the Claude now")))
        .when(!working, (e) => e.child(this.button("add-note", "Add note", (cx) => this.submit(cx), t, "Enter", ready ? "primary" : "plain")))
        .child(this.button("cancel", "Cancel", (cx) => this.closeComposer(cx), t, "esc", "ghost")));
  }

  working(t) {
    return v_flex().flex_1().min_w(0).min_h(0)
      .child(h_flex().flex_none().h(40).px(14).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(this.base === "HEAD" ? "Since HEAD: nothing marked seen yet" : `Since you last looked (${short(this.base)})`))
        .child(div().text_color(t.dim).child(plural(this.workFiles.length, "file")))
        .child(this.button("refresh", "Refresh", (cx) => this.reload(cx), t))
        .child(this.button("seen", "Mark seen", (cx) => this.markSeen(cx), t, "What shows now stops showing until it changes again", "primary")))
      .child(this.diff(t));
  }

  inbox(t) {
    return h_flex().flex_1().min_h(0)
      .child(this.rail(t))
      .child(v_flex().flex_1().min_w(0).h_full()
        .when(Boolean(this.item), (e) => e.child(this.header(t)))
        .child(this.diff(t)));
  }

  render(_cx) {
    if (!this.view) return div();
    this.space ??= spaces().find((s) => s.active)?.id ?? null;
    const request = shared(REQUEST);
    if (request?.at > this.requested && (!request.space || request.space === this.space)) {
      this.ask(request);
      this.async.timer.after(0, (cx) => { this.h.focus(); this.reload(cx); });
    }
    if (shared(PICKS) !== this.picksSeen) {
      this.picksSeen = shared(PICKS);
      this.async.timer.after(0, (cx) => this.reload(cx));
    }
    this.followStatus();
    const t = theme(), list = this.claudes();
    const tab = (id, label) => div().id(`tab-${id}`).h(26).px(12).flex().items_center().rounded(6).text_size(12.5).cursor_pointer()
      .when(this.tab === id, (e) => e.bg(t.background).border_1().border_color(t.border)).text_color(this.tab === id ? t.foreground : t.muted)
      .on_click((_e, cx) => this.setTab(id, cx)).child(label);
    const dot = (status) => div().size(7).flex_none().rounded(4).bg(status === "working" ? t.ansi3 : status === "blocked" ? t.ansi1 : status === "done" ? t.ansi2 : t.dim);
    const panel = this.panel(t);
    const open = this.summary?.items.reduce((n, i) => n + (i.approved ? 0 : i.open), 0) ?? 0;
    return v_flex().id("review").size_full().bg(t.background).text_color(t.foreground).text_size(12.5)
      .track_focus(this.h).on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().flex_none().h(44).px(12).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(h_flex().p(2).gap(2).rounded(8).bg(t.raised).child(tab("inbox", "Inbox")).child(tab("working", "Working")))
        .when(Boolean(this.family), (e) => e.child(this.repoSwitch(t)))
        .when(this.tab === "inbox" && Boolean(this.project), (e) => e.child(div().pl(4).font_semibold().child(this.project)))
        .child(div().w(10))
        .children(list.map((a) => h_flex().id(`agent-${a.address}`).h(26).px(8).gap(6).items_center().rounded(7).cursor_pointer().max_w(220)
          .when(a.address === this.claude, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).tooltip(a.cwd ?? a.title)
          .on_click((_e, cx) => { this.claude = a.address; this.statusSeen = null; this.from = null; this.reload(cx); })
          .child(dot(a.status)).child(div().min_w(0).truncate().text_size(12).child(a.title || a.tab_name))))
        .when(!list.length, (e) => e.child(div().text_size(12).text_color(t.dim).child("No Claude in this space")))
        .child(div().flex_1())
        .when(this.tab === "inbox" && open > 0, (e) => e.child(this.button("send-all", `Send all ${plural(open, "open note")}`, (cx) => this.sendNotes(cx, true), t, "Paste every item's open notes into the picked Claude")))
        .when(Boolean(this.busy), (e) => e.child(div().text_size(11.5).text_color(t.dim).child(this.busy))))
      .when(Boolean(this.error), (e) => e.child(div().flex_none().px(14).py(6).text_size(12).text_color(t.ansi1).bg(t.ansi1 + "14").child(this.error)))
      .child(this.tab === "working" ? this.working(t) : this.inbox(t))
      .when(Boolean(panel), (e) => e.child(panel))
      .child(h_flex().flex_none().h(26).px(14).gap(14).items_center().border_t(1).border_color(t.border).bg(t.chrome).text_size(11).text_color(t.dim)
        .children((this.tab === "inbox" ? KEYS : KEYS.filter(([k]) => ["c", "j k", "enter", "esc"].includes(k))).map(([k, label]) => h_flex().gap(5).items_center().child(this.hint(k, t)).child(label)))
        .child(div().flex_1())
        .child(div().truncate().max_w(320).child(tildePath(this.root ?? "", home()))));
  }
}
