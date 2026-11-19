// The Review tab of a space (Ctrl+Shift+R, or a commit's ticket from Changes). Inbox: the project's tickets and loose commits still to review, each one's net diff side by side with its notes under their lines, read file by file, approved, its notes handed back to a Claude. Working: what a Claude changed since you last looked, a line's comment pasted into it.
// The layout's copy only listens for review.open and review.request (Changes' ask, its props in shared REQUEST); the view is a tab whose only pane is this mod, reused while the space has one.
// Keys, while the tab has the keyboard: r read and next (unread again on a read file), n next open note, c comment, a approve, s send the notes, j/k move, J/K next and previous file, ] and [ next and previous item, p the screens, enter open (on a hunk, the next one of the requirement picked in the header), v/x/d resolve, reject, delete the picked note; in the screens, ←/→ (h/l) move, b flips before and after, m side by side.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle, ScrollHandle, TextView } from "gpui-base";
import { agents, panes, spaces, focused, exec, hc, home, appHome, readTextFile, writeTextFile, watchFolder, theme, settings, props, shared, setShared, closeOverlay, nextCommand, run, notify } from "herdr";
import { briefTargets, buildList, heightOf, columnsOf, wrapLine, singleSide, ROW_H, WRAP_H, CODE_SIZE, LIST_MAX, nextUnread, nextOpenNote, noteLines, splitFiles, daysLabel, commentText, SNAPSHOT, claudeFor, PROMPTS, tildePath, fileJump, railGroups, railOrder, traceMap, viewOf } from "./model.js";
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
const READ_BOX_W = 106;
const MONO = () => settings().font_family ?? "JetBrains Mono";
const STATUS = { added: "A", deleted: "D", renamed: "R", modified: "M" };
// Lucide icons, tinted by the text colour around them
const icon = (name, size) => svg(`mods/review/${name}.svg`).size(size).flex_none();

const lastLine = (text) => text.trim().split("\n").filter(Boolean).at(-1) ?? "";
const messageOf = (e) => e instanceof Error ? e.message : String(e);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);
const short = (sha) => sha.slice(0, 8);
const branchOf = (featureKey) => featureKey.slice(featureKey.indexOf(":") + 1);
const fail = (e) => notify({ title: "Review", body: messageOf(e), level: "error" });
const statusColour = (f, t) => f.status === "added" ? t.ansi2 : f.status === "deleted" ? t.ansi1 : f.status === "renamed" ? t.ansi5 : t.accent;
const PNG_SIZE = /(\d+) x (\d+)/;
const TICKET_PREFIX = /^#\d+ - /;

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
    this.scroll = VirtualListScrollHandle.new(); this.railScroll = ScrollHandle.new(); this.revealRail = false; this.railAt = -1;
    this.tab = "inbox";
    this.root = null; this.from = null; this.on = null; this.error = null; this.busy = null;
    this.families = new Map(); this.family = null; this.picksSeen = shared(PICKS);
    // Inbox
    this.project = null; this.summary = null; this.itemKey = null; this.commit = null; this.item = null;
    this.watching = null; this.loading = false; this.again = false; this.pending = 0; this.edits = 0; this.history = false; this.shots = new Map(); this.shot = null; this.shotRoom = { w: 0, h: 0 };
    // Working
    this.seen = {}; this.now = null; this.base = "HEAD"; this.statusSeen = null; this.workFiles = [];
    // The diff shown
    this.files = []; this.notes = []; this.list = []; this.headers = []; this.heights = []; this.opened = new Set(); this.groupOpen = false; this.cursor = 0;
    // the item's requirements on its hunks, and the one picked with the hunk it is on (`k` a requirement's index, or "outside")
    this.traced = traceMap([], []); this.reqPick = null;
    // top: the first row the list drew, whose file the diff names above it
    this.top = 0;
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

  // Takes an open request: its tab, repo, item and commit, the screen to open it on, and the Claude it came from, else the space's first.
  ask(p) {
    this.requested = p.at ?? 0;
    this.wantShot = Number.isInteger(p.shot) ? p.shot : null;
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
      this.summary = null; this.project = null; this.item = null; this.wantShot = null; this.show([]);
      return;
    }
    const items = summary.items, project = summary.project;
    const wanted = this.wanted && items.find((i) => i.commits.some((c) => c.sha.startsWith(this.wanted)));
    const key = wanted?.key ?? items.find((i) => i.key === this.itemKey || i.ticket && `#${i.ticket.number}` === this.itemKey)?.key ?? railOrder(items, false)[0]?.key ?? null;
    const item = key ? await cli("show", project, key, ...(this.commit ? ["--commit", this.commit] : [])) : null;
    if (stale()) return;
    this.wanted = null;
    this.summary = summary;
    if (project !== this.project) { this.project = project; this.watch(cx); }
    this.showItem(key, item);
    await this.copyShots();
    if (stale()) return;
    if (this.wantShot !== null && item?.shots.length) this.shot = { id: item.shots[Math.min(this.wantShot, item.shots.length - 1)].id, mode: "pair", before: false, region: null };
    this.wantShot = null;
    // a screen taken again or dropped while it showed
    if (this.shot && !item?.shots.some((s) => s.id === this.shot.id)) this.shot = null;
  }

  showItem(key, item) {
    const same = key && key === this.item?.key;
    if (!same) { this.opened = new Set(); this.groupOpen = false; this.reqPick = null; this.cursor = 0; this.target = null; this.picked = null; this.shot = null; this.revealRail = true; }
    this.itemKey = key;
    this.item = item;
    if (!item) { this.show([]); return; }
    if (item.commit === null) this.commit = null;
    this.show(item.files, item.notes.filter((n) => n.path), item.trace ?? []);
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

  show(files, notes = [], trace = []) {
    this.files = files;
    this.notes = notes;
    this.traced = traceMap(files, trace);
    this.big = false;
    this.rebuild();
  }

  rebuild() {
    // too long for the list whole, the item shows its files one at a time till the next item: the one moved to opens
    if (!this.big) {
      this.list = buildList(this.files, this.notes, this.opened, this.groupOpen);
      this.big = this.list.length > LIST_MAX;
    }
    if (this.big) this.list = buildList(this.files, this.notes, this.opened, this.groupOpen, true).slice(0, LIST_MAX);
    // each file's header row, or the mechanical group's while it is folded: the rail asks for every file's on each draw
    this.headers = [];
    this.list.forEach((e, i) => {
      if (e.kind === "file") this.headers[e.fi] = i;
      else if (e.kind === "group") for (let fi = e.from; fi < e.to; fi++) this.headers[fi] ??= i;
    });
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

  // A mechanical file's header, or the group row while it is folded.
  headerOf(fi) {
    return this.headers[fi] ?? -1;
  }

  toggleGroup(cx) {
    this.groupOpen = !this.groupOpen;
    this.rebuild();
    this.moveTo(this.list.findIndex((e) => e.kind === "group"), cx, "top");
  }

  // r on the mechanical group: its files read at once, written in one go.
  readGroup(e, cx) {
    const files = this.files.slice(e.from, e.to).filter((f) => !f.read);
    if (!files.length) return;
    for (const f of files) { f.read = true; }
    this.rebuild(); this.tally(); cx.notify();
    const key = this.item.key;
    this.write(() => cli("read", this.project, key, ...files.map((f) => `${f.repo}:${f.path}`)), cx);
  }

  // In an item shown a file at a time, the file moved to is the one open.
  focusFile(fi) {
    if (!this.big || this.opened.has(fi)) return;
    this.opened = new Set([fi]);
    this.rebuild();
  }

  hunksOf(k) {
    return k === "outside" ? this.traced.outside : this.traced.reqs[k]?.hunks ?? [];
  }

  // A requirement of the header, or the hunks outside the ticket: picked on its first hunk, then on the next one each time again.
  pickReq(k, cx) {
    const hunks = this.hunksOf(k);
    if (!hunks.length) return;
    const n = this.reqPick?.k === k ? (this.reqPick.n + 1) % hunks.length : 0;
    this.reqPick = { k, n }; this.shot = null; this.h.focus();
    const { fi, ri } = hunks[n], file = this.files[fi];
    if (file.mechanical) this.groupOpen = true;
    if (this.big) this.opened = new Set([fi]);
    else if (file.read) this.opened.add(fi);
    this.rebuild();
    this.moveTo(this.list.findIndex((e) => e.fi === fi && e.ri === ri), cx, "top", true);
  }

  // A click or enter on a hunk picks there what it does; on a hunk of the picked requirement, it goes on to its next one.
  stepHunk(e, cx) {
    const here = (h) => h.fi === e.fi && h.ri === e.ri;
    const ks = [...this.traced.tags.get(`${e.fi}:${e.ri}`) ?? [], ...this.traced.outside.some(here) ? ["outside"] : []];
    if (!ks.length) return;
    const k = ks.includes(this.reqPick?.k) ? this.reqPick.k : ks[0], again = this.reqPick?.k === k;
    this.reqPick = { k, n: this.hunksOf(k).findIndex(here) };
    if (again) this.pickReq(k, cx);
    else cx.notify();
  }

  // Going up, a line is brought in two rows below the top, where the file name kept above the diff does not hide it.
  moveTo(i, cx, where = "center", up = false) {
    if (i < 0 || i >= this.list.length) return;
    this.cursor = i;
    const e = this.list[i];
    this.scroll.scroll_to_item(up && e.kind !== "file" ? Math.max(this.headerOf(e.fi), i - 2) : i, where);
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
    const at = this.list[this.cursor];
    if (at?.kind === "group") { this.readGroup(at, cx); return; }
    const fi = at?.fi ?? nextUnread(this.files, -1);
    if (fi < 0 || !this.files[fi]) return;
    if (this.files[fi].read) { this.toggleRead(fi, cx, false); return; }
    this.toggleRead(fi, cx, true);
    const next = nextUnread(this.files, fi);
    if (next < 0) { this.moveTo(this.headerOf(fi), cx); notify({ title: "Review", body: this.openCount() ? "Every file read: n goes through the open notes" : "Every file read: a approves", level: "success", timeout: 2500 }); return; }
    this.focusFile(next);
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

  jumpFile(step, cx) {
    const to = fileJump(this.list, this.cursor, step, this.files.length);
    if (to < 0) return;
    this.focusFile(to);
    this.moveTo(this.headerOf(to), cx, "top");
  }

  // The approved items show while asked for, or while one of them is shown.
  historyShown() {
    return this.history || Boolean(this.summary?.items.some((i) => i.approved && i.key === this.itemKey));
  }

  // ] and [: the next and previous item of the rail.
  jumpItem(step, cx) {
    const order = railOrder(this.summary?.items ?? [], this.historyShown());
    const next = order[order.findIndex((i) => i.key === this.itemKey) + step];
    if (next) this.pickItem(next.key, cx);
  }

  // a: the item is approved and the next one still to review comes up.
  approve(cx, tilid = false) {
    const item = this.item;
    if (!item) return;
    const undo = item.approved;
    // past a feature's own tickets, which its approval approves
    const order = railOrder(this.summary.items, false), gone = new Set([item.key, ...item.feature?.tickets.map((t) => t.key) ?? []]);
    const after = order.slice(order.findIndex((i) => i.key === item.key) + 1).find((i) => !gone.has(i.key));
    item.approved = !undo; this.tally(); cx.notify();
    this.write(async () => {
      await cli("approve", this.project, item.key, ...(undo ? ["--undo"] : []));
      if (!undo && after) { this.itemKey = after.key; this.commit = null; }
      if (!tilid) return;
      // Tilid moves ticket by ticket, a feature's each in turn, one that fails leaving the others to move
      for (const key of item.feature ? item.feature.tickets.map((t) => t.key) : [item.key]) {
        try {
          const moved = await cli("advance", this.project, key);
          notify({ title: "Review", body: moved.moved ? `#${moved.number} is now "${moved.status}" in Tilid` : `#${moved.number} stays where it is in Tilid: ${moved.skipped}`, level: moved.moved ? "success" : "warning" });
        }
        catch (e) { notify({ title: "Review", body: `${key} did not move in Tilid: ${e.message ?? e}`, level: "error" }); }
      }
    }, cx);
  }

  // Opens the composer on a row: a line on its new side (else its old one), or a whole file from its header.
  compose(i, cx, side = null) {
    const e = this.list[i], file = this.fileAt(i);
    if (!e || !file || e.kind === "group") return;
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
  // restore: put the clipboard back after the paste, off when several pastes in a row restore it once
  async deliver(text, send, cx, to = this.claude, restore = true) {
    if (!to) { notify({ title: "Review", body: "No Claude in this space to hand it to", level: "warning" }); return false; }
    if (send) {
      const r = await hc(["send", to, text]);
      if (r.code !== 0) { notify({ title: "Review", body: lastLine(r.stderr || r.stdout), level: "error" }); return false; }
      return true;
    }
    run("agent.focus", { terminal: to });
    const held = restore ? cx.read_from_clipboard() : undefined;
    cx.write_to_clipboard(text);
    run("terminal.paste");
    if (held !== undefined) cx.timer.after(RESTORE_CLIPBOARD_MS, (cx) => cx.write_to_clipboard(held));
    return true;
  }

  // The item's work goes to the Claude that made its latest commit while it still runs, else the picked one.
  handTo() {
    return claudeFor(this.item?.commits ?? [], agents().map((a) => a.address), this.claude);
  }

  // s: the open notes, as a brief for the Claude to fix them and mark them resolved; a feature's go to each ticket's own Claude.
  sendNotes(cx, all = false) {
    if (!this.project) return;
    if (!all && !this.openCount()) { notify({ title: "Review", body: "No open note to send", level: "info", timeout: 2000 }); return; }
    const targets = all ? new Map([[this.claude, []]]) : this.item.feature ? this.featureTargets() : new Map([[this.handTo(), [this.item.key]]]);
    cx.spawn(async (cx) => {
      const held = targets.size > 1 ? cx.read_from_clipboard() : undefined;
      try {
        for (const [to, keys] of targets) await this.deliver(await cli("brief", this.project, ...keys), false, cx, to, targets.size === 1);
      }
      catch (e) { fail(e); }
      if (held !== undefined) cx.timer.after(RESTORE_CLIPBOARD_MS, (cx) => cx.write_to_clipboard(held));
    });
  }

  // The feature's tickets holding open notes, by the Claude that made each.
  featureTargets() {
    const keys = [...new Set(this.notes.filter((n) => n.state === "open").map((n) => n.item))];
    const shasOf = (key) => new Set(this.summary?.items.find((i) => i.key === key)?.commits.map((c) => c.sha) ?? []);
    return briefTargets(keys, (key) => this.item.commits.filter((c) => shasOf(key).has(c.sha)), agents().map((a) => a.address), this.claude);
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
    this.tab = tab; this.target = null; this.picked = null; this.shot = null; this.cursor = 0; this.opened = new Set(); this.groupOpen = false; this.reqPick = null;

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
      else if (this.reqPick) { this.reqPick = null; cx.notify(); }
      return;
    }
    if (!this.h.is_focused()) return;
    const inbox = this.tab === "inbox" && this.item;
    const e0 = this.list[this.cursor];
    // brackets by the character typed, as AZERTY reaches them through AltGr
    if (inbox && (e.key_char === "]" || e.key_char === "[")) { this.jumpItem(e.key_char === "]" ? 1 : -1, cx); return; }
    if (this.shot) { this.shotKey(k, cx); return; }
    switch (k) {
      case "j": case "down": this.moveTo(Math.min(this.cursor + 1, this.list.length - 1), cx, "top"); break;
      case "k": case "up": this.moveTo(Math.max(this.cursor - 1, 0), cx, "top", true); break;
      case "shift-j": case "J": this.jumpFile(1, cx); break;
      case "shift-k": case "K": this.jumpFile(-1, cx); break;
      case "p": if (inbox) this.openShot(0, cx); break;
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
    if (e.kind === "group") {
      this.h.focus();
      if (this.pressX !== null && this.pressX >= this.diffW + SCROLLBAR_W - READ_BOX_W) this.readGroup(e, cx);
      else this.toggleGroup(cx);
      return;
    }
    if (e.kind === "file") {
      const file = this.files[e.fi];
      const onBox = this.pressX !== null && this.pressX >= this.diffW + SCROLLBAR_W - READ_BOX_W;
      const folded = this.big && !this.opened.has(e.fi);
      if (this.tab === "inbox" && ((!file.read && !folded) || onBox)) this.toggleRead(e.fi, cx);
      else if (folded) this.focusFile(e.fi);
      else { if (this.opened.has(e.fi)) this.opened.delete(e.fi); else this.opened.add(e.fi); this.rebuild(); }
      this.h.focus(); cx.notify();
      return;
    }
    if (e.kind === "note") { this.pickNote(e.note.id, cx); return; }
    if (e.kind === "pair") { this.compose(i, cx); return; }
    this.h.focus(); cx.notify();
    if (e.kind === "hunk") this.stepHunk(e, cx);
  }

  button(id, label, onClick, t, tip = null, kind = "plain") {
    const bg = kind === "primary" ? t.solid : kind === "ghost" ? null : t.raised;
    return div().id(id).h(30).px(12).flex().flex_none().items_center().gap(6).rounded(8).text_size(12.5).cursor_pointer()
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
      return h_flex().id(`repo-${repo}`).h(28).px(12).gap(6).items_center().rounded(6).text_size(12.5).cursor_pointer()
        .when(on, (e) => e.bg(t.background).border_1().border_color(t.border)).text_color(on ? t.foreground : t.muted)
        .tooltip(repo).on_click(() => { if (!on) this.showRepo(repo); })
        .child(repoName(family, repo))
        .when(count > 0, (e) => e.child(div().px(5).rounded(4).bg(t.ansi3 + "26").text_color(t.ansi3).text_size(10.5).child(String(count))));
    }));
  }

  // A read box: an empty frame, or filled green with a check.
  tick(on, size, t) {
    return div().size(size).flex_none().flex().items_center().justify_center().rounded(size > 12 ? 4 : 3).border_1().border_color(on ? t.ansi2 : t.border)
      .when(on, (e) => e.bg(t.ansi2).text_color(t.background).child(icon("check", size - 4)));
  }

  hint(key, t) {
    return div().px(6).h(18).flex().items_center().rounded(5).border_1().border_color(t.border).text_size(10.5).text_color(t.muted).font_family(MONO()).child(key);
  }

  // The rail: what is left to review, loose commits apart, the approved ones folded away.
  rail(t) {
    const { tickets, loose, done } = railGroups(this.summary?.items ?? []);
    // an approved item shown (from Changes, or ] past the last one) unfolds the history, so its row and files show
    const history = this.historyShown();
    const heading = (label, count, extra = null) => h_flex().px(20).pt(20).pb(8).items_center().gap(6).text_size(11.5)
      .child(div().font_semibold().text_color(t.muted).child(label)).child(div().flex_1().text_color(t.dim).child(String(count))).when(Boolean(extra), (e) => e.child(extra));
    const progress = (i) => {
      const ready = i.read === i.files && !i.open;
      return h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().w(48).h(4).flex_none().rounded(2).bg(t.border).child(div().h_full().rounded(2).bg(ready ? t.ansi2 : t.accent).w(i.files ? Math.round(48 * i.read / i.files) : 0)))
        .child(div().child(`${i.read}/${i.files}`))
        .when(i.open > 0, (e) => e.child(div().px(5).rounded(4).bg(t.ansi3 + "26").text_color(t.ansi3).child(`${i.open} open`)))
        .when(ready && !i.approved, (e) => e.child(div().text_color(t.ansi2).child("ready")));
    };
    const row = (i) => {
      const on = i.key === this.itemKey;
      const feature = i.tickets?.length > 0;
      // a feature's tickets sit indented under its row
      return v_flex().id(`item-${i.key}`).ml(i.feature && !i.approved ? 28 : 8).mr(8).px(12).py(10).gap(6).rounded(8).cursor_pointer()
        .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(on ? t.selected : t.hover))
        .on_click((_e, cx) => this.pickItem(i.key, cx))
        .child(h_flex().gap(7).items_baseline().min_w(0)
          .child(div().flex_none().font_family(MONO()).text_size(11.5).text_color(i.approved ? t.ansi2 : t.accent).child(feature ? "feature" : i.ticket ? `#${i.ticket.number}` : short(i.key)))
          .child(div().flex_1().min_w(0).truncate().text_color(i.approved ? t.muted : t.foreground).when(feature, (e) => e.font_semibold()).child(feature ? branchOf(i.key) : i.ticket ? i.ticket.title : i.subject)))
        .child(h_flex().gap(8).items_center().text_size(11).text_color(t.dim)
          .child(div().flex_none().child(daysLabel(i.ts)))
          .when(feature, (e) => e.child(div().flex_none().child(plural(i.tickets.length, "ticket"))))
          .when(i.ticket && i.ticket.screen, (e) => e.child(div().min_w(0).truncate().child(i.ticket.screen)))
          .child(div().flex_1())
          .when(!i.approved, (e) => e.child(progress(i)))
          .when(i.approved, (e) => e.child(div().text_color(t.ansi2).child(icon("check", 13)))));
    };
    // The shown item lists its files under its row, each a jump to its place in the diff.
    // a feature's come after its last ticket, its tickets sitting right under its row
    const withFiles = (i) => {
      const lastOf = (feature) => this.summary.items.find((f) => f.key === feature)?.tickets.at(-1);
      const shown = this.item?.key === this.itemKey && this.files.length > 0
        && ((i.key === this.itemKey && !i.tickets?.length) || (i.feature === this.itemKey && lastOf(i.feature) === i.key));
      if (!shown) return [row(i)];
      const here = this.list[this.cursor]?.fi;
      const mechanical = this.files.findIndex((f) => f.mechanical);
      return [row(i), v_flex().mx(8).pt(4).pb(8).children(this.files.flatMap((f, fi) => {
        const open = this.list[this.headerOf(fi)]?.kind === "file" ? this.list[this.headerOf(fi)].open : 0;
        const label = fi === mechanical ? [div().pl(20).pt(8).pb(2).text_size(11.5).text_color(t.dim).child("Mechanical")] : [];
        return [...label, h_flex().id(`rail-file-${fi}`).h(28).pl(20).pr(12).gap(8).items_center().rounded(6).cursor_pointer().text_size(12)
          .when(here === fi, (e) => e.bg(t.hover)).hover((s) => s.bg(t.hover)).tooltip(f.repo ? `${f.repo} · ${f.path}` : f.path)
          .on_click((_e, cx) => {
            this.shot = null; this.h.focus();
            if (f.mechanical && !this.groupOpen) { this.groupOpen = true; this.rebuild(); }
            this.focusFile(fi);
            this.moveTo(this.headerOf(fi), cx, "top");
          })
          .child(this.tick(f.read, 12, t))
          .child(div().w(10).flex_none().text_size(10).font_semibold().text_color(statusColour(f, t)).child(STATUS[f.status] ?? "M"))
          .child(div().flex_1().min_w(0).truncate().text_color(f.read ? t.dim : here === fi ? t.foreground : t.muted).child(baseName(f.path)))
          .when(open > 0, (e) => e.child(div().flex_none().px(4).rounded(4).bg(t.ansi3 + "26").text_color(t.ansi3).text_size(10.5).child(String(open))))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`+${f.added} −${f.removed}`))];
      }))];
    };
    // One child per row, so the shown item's place is known and a newly shown one is scrolled into view
    const kids = [];
    const rows = (list) => { for (const i of list) { if (i.key === this.itemKey) this.railAt = kids.length; kids.push(v_flex().children(withFiles(i))); } };
    this.railAt = -1;
    if (!this.summary) {
      kids.push(v_flex().p(20).gap(12).items_start().text_color(t.dim)
        .child(div().child(this.busy ?? (this.error ? "" : `No review inbox for ${this.root ? baseName(this.root) : "this repo"} yet: the commits a Claude makes here land in it.`)))
        .when(!this.busy && Boolean(this.root) && !this.on, (e) => e.child(this.button("file-head", "File HEAD", (cx) => this.fileHead(cx), t, "File the last commit into the inbox, for one made by hand"))));
    }
    else {
      kids.push(heading("To review", tickets.length));
      if (!tickets.length) kids.push(div().px(14).text_color(t.dim).child("Nothing left to review"));
      rows(tickets);
      if (loose.length) {
        kids.push(heading("Without a ticket", loose.length, this.button("file-loose", "File them", (cx) => this.askClaude("file", cx), t, "Ask the Claude to file them under their Tilid tickets", "ghost")));
        rows(loose);
      }
      if (done.length) {
        kids.push(h_flex().id("history").mx(8).mt(12).px(12).h(32).items_center().gap(6).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover)).text_size(11.5).text_color(t.dim)
          .on_click((_e, cx) => { this.history = !this.history; cx.notify(); })
          .child(icon(history ? "chevron-down" : "chevron-right", 13)).child("Approved").child(div().text_color(t.dim).child(String(done.length))));
        if (history) rows(done);
      }
    }
    if (this.revealRail && this.railAt >= 0) { this.revealRail = false; this.railScroll.scroll_to_item(this.railAt); }
    return v_flex().id("rail").w(360).flex_none().h_full().bg(t.chrome).border_r(1).border_color(t.border).overflow_y_scrollbar().track_scroll(this.railScroll).pb(16).text_size(13)
      .children(kids);
  }

  // The item's head: its ticket, prose, commits to filter on, shots and actions.
  header(t) {
    const item = this.item, files = this.files;
    const read = files.filter((f) => f.read).length, open = this.openCount();
    const added = files.reduce((n, f) => n + f.added, 0), removed = files.reduce((n, f) => n + f.removed, 0);
    const chip = (id, label, on, onClick, tip = null) => div().id(id).h(28).px(10).flex().flex_none().items_center().gap(6).rounded(7).text_size(12).cursor_pointer().max_w(260)
      .border_1().border_color(on ? t.accent : t.border).when(on, (e) => e.bg(t.accent + "1f")).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).when(Boolean(tip), (e) => e.tooltip(tip)).on_click((_e, cx) => onClick(cx)).child(label);
    const ticket = item.ticket, tilid = item.tilid && ticket ? `https://${item.tilid.instance}.tilid.io/project/${item.tilid.code}?ticket=${ticket.number}` : null;
    const loose = item.notes.filter((n) => !n.path);
    return v_flex().flex_none().px(24).pt(20).pb(16).gap(14).border_b(1).border_color(t.border)
      .child(h_flex().gap(12).items_center().min_w(0)
        .child(div().flex_none().font_family(MONO()).text_size(17).text_color(item.approved ? t.ansi2 : t.accent).child(item.feature ? "feature" : ticket ? `#${ticket.number}` : short(item.key)))
        .child(div().min_w(0).truncate().text_size(17).font_semibold().child(item.feature ? item.feature.branch : ticket ? ticket.title : item.commits[0]?.subject ?? ""))
        .when(Boolean(ticket?.screen), (e) => e.child(div().flex_none().px(7).h(20).flex().items_center().rounded(5).bg(t.raised).font_family(MONO()).text_size(10.5).text_color(t.muted).child(ticket.screen)))
        .child(div().flex_1())
        .when(Boolean(tilid), (e) => e.child(this.button("tilid", h_flex().gap(4).items_center().child("Tilid").child(icon("arrow-up-right", 12)), (cx) => cx.open_url(tilid), t, "Open the ticket in Tilid", "ghost"))))
      // a long description scrolls rather than pushing the diff down
      .when(Boolean(item.prose), (e) => e.child(div().id("prose").max_h(76).overflow_y_scrollbar().text_size(13).text_color(t.muted).child(item.prose)))
      .when(this.traced.reqs.length > 0, (e) => e.child(this.requirements(t)))
      .children(loose.map((n) => h_flex().id(`item-note-${n.id}`).gap(8).px(12).py(8).rounded(8).cursor_pointer().bg(this.noteColour(n, t) + "14").border_1().border_color(this.noteColour(n, t) + "47")
        .on_click((_e, cx) => this.pickNote(n.id, cx))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`${n.author} · ${n.state}`))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(n.body.split("\n")[0]))))
      // a feature filters by ticket rather than by commit; a ticket of one goes back to it
      .when(Boolean(item.feature), (e) => e.child(h_flex().gap(8).flex_wrap()
        .child(chip("ticket-all", `All ${item.feature.tickets.length} tickets`, true, () => {}, "The feature's net change, what its tickets add up to"))
        .children(item.feature.tickets.map((tk) => chip(`ticket-${tk.key}`, h_flex().gap(6).min_w(0)
          .child(div().flex_none().font_family(MONO()).text_size(11).text_color(t.accent).child(tk.key))
          .child(div().min_w(0).truncate().child(tk.screen ?? tk.title.replace(TICKET_PREFIX, ""))),
        false, (cx) => this.pickItem(tk.key, cx), `${tk.title}\nIts own change, alone`)))))
      .when(!item.feature && (item.commits.length > 1 || Boolean(this.commit) || Boolean(item.partOf)), (e) => e.child(h_flex().gap(8).flex_wrap()
        .when(Boolean(item.partOf), (x) => x.child(chip("feature", h_flex().gap(6).items_center().child(icon("chevron-left", 12)).child(branchOf(item.partOf ?? "")), false, (cx) => this.pickItem(item.partOf, cx), "Back to the feature this ticket is part of")))
        .when(item.commits.length > 1 || Boolean(this.commit), (x) => x.child(chip("commit-all", `All ${item.commits.length} commits`, !this.commit, (cx) => this.pickCommit(null, cx), "The ticket's net change, what its commits add up to")))
        .children((item.commits.length > 1 || this.commit ? item.commits : []).map((c) => chip(`commit-${c.sha}`, h_flex().gap(6).min_w(0)
          .child(div().flex_none().font_family(MONO()).text_size(11).text_color(t.accent).child(c.sha.slice(0, 7)))
          .child(div().min_w(0).truncate().child(c.subject))
          .when(c.copies.length > 0, (e) => e.child(h_flex().flex_none().gap(3).items_center().text_color(t.dim).child(icon("copy", 11)).child(String(c.copies.length)))),
        this.commit === c.sha, (cx) => this.pickCommit(c.sha, cx), `${c.subject}\n${c.author}, ${daysLabel([c.ts])}${c.copies.length ? `\nreplaces ${plural(c.copies.length, "rebased copy")}` : ""}`)))))
      .when(item.shots.length > 0, (e) => e.child(h_flex().id("shots").gap(12).pb(2).overflow_x_scrollbar()
        .children(item.shots.map((s, index) => {
          const on = this.shot?.id === s.id;
          const badge = s.error ? ["failed", t.ansi1] : !s.before ? ["new", t.ansi2] : !s.after ? ["gone", t.ansi3]
            : s.regions ? (s.regions.length ? [plural(s.regions.length, "change"), t.ansi3] : ["same", t.dim]) : null;
          const thumb = (file) => {
            const at = file && this.shots.get(file);
            return div().w(112).h(70).flex_none().rounded(6).overflow_hidden().border_1().border_color(t.border).bg(t.chrome).flex().items_center().justify_center()
              .when(Boolean(at), (e) => e.child(fitted(at, 110, 68))).when(!at, (e) => e.text_size(10.5).text_color(t.dim).child("none"));
          };
          return v_flex().id(`shot-${s.id}`).flex_none().p(6).gap(6).rounded(10).cursor_pointer().border_1().border_color(on ? t.accent : t.border)
            .bg(on ? t.accent + "14" : t.chrome).hover((x) => x.bg(t.hover))
            .on_click((_e, cx) => this.openShot(index, cx))
            .tooltip(s.error ? `${s.label}\nfailed: ${s.error}` : `${s.label}${s.route ? `\n${s.route}` : ""}`)
            .child(h_flex().gap(6).items_center().child(thumb(s.before)).child(div().text_color(t.dim).child(icon("arrow-right", 11))).child(thumb(s.after)))
            .child(h_flex().w(247).gap(6).items_center()
              .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(s.label))
              .when(Boolean(badge), (x) => x.child(div().flex_none().px(5).rounded(4).bg(badge[1] + "26").text_color(badge[1]).text_size(10.5).child(badge[0]))));
        }))))
      .child(h_flex().gap(8).items_center()
        .child(this.button("approve", item.approved ? "Unapprove" : h_flex().gap(6).items_center().child("Approve").child(div().text_size(10.5).opacity(0.7).child("a")), (cx) => this.approve(cx), t, item.approved ? "Back into the inbox" : "Approve it and go to the next one", item.approved ? "plain" : "primary"))
        .when(Boolean(item.advance) && !item.approved, (e) => e.child(this.button("approve-tilid", "Approve and move in Tilid", (cx) => this.approve(cx, true), t, `Approve, and move the ticket from "${item.advance.from}" to "${item.advance.to}"`)))
        .when(read < files.length, (e) => e.child(this.button("read-all", "Read all", (cx) => this.readAll(cx), t, "Mark every file read")))
        .when(open > 0, (e) => e.child(this.button("send", `Send ${plural(open, "note")}`, (cx) => this.sendNotes(cx), t, "Paste the open notes into the Claude that made these commits (s)")))
        .child(div().pl(16).text_size(12).text_color(t.muted).child("Ask Claude"))
        .when(!item.prose, (e) => e.child(this.button("describe", "Describe", (cx) => this.askClaude("describe", cx), t, "Ask the Claude to describe what it changes and why")))
        .when(Boolean(item.prose) && !this.files.some((f) => f.why || f.mechanical), (e) => e.child(this.button("ask-order", "Order", (cx) => this.askClaude("order", cx), t, "Ask the Claude for the order to read its files in")))
        .when(Boolean(item.ticket || item.feature) && !this.traced.reqs.length, (e) => e.child(this.button("ask-trace", "Trace", (cx) => this.askClaude("trace", cx), t, "Ask the Claude to list the ticket's requirements with the lines doing each")))
        .child(this.button("ask-review", "Review", (cx) => this.askClaude("review", cx), t, "Ask the Claude to read it and note what is wrong, risky or unclear"))
        .child(this.button("ask-shots", "Screens", (cx) => this.askClaude("shots", cx), t, "Ask the Claude for before and after screenshots of the screens it changes"))
        .child(div().flex_1())
        .child(h_flex().gap(10).text_size(12).text_color(t.dim)
          .child(div().text_color(t.ansi2).child(`+${added}`)).child(div().text_color(t.ansi1).child(`−${removed}`))
          .child(div().child(`${read}/${plural(files.length, "file")} read`))))
      .when(!item.exact, (e) => e.child(div().text_size(11.5).text_color(t.ansi3).child("These commits do not apply one after the other, so each file shows as it was before the first and after the last.")));
  }

  // A requirement names its ticket only in an item holding others.
  reqLabel(r) {
    return r.ticket && r.ticket !== this.item?.ticket?.number ? `#${r.ticket} ${r.text}` : r.text;
  }

  // The ticket's requirements, each a jump through the hunks doing it, then the hunks doing none of them.
  requirements(t) {
    const { reqs, outside } = this.traced, pick = this.reqPick, label = (r) => this.reqLabel(r);
    const colours = { covered: t.ansi2, partly: t.ansi3, missing: t.ansi1, gone: t.dim };
    const tips = { covered: "Done by the lines shown", partly: "Partly done", missing: "No line does it", gone: "The lines that did it are gone from the diff" };
    const row = (k, colour, label, extra, status, tip) => {
      const hunks = this.hunksOf(k), on = pick?.k === k;
      const count = !hunks.length ? "" : on ? `${pick.n + 1}/${hunks.length}` : plural(hunks.length, "hunk");
      return h_flex().id(`req-${k}`).h(28).px(10).gap(10).items_center().rounded(6).text_size(12.5).tooltip(tip)
        .when(on, (e) => e.bg(t.selected)).when(hunks.length > 0, (e) => e.cursor_pointer().hover((s) => s.bg(on ? t.selected : t.hover)).on_click((_e, cx) => this.pickReq(k, cx)))
        .child(div().size(8).flex_none().rounded(4).bg(colour))
        .child(h_flex().flex_1().min_w(0).items_baseline().overflow_hidden().whitespace_nowrap()
          .child(div().flex_none().text_color(status === "missing" || status === "gone" ? t.muted : t.foreground).child(label))
          .when(Boolean(extra), (x) => x.child(div().pl(10).min_w(0).truncate().text_color(t.muted).child(extra))))
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child(count))
        .child(div().w(52).flex_none().text_size(11.5).text_color(colour).child(status));
    };
    const covered = reqs.filter((r) => r.status === "covered").length;
    return v_flex().gap(4)
      .child(h_flex().gap(8).items_baseline().text_size(11.5)
        .child(div().font_semibold().text_color(t.muted).child("Requirements"))
        .child(div().text_color(t.dim).child(`${covered}/${reqs.length} covered`)))
      .child(v_flex().id("trace").max_h(150).overflow_y_scrollbar()
        .children(reqs.map((r, k) => row(k, colours[r.status], label(r), r.partly && `left: ${r.partly}`, r.status, r.partly ? `${r.text}\nLeft: ${r.partly}` : `${r.text}\n${tips[r.status]}`)))
        .when(outside.length > 0, (e) => e.child(row("outside", t.ansi5, "Outside the ticket", null, "", "Hunks doing none of its requirements, the mechanical files left out"))));
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
      const colour = statusColour(f, t);
      return wrap.bg(t.raised).border_t(1).border_color(t.border).text_size(13)
        .child(h_flex().flex_1().min_w(0).pl(14).pr(14 + SCROLLBAR_W).gap(10).items_center()
          .child(div().size(20).flex_none().flex().items_center().justify_center().rounded(4).bg(colour + "26").text_color(colour).text_size(10.5).font_semibold().child(STATUS[f.status] ?? "M"))
          .child(h_flex().flex_1().min_w(0).items_baseline().overflow_hidden().whitespace_nowrap()
            .when(this.tab === "inbox" && Object.keys(this.item?.repos ?? {}).length > 1, (x) => x.child(div().flex_none().text_color(t.dim).child(`${f.repo} · `)))
            .child(div().flex_none().text_color(t.dim).child(dir)).child(div().flex_none().font_semibold().text_color(f.read ? t.muted : t.foreground).child(baseName(f.path)))
            .when(Boolean(f.oldPath) && f.oldPath !== f.path, (x) => x.child(div().pl(8).text_color(t.dim).truncate().child(`from ${f.oldPath}`)))
            .when(Boolean(f.why), (x) => x.child(div().pl(12).min_w(0).truncate().text_color(t.muted).tooltip(f.why).child(f.why))))
          .when(e.open > 0, (x) => x.child(div().flex_none().px(6).rounded(4).bg(t.ansi3 + "26").text_color(t.ansi3).text_size(11).child(`${e.open} open`)))
          .child(div().flex_none().text_size(11.5).text_color(t.ansi2).child(f.added ? `+${f.added}` : ""))
          .child(div().flex_none().text_size(11.5).text_color(t.ansi1).child(f.removed ? `−${f.removed}` : ""))
          .when(this.tab === "inbox", (x) => x.child(h_flex().flex_none().gap(5).items_center().pl(6).text_size(11.5).text_color(f.read ? t.ansi2 : t.dim)
            .child(this.tick(f.read, 14, t))
            .child("Read"))));
    }
    if (e.kind === "group") {
      const all = e.read === e.count;
      return wrap.bg(t.raised).border_t(1).border_color(t.border).text_size(13)
        .child(h_flex().flex_1().min_w(0).pl(14).pr(14 + SCROLLBAR_W).gap(10).items_center()
          .child(div().size(20).flex_none().flex().items_center().justify_center().text_color(t.muted).child(icon(this.groupOpen ? "chevron-down" : "chevron-right", 14)))
          .child(div().font_semibold().text_color(all ? t.muted : t.foreground).child("Mechanical"))
          .child(div().flex_1().text_color(t.dim).child(plural(e.count, "file")))
          .when(e.open > 0, (x) => x.child(div().flex_none().px(6).rounded(4).bg(t.ansi3 + "26").text_color(t.ansi3).text_size(11).child(`${e.open} open`)))
          .child(h_flex().flex_none().gap(5).items_center().pl(6).text_size(11.5).text_color(all ? t.ansi2 : t.dim)
            .child(this.tick(all, 14, t)).child(`${e.read}/${e.count} read`)));
    }
    if (e.kind === "hunk") {
      const here = (h) => h.fi === e.fi && h.ri === e.ri;
      const tags = this.traced.tags.get(`${e.fi}:${e.ri}`) ?? [], outside = !tags.length && this.traced.outside.some(here);
      const tag = (k, colour, label, tip) => div().flex_none().max_w(280).h(20).px(7).flex().items_center().rounded(5).text_size(11.5)
        .bg(colour + (this.reqPick?.k === k ? "40" : "1f")).text_color(colour).tooltip(tip).child(div().truncate().child(label));
      return wrap.bg(t.chrome).text_color(t.dim).text_size(11.5)
        .child(h_flex().flex_1().min_w(0).pl(20).pr(14 + SCROLLBAR_W).gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().font_family(MONO()).child(`@@ ${e.old} → ${e.next}${e.text ? `   ${e.text}` : ""}`))
          .children(tags.map((k) => tag(k, t.accent, this.reqLabel(this.traced.reqs[k]), this.traced.reqs[k].text)))
          .when(outside, (x) => x.child(tag("outside", t.ansi5, "Outside the ticket", "This hunk does none of the ticket's requirements"))));
    }
    if (e.kind === "meta") return wrap.text_color(t.dim).child(div().pl(20).child(e.text));
    if (e.kind === "note") {
      const n = e.note, colour = this.noteColour(n, t), lines = noteLines(n.body);
      const card = v_flex().flex_1().min_w(0).h_full().my(6).mr(16).px(12).py(6).rounded(8).border_1().border_color(picked ? colour : colour + "47").bg(picked ? t.selected : colour + "14")
        .text_size(12)
        .child(h_flex().gap(8).items_center().h(20).text_size(11.5).text_color(t.dim)
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
    // Inside a file whose header scrolled away, its header stays on top of the diff
    const first = list[this.top], sticky = first && first.kind !== "file" && first.kind !== "group" ? this.headerOf(first.fi) : -1;
    if (!list.length) {
      const empty = this.tab === "working" ? (this.base === "HEAD" ? "Nothing changed since HEAD" : "Nothing changed since you last looked") : !this.summary ? "" : this.item ? "Nothing in this commit" : "Nothing left to review";
      return div().flex_1().p(24).text_color(t.dim).child(this.busy ?? empty);
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
      .child(v_virtual_list(`diff-${this.tab}`, list.length, this.heights, String, (range) => { this.seeTop(range.start); return list.slice(range.start, range.end).map((e, k) => this.row(e, range.start + k, t)); })
        .size_full().track_scroll(this.scroll).on_item_click((key, cx) => this.click(key, cx)))
      .when(sticky >= 0, (e) => e.child(div().id("sticky-file").absolute().top_0().left_0().right(SCROLLBAR_W).border_b(1).border_color(t.border)
        .on_click((_e, cx) => this.click(String(sticky), cx)).child(this.row(list[sticky], sticky, t))))
      .child(Scrollbar.vertical(`diff-${this.tab}`).viewport_from_layout().absolute().inset_0());
  }

  // The list hands over the rows it draws only while drawing, so a new first row redraws once more to name its file above the diff.
  seeTop(start) {
    if (start === this.top) return;
    this.top = start;
    this.async.timer.after(0, (cx) => cx.notify());
  }

  // p, or a thumbnail: the screens open on `index`, before and after side by side.
  openShot(index, cx) {
    const shots = this.item?.shots ?? [];
    if (!shots.length) { notify({ title: "Review", body: "No screens for this one yet: Screens asks the Claude for them", level: "info", timeout: 2500 }); return; }
    this.shot = { id: shots[Math.max(0, Math.min(index, shots.length - 1))].id, mode: "pair", before: false, region: null };
    this.h.focus();
    cx.notify();
  }

  // The screen `step` away from the shown one, wrapping around.
  stepShot(step) {
    const shots = this.item?.shots ?? [];
    if (!shots.length) return;
    const at = shots.findIndex((s) => s.id === this.shot.id);
    this.shot.id = shots[(at + step + shots.length) % shots.length].id;
    this.shot.region = null;
  }

  // d and D: the next and previous region that differs, zoomed on, then the whole picture again past either end.
  stepRegion(step) {
    const shot = this.item?.shots.find((s) => s.id === this.shot.id), count = shot?.regions?.length ?? 0;
    if (!count) return;
    const at = this.shot.region ?? (step > 0 ? -1 : count);
    const next = at + step;
    this.shot.region = next < 0 || next >= count ? null : next;
  }

  // ←/→ go through the screens, b flips before and after (one at a time), m goes back and forth to side by side; the diff's keys wait until the diff is back.
  shotKey(k, cx) {
    const s = this.shot;
    if (k === "left" || k === "h") this.stepShot(-1);
    else if (k === "right" || k === "l") this.stepShot(1);
    else if (k === "b") { s.before = s.mode === "pair" ? true : !s.before; s.mode = "single"; }
    else if (k === "m") s.mode = s.mode === "pair" ? "single" : "pair";
    else if (k === "d") this.stepRegion(1);
    else if (k === "shift-d" || k === "D") this.stepRegion(-1);
    else return;
    cx.notify();
  }

  // The screens full size: before and after side by side, or one at a time; a screen only one side has (new, gone) shows that side alone.
  shotView(t) {
    const shots = this.item?.shots ?? [], view = this.shot, index = shots.findIndex((s) => s.id === view.id), shot = shots[index];
    if (!shot) return div().flex_1();
    const both = Boolean(shot.before && shot.after), pair = both && view.mode === "pair";
    const before = both ? view.before : !shot.after;
    const set = (patch) => (cx) => { Object.assign(this.shot, patch); this.h.focus(); cx.notify(); };
    const segment = (id, label, on, onClick, tip) => div().id(id).h(26).px(10).flex().items_center().rounded(5).text_size(11.5).cursor_pointer()
      .when(on, (e) => e.bg(t.background).border_1().border_color(t.border)).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground)).tooltip(tip).on_click((_e, cx) => onClick(cx)).child(label);
    const segments = (children) => h_flex().p(2).gap(2).rounded(7).bg(t.raised).children(children);
    const gap = 12, caption = 22, regions = both ? shot.regions ?? [] : [];
    const changes = !both || !shot.regions ? null
      : !regions.length ? "No change"
      : view.region === null || view.region === undefined ? plural(regions.length, "change") : `Change ${view.region + 1} of ${regions.length}`;
    const room = pair ? { w: (this.shotRoom.w - gap) / 2, h: this.shotRoom.h - caption } : { w: this.shotRoom.w, h: this.shotRoom.h - caption };
    const pane = (side) => {
      const file = side === "before" ? shot.before : shot.after, at = file && this.shots.get(file);
      const label = side === "before" ? (shot.after ? "Before" : "Before · gone after") : (shot.before ? "After" : "After · new screen");
      // the boxes are where the after picture has them, which on a page that grew is not where the before one does
      const boxes = side === "before" && shot.grew ? [] : regions;
      // the caption sits on the picture, both centred in the room
      return v_flex().flex_1().min_w(0).h_full().gap(6).items_center().justify_center()
        .child(h_flex().h(16).gap(6).items_center().text_size(11).font_semibold().text_color(side === "before" ? t.muted : t.foreground).child(label))
        .when(Boolean(at) && room.w > 0, (e) => e.child(div().rounded(6).overflow_hidden().border_1().border_color(t.border).child(this.picture(at, boxes, { w: room.w - 2, h: room.h - 2 }, view.region ?? null, t))))
        .when(!at, (e) => e.text_color(t.dim).child("No picture"));
    };
    return v_flex().flex_1().min_h(0).px(24).py(16).gap(14)
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(this.button("shot-prev", icon("chevron-left", 14), (cx) => { this.stepShot(-1); cx.notify(); }, t, "Previous screen (← or h)", "ghost"))
        .child(div().flex_none().font_family(MONO()).text_size(11.5).text_color(t.dim).child(`${index + 1} / ${shots.length}`))
        .child(this.button("shot-next", icon("chevron-right", 14), (cx) => { this.stepShot(1); cx.notify(); }, t, "Next screen (→ or l)", "ghost"))
        .child(div().pl(4).flex_none().max_w(320).truncate().font_semibold().child(shot.label))
        .when(Boolean(shot.route), (e) => e.child(div().flex_1().min_w(0).truncate().font_family(MONO()).text_size(11.5).text_color(t.dim).child(shot.route)))
        .when(!shot.route, (e) => e.child(div().flex_1()))
        .when(Boolean(changes), (e) => e.child(div().flex_none().text_size(11.5).text_color(regions.length ? t.ansi3 : t.dim).tooltip(regions.length ? "d and D go through them" : "Both pictures are the same").child(changes)))
        .when(Boolean(shot.grew), (e) => e.child(div().flex_none().text_size(11.5).text_color(t.dim).child(`${shot.grew > 0 ? "grew" : "shrank"} by ${Math.abs(shot.grew)} px`)))
        .when(both, (e) => e.child(segments([
          segment("shot-pair", "Side by side", pair, set({ mode: "pair" }), "Before and after next to each other (m)"),
          segment("shot-single", "One at a time", !pair, set({ mode: "single" }), "One picture, the whole room (m)"),
        ])))
        .when(both && !pair, (e) => e.child(segments([
          segment("shot-before", "Before", before, set({ before: true }), "b flips"),
          segment("shot-after", "After", !before, set({ before: false }), "b flips"),
        ])))
        .child(this.button("shot-close", "Back to the diff", (cx) => { this.shot = null; cx.notify(); }, t, "esc", "ghost")))
      .when(Boolean(shot.error), (e) => e.child(div().px(10).py(6).rounded(6).bg(t.ansi1 + "14").text_size(12).text_color(t.ansi1).child(`The last capture failed: ${shot.error}`)))
      .child(h_flex().id("shot-full").flex_1().min_h(0).gap(gap)
        .on_size_change((size, cx) => {
          const zoom = Number(settings().zoom) || 1, w = size.width / zoom, h = size.height / zoom;
          if (Math.abs(w - this.shotRoom.w) > 1 || Math.abs(h - this.shotRoom.h) > 1) { this.shotRoom = { w, h }; cx.notify(); }
        })
        .when(pair, (e) => e.child(pane("before")).child(pane("after")))
        .when(!pair, (e) => e.child(pane(before ? "before" : "after"))));
  }

  // A screen with what differs boxed and numbered, fitted whole or zoomed on region `focus`.
  picture(at, regions, frame, focus, t) {
    const v = viewOf(at, frame, focus === null ? null : regions[focus]);
    return div().relative().w(v.w).h(v.h).overflow_hidden()
      .child(image(at.path).absolute().left(v.left).top(v.top).w(Math.floor(at.w * v.scale)).h(Math.floor(at.h * v.scale)))
      .children(regions.map((r, k) => {
        const on = k === focus, colour = on ? t.accent : t.ansi3;
        return div().absolute().left(v.left + r.x * v.scale - 3).top(v.top + r.y * v.scale - 3).w(r.width * v.scale + 6).h(r.height * v.scale + 6).rounded(4).border_2().border_color(colour)
          .child(div().absolute().top(-2).left(-2).h(16).px(4).flex().items_center().rounded(3).bg(colour).text_color(t.background).text_size(10.5).font_semibold().child(String(k + 1)));
      }));
  }

  // Under the diff: the composer on the picked line, or the picked note in full with its states.
  panel(t) {
    const target = this.target, note = this.note();
    const bar = v_flex().flex_none().px(24).py(14).gap(10).border_t(1).border_color(t.border).bg(t.chrome);
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
        .child(div().id("comment").flex_1().min_w(0).h(36).px(12).flex().items_center().rounded(8).border_1().border_color(t.accent).bg(t.input).cursor_text()
          .child(Input.new(this.input).h_full().text_size(12.5).text_color(t.foreground)))
        .when(working, (e) => e
          .child(this.button("paste", "Paste", (cx) => this.submit(cx), t, "Paste into the Claude's prompt, unsent", ready ? "primary" : "plain"))
          .child(this.button("send-now", "Send", (cx) => this.submit(cx, true), t, "Send it to the Claude now")))
        .when(!working, (e) => e.child(this.button("add-note", "Add note", (cx) => this.submit(cx), t, "Enter", ready ? "primary" : "plain")))
        .child(this.button("cancel", "Cancel", (cx) => this.closeComposer(cx), t, "esc", "ghost")));
  }

  working(t) {
    return v_flex().flex_1().min_w(0).min_h(0)
      .child(h_flex().flex_none().h(48).px(24).gap(10).items_center().border_b(1).border_color(t.border).text_size(12)
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

  // The keys of what is shown: the screens, the composer, a picked note, else the diff.
  footerKeys() {
    if (this.shot) return [["← →", "screen"], ...this.item?.shots.find((s) => s.id === this.shot.id)?.regions?.length ? [["d D", "change"]] : [], ["b", "before, after"], ["m", "side by side"], ["esc", "back to the diff"]];
    if (this.target) return [["enter", "add"], ["esc", "cancel"]];
    if (this.picked) return [["v", "resolve"], ["x", "reject"], ["d", "delete"], ["n", "next note"], ["esc", "close"]];
    const move = [["j k", "line"], ["J K", "file"]];
    if (this.tab === "working") return [...move, ["enter", "open"], ["c", "comment"]];
    const next = this.reqPick && this.list[this.cursor]?.kind === "hunk" ? [["enter", "next hunk"]] : [];
    return [["r", "read, next"], ...move, ...next, ["[ ]", "item"], ["n", "next note"], ["c", "comment"], ...this.item?.shots.length ? [["p", "screens"]] : [], ["a", "approve"], ["s", "send notes"]];
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
    const tab = (id, label) => div().id(`tab-${id}`).h(28).px(14).flex().items_center().rounded(6).text_size(12.5).cursor_pointer()
      .when(this.tab === id, (e) => e.bg(t.background).border_1().border_color(t.border)).text_color(this.tab === id ? t.foreground : t.muted)
      .on_click((_e, cx) => this.setTab(id, cx)).child(label);
    const dot = (status) => div().size(7).flex_none().rounded(4).bg(status === "working" ? t.ansi3 : status === "blocked" ? t.ansi1 : status === "done" ? t.ansi2 : t.dim);
    const panel = this.panel(t);
    const open = this.summary?.items.reduce((n, i) => n + (i.approved ? 0 : i.open), 0) ?? 0;
    return v_flex().id("review").size_full().bg(t.background).text_color(t.foreground).text_size(12.5)
      .track_focus(this.h).on_key_down((e, cx) => this.key(e, cx))
      .child(h_flex().flex_none().h(52).px(16).gap(10).items_center().border_b(1).border_color(t.border).bg(t.chrome)
        .child(h_flex().p(2).gap(2).rounded(8).bg(t.raised).child(tab("inbox", "Inbox")).child(tab("working", "Working")))
        .when(Boolean(this.family), (e) => e.child(this.repoSwitch(t)))
        .when(this.tab === "inbox" && Boolean(this.project), (e) => e.child(div().pl(4).font_semibold().child(this.project)))
        .child(div().w(10))
        .children(list.map((a) => h_flex().id(`agent-${a.address}`).h(30).px(10).gap(6).items_center().rounded(7).cursor_pointer().max_w(220)
          .when(a.address === this.claude, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).tooltip(a.cwd ?? a.title)
          .on_click((_e, cx) => { this.claude = a.address; this.statusSeen = null; this.from = null; this.reload(cx); })
          .child(dot(a.status)).child(div().min_w(0).truncate().text_size(12).child(a.title || a.tab_name))))
        .when(!list.length, (e) => e.child(div().text_size(12).text_color(t.dim).child("No Claude in this space")))
        .child(div().flex_1())
        .when(this.tab === "inbox" && open > 0, (e) => e.child(this.button("send-all", `Send all ${plural(open, "open note")}`, (cx) => this.sendNotes(cx, true), t, "Paste every item's open notes into the picked Claude")))
        .when(Boolean(this.busy), (e) => e.child(div().text_size(11.5).text_color(t.dim).child(this.busy))))
      .when(Boolean(this.error), (e) => e.child(div().flex_none().px(24).py(8).text_size(12).text_color(t.ansi1).bg(t.ansi1 + "14").child(this.error)))
      .child(this.tab === "working" ? this.working(t) : this.inbox(t))
      .when(Boolean(panel), (e) => e.child(panel))
      .child(h_flex().flex_none().h(32).px(20).gap(18).items_center().border_t(1).border_color(t.border).bg(t.chrome).text_size(11).text_color(t.dim)
        .children(this.footerKeys().map(([k, label]) => h_flex().gap(5).items_center().child(this.hint(k, t)).child(label)))
        .child(div().flex_1())
        .child(div().truncate().max_w(320).child(tildePath(this.root ?? "", home()))));
  }
}
