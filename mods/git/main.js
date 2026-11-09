// The repo of the focused pane as one commit graph: the uncommitted work is its top row, Current, picked like any commit to see its files and diff and commit it.
// Right-click a row for git's actions on its commit and on each label it carries, double-click it to check out its branch; menus and dialogs are overlays of this mod (overlay.js).

import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { agents, spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, props, shared, setShared, run } from "herdr";
import { CURRENT, logArgs, parseLog, lanesOf, labelsOf, shortAge, fullDate, diffRows, numstat, lineCounts, trackerOf, ticketLink, tilidUrl, FIND_TILIDRC } from "./graph.js";
import { CHANGED, Menu, Dialog, act, openMenu, openDialog, runPlan } from "./overlay.js";
import { plan } from "./actions.js";
import { BUN, CLI } from "./paths.js";
import { PICKS, folderOf, pickRepo, repoName } from "./repos.js";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: folderOf(space, f, panes(), agents()), on };
}
// What the pane shows: the focused folder, and the repo picked in its family.
const key = () => JSON.stringify({ ...location(), picks: shared(PICKS) ?? null });

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
const cut = (lines) => lines.slice(0, 1500).map((line) => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line);

const LANE_KEYS = ["accent", "ansi2", "ansi5", "ansi3", "ansi6", "ansi1", "ansi4"];
const LANE_W = 12;
const ROW_H = 22;
const PAGE = 300;
const MORE = "more";
const SETTINGS = "git.graph";
const MAX_DETAILS = 200;
const ICON = (name) => `mods/git/${name}.svg`;
const clip = (name) => name.length > 22 ? `${name.slice(0, 21)}…` : name;
const REVIEWS_EVERY_MS = 30000;
// The review mod opens or reuses the space's Review tab on what this asks for.
const openReview = (extra) => { setShared("review.request", { ...extra, at: Date.now() }); run("review.request"); };
// The forges and default Tilid instance of the user's config, kept once read: they change only when the user edits it, and a reload of the mod picks that up. A failed read is asked again by the next repo.
const NO_TRACKERS = { forges: {}, tilid: null };
let known = null;
async function trackers() {
  if (known || !CLI) return known ?? NO_TRACKERS;
  try {
    const r = await exec(BUN, [CLI, "trackers", "--json"]);
    if (r.code !== 0) return NO_TRACKERS;
    known = JSON.parse(r.stdout);
    return known;
  } catch { return NO_TRACKERS; }
}

export default class Git extends View {
  // init is handed no props: props() holds what the layout or openOverlay passed, a menu or a dialog for the overlay copies.
  init(_props, cx) {
    const p = props() ?? {};
    if (p.menu) { this.overlay = new Menu(p.menu); return; }
    if (p.dialog) { this.overlay = new Dialog(p.dialog, cx); return; }
    this.files = []; this.rows = []; this.diffWidth = 0; this.hasHead = false; this.message = ""; this.handle = cx.focus_handle();
    this.limit = PAGE; this.details = new Map(); this.families = new Map(); this.height = 0; this.changedSeen = shared(CHANGED);
    this.async = cx;
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.branchInput = InputState.new({ placeholder: "New branch, Enter to create" });
    this.branchInput.on("submit", (_e, cx) => { const name = this.branchInput.value().trim(); if (name) { this.branchInput.set_value(""); this.act("Create branch", ["switch", "-c", name], cx); } });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.clear();
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  get graphSettings() { return { scope: "all", remotes: true, ...(shared(SETTINGS) ?? {}) }; }

  // The work tree and, for a linked worktree, the main checkout's git folder where the refs live: a commit, checkout or fetch made anywhere redraws the graph.
  watch(folders, cx) {
    if (this.on) return;
    for (const folder of folders) {
      if (this.watched.has(folder)) continue;
      this.watched.add(folder);
      const root = this.root;
      cx.spawn(async (cx) => {
        try {
          while (this.root === root && this.watched.has(folder)) {
            await watchFolder(folder);
            if (this.root === root) this.refresh(cx);
          }
        } catch { this.watched.delete(folder); }
      });
    }
  }

  refresh(cx) {
    if (this.loading || this.busy) { this.again = true; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.clear();
      this.message = ""; this.input.set_value(""); this.error = null; this.note = null;
    }
    if (!cwd) return;
    this.loading = true; this.again = false;
    const { scope, remotes } = this.graphSettings, limit = this.limit;
    cx.spawn(async (cx) => {
      try {
        const topArgs = ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"];
        let top = await exec("git", topArgs, { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.clear(); this.error = "Not a git repository"; return; }
        const found = top.stdout.trim().split("\n")[0];
        const picked = await pickRepo(found, (cmd, args, at) => exec(cmd, args, { cwd: at, on }), shared(PICKS), this.families, on);
        if (key() !== context) return;
        const shown = picked.shown;
        this.family = picked.family ? picked : null;
        if (shown !== found) top = await exec("git", topArgs, { cwd: shown, on });
        const [root, common] = top.stdout.trim().split("\n"), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const [status, head] = await Promise.all([git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]), git(["rev-parse", "--verify", "HEAD"])]);
        if (status.code !== 0) throw new Error(status.stderr);
        const hasHead = head.code === 0;
        const entries = status.stdout.split("\0").filter(Boolean);
        const untracked = entries.slice(0, 1000).filter((e) => e.startsWith("?? ")).map((e) => `:(literal)${e.slice(3)}`);
        const [counted, ...diffs] = await Promise.all([
          untracked.length ? git(["grep", "--untracked", "-c", "-I", "-z", "", "--", ...untracked]) : Promise.resolve({ code: 0, stdout: "", stderr: "" }),
          ...(hasHead ? [git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])] : [git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), git(["diff", "--numstat", "-z", "--no-renames"])]),
        ]);
        for (const r of diffs) if (r.code !== 0) throw new Error(r.stderr);
        const stats = { ...numstat(diffs.map((r) => r.stdout)), ...lineCounts(counted.stdout) };
        const files = [];
        for (const entry of entries.slice(0, 1000)) {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
          files.push({ path, status: s, fresh, staged: xy[0] !== " " && xy[0] !== "?", ...(stats[path] ?? { add: 0, del: 0 }) });
        }
        const [branch, list, counts, remoteList, log] = await Promise.all([
          git(["branch", "--show-current"]), git(["branch", "--format=%(refname:short)"]), git(["rev-list", "--left-right", "--count", "@{u}...HEAD"]), git(["remote"]),
          hasHead ? git(logArgs({ scope, remotes, limit })) : Promise.resolve({ code: 0, stdout: "", stderr: "" }),
        ]);
        if (key() !== context) return;
        if (log.code !== 0) throw new Error(log.stderr);
        const [behind, ahead] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
        const { commits, more } = parseLog(log.stdout, limit);
        const headHash = hasHead ? head.stdout.trim() : null;
        const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
        const current = files.length ? [{ hash: CURRENT, current: true, parents: headHash ? [headHash] : [], subject: "Current", add, del, refs: "" }] : [];
        Object.assign(this, {
          root, on, hasHead, files, headHash, more, limited: entries.length > 1000, error: null,
          branch: branch.stdout.trim() || null, branches: list.stdout.split("\n").filter(Boolean), remotes: remoteList.stdout.split("\n").filter(Boolean),
          behind, ahead, hasUpstream: counts.code === 0, graph: lanesOf([...current, ...commits]),
        });
        this.watch([root, ...(common && !common.startsWith(`${root}/`) ? [common] : [])], cx);
        if (this.trackerRoot !== root) cx.spawn((cx) => this.findTracker(root, on, cx));
        if (!on && (this.reviewsRoot !== root || Date.now() - this.reviewsAt > REVIEWS_EVERY_MS)) cx.spawn((cx) => this.findReviews(root, cx));
        if (this.selected === CURRENT && !files.length) this.selected = null;
        if (!this.selected) this.selected = files.length ? CURRENT : headHash;
        if (this.selected === CURRENT) {
          if (this.open && !files.some((f) => f.path === this.open)) this.open = null;
          if (!this.open && files.length) this.open = files[0].path;
          if (this.open) {
            try { await this.load(this.open, context); }
            catch { if (key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
          } else this.setLines([]);
        } else if (this.selected && !this.details.has(this.selected)) this.showCommit(this.selected, cx);
      } catch (e) { if (key() === context) this.error = String(e); }
      finally { this.loading = false; cx.notify(); if (this.again) this.refresh(cx); }
    });
  }

  showRepo(repo) {
    setShared(PICKS, { ...(shared(PICKS) ?? {}), [this.family.at]: repo });
  }

  // Forgets the repo shown: its files, branch, graph, selection and the diff open.
  // The Tilid project or forge repo a commit's ticket lines open, read once per repo on the repo's own machine, against the forges the review CLI knows here.
  async findTracker(root, on, cx) {
    this.trackerRoot = root; this.tracker = null;
    const [origin, rc, known] = await Promise.all([
      exec("git", ["remote", "get-url", "origin"], { cwd: root, on }),
      exec("sh", ["-c", FIND_TILIDRC], { cwd: root, on }),
      trackers(),
    ]);
    if (this.trackerRoot !== root) return;
    this.tracker = trackerOf(tilidUrl(rc.code === 0 ? rc.stdout : "", known.tilid), origin.code === 0 ? origin.stdout : "", known.forges);
    cx.notify();
  }

  // The review inbox item (ticket or loose commit) holding each of the repo's commits, with its open notes.
  async findReviews(root, cx) {
    this.reviewsRoot = root; this.reviewsAt = Date.now();
    const byHash = new Map();
    try {
      const r = CLI ? await exec(BUN, [CLI, "inbox", "--repo", root, "--json"]) : null;
      for (const item of r?.code === 0 ? JSON.parse(r.stdout).items : []) {
        for (const c of item.commits) byHash.set(c.sha, { key: item.key, label: item.ticket ? `#${item.ticket.number}` : item.key.slice(0, 8), open: item.open, approved: item.approved });
      }
    } catch { /* no inbox for this repo */ }
    if (this.reviewsRoot !== root) return;
    this.reviews = byHash;
    cx.notify();
  }

  clear() {
    this.root = null; this.on = null; this.family = null; this.files = []; this.open = null; this.watched = new Set(); this.limited = false;
    this.branch = null; this.branches = []; this.remotes = []; this.behind = 0; this.ahead = 0; this.hasUpstream = false; this.picking = false;
    this.graph = null; this.more = false; this.headHash = null; this.selected = null; this.details = new Map(); this.commitFile = null;
    this.setLines([]);
  }

  repo() { return { root: this.root, on: this.on, ctx: { branch: this.branch, remotes: this.remotes } }; }

  async load(path, context) {
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (key() === context && this.selected === CURRENT && this.open === path) this.setLines(cut(lines));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  select(hash, cx) {
    if (this.selected === hash) return;
    this.selected = hash; this.note = null; this.setLines([]);
    if (hash === CURRENT) { this.open = null; this.refresh(cx); } else this.showCommit(hash, cx);
    cx.notify();
  }

  pick(path, cx) {
    this.open = path; this.setLines([]); this.note = null;
    const context = this.context;
    cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== key()) return;
    const context = this.context, staged = this.files.some((f) => f.staged);
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      const error = await runPlan(this.repo(), plan("commit", { type: "current" }, { all: !staged, message: this.message }, this.repo().ctx));
      if (key() === context) { if (error) this.note = `Commit failed: ${error}`; else { this.message = ""; this.input.set_value(""); } }
      this.busy = false; this.refresh(cx); cx.notify();
    });
    cx.notify();
  }

  // A commit's body, committer and files, kept for the last few looked at; the first file's diff shows.
  showCommit(hash, cx) {
    const root = this.root, on = this.on, context = this.context;
    this.commitFile = null; this.setLines([]);
    const known = this.details.get(hash);
    if (known) { if (known.files.length) this.pickCommitFile(known.files[0].path, cx); return; }
    cx.spawn(async (cx) => {
      const show = (...flags) => exec("git", [...READ, "show", "--first-parent", "--no-renames", "--no-color", "--no-ext-diff", ...flags, hash], { cwd: root, on });
      const [info, names, numbers] = await Promise.all([show("-s", "--format=%B%x00%cn%x00%ce%x00%an%x00%ae"), show("--format=", "--name-status", "-z"), show("--format=", "--numstat", "-z")]);
      if (key() !== context) return;
      const [body, committer, committerEmail, author, email] = info.stdout.split("\0");
      const stats = numstat([numbers.stdout]);
      const tokens = names.stdout.split("\0").filter(Boolean), files = [];
      for (let i = 0; i + 1 < tokens.length; i += 2) files.push({ path: tokens[i + 1], status: tokens[i][0], ...(stats[tokens[i + 1]] ?? { add: 0, del: 0 }) });
      const lines = body.trim().split("\n");
      this.details.set(hash, { body: lines.slice(1).join("\n").trim(), committer: committer !== author || committerEmail?.trim() !== email?.trim() ? `${committer} <${committerEmail?.trim()}>` : null, files });
      if (this.details.size > MAX_DETAILS) this.details.delete(this.details.keys().next().value);
      if (this.selected === hash && files.length) this.pickCommitFile(files[0].path, cx);
      cx.notify();
    });
    cx.notify();
  }

  pickCommitFile(path, cx) {
    const root = this.root, on = this.on, context = this.context, hash = this.selected;
    this.commitFile = path; this.setLines([]);
    cx.spawn(async (cx) => {
      const r = await exec("git", [...READ, "show", "--format=", "--first-parent", "--no-ext-diff", "--no-textconv", "--no-color", hash, "--", path], { cwd: root, on });
      if (key() === context && this.selected === hash && this.commitFile === path) {
        const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
        this.setLines(cut(first < 0 ? ["No text diff available"] : all.slice(first)));
      }
      cx.notify();
    });
    cx.notify();
  }

  setting(change, cx) {
    setShared(SETTINGS, { ...this.graphSettings, ...change });
    this.limit = PAGE; this.refresh(cx);
  }

  // Runs a git command in the repo and shows what it said when it fails
  act(label, args, cx) {
    if (!this.root || this.busy) return;
    const root = this.root, on = this.on, context = this.context;
    this.busy = true; this.note = null; this.picking = false;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", args, { cwd: root, on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
      } catch (e) { if (key() === context) this.note = `${label} failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // A double-click on a row checks out its first branch other than the current one; a remote branch checks out its local branch, or asks to make one.
  checkout(row, cx) {
    const label = labelsOf(row.refs, this.remotes).find((l) => (l.kind === "branch" && !l.head) || l.kind === "remote");
    if (!label) return;
    if (label.kind === "branch" && !label.head) act("checkout", { type: "branch", name: label.name }, this.repo(), cx);
    if (label.kind === "remote") {
      const target = { type: "remote", name: label.name, remote: label.remote, branch: label.branch, local: this.branches.includes(label.branch) };
      if (target.local) act("checkout-remote", target, this.repo(), cx); else openDialog("checkout-remote", target, this.repo());
    }
  }

  // A row's menu: its commit (or Current), then a section per branch, remote branch and tag on it.
  sectionsOf(row) {
    if (row.current) return [{ title: "Current", target: { type: "current", staged: this.files.some((f) => f.staged) } }];
    const sections = [{ title: `Commit ${row.hash.slice(0, 8)}`, target: { type: "commit", hash: row.hash, subject: row.subject, head: row.hash === this.headHash, merge: row.merge } }];
    for (const label of labelsOf(row.refs, this.remotes)) {
      if (label.kind === "branch") sections.push({ title: `Branch ${label.name}`, target: { type: "branch", name: label.name, head: label.head, remotes: label.remotes } });
      if (label.kind === "remote") sections.push({ title: `Remote ${label.name}`, target: { type: "remote", name: label.name, remote: label.remote, branch: label.branch, local: this.branches.includes(label.branch) } });
      if (label.kind === "tag") sections.push({ title: `Tag ${label.name}`, target: { type: "tag", name: label.name } });
    }
    return sections;
  }

  // The list reports clicks by key alone, so a double-click is two on the same row within 400 ms.
  rowClick(key, cx) {
    if (key === MORE) { this.nextPage(cx); return; }
    const now = Date.now(), double = this.lastClick?.key === key && now - this.lastClick.at < 400;
    this.lastClick = double ? null : { key, at: now };
    const row = this.graph?.rows.find((r) => r.hash === key);
    if (!row) return;
    if (double) this.checkout(row, cx); else this.select(key, cx);
  }

  nextPage(cx) {
    if (this.loading || this.limit > (this.graph?.rows.length ?? 0)) return;
    this.limit += PAGE;
    this.refresh(cx);
  }

  rowMenu(key) {
    const row = this.graph?.rows.find((r) => r.hash === key);
    if (row) openMenu(this.sectionsOf(row), this.repo());
  }

  // The strokes around a row's dot as one path per colour, lane changes as curves with vertical ends, and its dot: a ring for HEAD and for Current.
  graphCell(row, t, width) {
    const x = (lane) => 6 + lane * LANE_W, y = (at) => at * ROW_H;
    const colour = (lane) => t[LANE_KEYS[lane % LANE_KEYS.length]];
    const paths = new Map();
    for (const [x1, y1, x2, y2, lane, dashed] of row.segs) {
      const k = `${dashed ? "d" : lane}`;
      if (!paths.has(k)) paths.set(k, { colour: dashed ? t.muted : colour(lane), path: dashed ? PathBuilder.stroke(1.5).dash_array([3, 3]) : PathBuilder.stroke(1.5) });
      const p = paths.get(k), mid = (y(y1) + y(y2)) / 2;
      p.path = p.path.move_to(x(x1), y(y1));
      p.path = x1 === x2 ? p.path.line_to(x(x2), y(y2)) : p.path.cubic_bezier_to(x(x2), y(y2), x(x1), mid, x(x2), mid);
    }
    const head = row.hash === this.headHash, ring = head || row.current, dot = row.current ? t.muted : colour(row.col);
    return div().relative().flex_none().w(width * LANE_W + 2).h(ROW_H).overflow_hidden()
      .children([...paths.values()].map(({ colour, path }) => window.paint_path(path.build(), colour).absolute().top(0).left(0).size_full()))
      .child(div().absolute().left(x(row.col) - 4).top(ROW_H / 2 - 4).size(8).rounded(4).when(ring, (e) => e.border_2().border_color(dot).bg(t.chrome)).when(!ring, (e) => e.bg(dot)));
  }

  labelChip(label, row, t) {
    const lane = t[LANE_KEYS[row.col % LANE_KEYS.length]];
    const chip = () => h_flex().h(16).flex_none().items_center().rounded(4).border_1().overflow_hidden().font_family("JetBrains Mono").text_size(10.5);
    const part = (icon, text) => h_flex().px(4).gap(3).items_center().child(svg(ICON(icon)).size(10)).child(clip(text));
    if (label.kind === "head") return chip().border_color(t.accent).bg(t.accent).text_color(t.background).font_semibold().child(div().px(4).child("HEAD"));
    if (label.kind === "tag") return chip().border_color(t.ansi3).text_color(t.ansi3).child(part("tag", label.name));
    if (label.kind === "remote") return chip().border_color(t.border).text_color(t.muted).child(part("cloud", label.name));
    return chip().border_color(lane).text_color(label.head ? t.background : t.foreground).when(label.head, (e) => e.bg(lane).font_semibold())
      .child(part(label.head ? "check" : "branch", label.name))
      .children(label.remotes.map((remote) => div().h_full().px(4).flex().items_center().border_l(1).border_color(lane).bg(lane + "1f").text_color(label.head ? t.foreground : t.muted).font_normal().child(remote)));
  }

  graphRow(row, t, width) {
    const head = row.hash === this.headHash, selected = this.selected === row.hash;
    const labels = row.current ? [] : labelsOf(row.refs, this.remotes);
    return h_flex().h(ROW_H).flex_none().gap(6).pr(8).items_center().rounded(4)
      .when(head && !selected, (e) => e.bg(t[LANE_KEYS[row.col % LANE_KEYS.length]] + "14")).when(selected, (e) => e.bg(t.selected))
      .cursor_pointer().hover((x) => x.bg(t.hover))
      .child(this.graphCell(row, t, width))
      .child(h_flex().flex_1().min_w(0).gap(5).items_center().overflow_hidden()
        .children(labels.map((label) => this.labelChip(label, row, t)))
        .child(div().flex_1().min_w(0).truncate().when(row.current || row.merge, (e) => e.text_color(t.muted)).when(head, (e) => e.font_semibold()).child(row.current ? `Current · ${this.files.length} files` : row.subject)))
      .when(Boolean(row.current), (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${row.add}`)).child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${row.del}`)))
      .when(!row.current, (e) => e.child(div().flex_none().text_color(t.dim).child(shortAge(row.ts))));
  }

  graphList(t) {
    const { rows = [], width = 1 } = this.graph ?? {};
    const count = rows.length + (this.more ? 1 : 0);
    // The last row drawn means the end scrolled into view: the next page loads after this render, which can't refresh itself.
    const more = () => { this.async.timer.after(0, (cx) => this.nextPage(cx)); return div(); };
    const item = (i) => i < rows.length ? this.graphRow(rows[i], t, width)
      : more().h(ROW_H).flex_none().px(8).flex().items_center().rounded(4).text_color(t.accent).cursor_pointer().hover((x) => x.bg(t.hover)).child(this.loading ? "Loading more commits…" : `Load ${PAGE} more commits`);
    return div().relative().h(Math.max(140, Math.round((this.height || 600) * 0.4))).flex_none().px(6).py(4).border_b(1).border_color(t.border)
      .font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
      .when(!rows.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading…" : this.root ? "No commits yet" : "No folder"))))
      .when(rows.length > 0, (e) => e
        .child(v_virtual_list("graph", count, ROW_H, (i) => i < rows.length ? rows[i].hash : MORE, (range) => Array.from({ length: range.end - range.start }, (_, k) => item(range.start + k))).size_full()
          .on_item_click((key, cx) => this.rowClick(key, cx))
          .on_item_secondary_click((key) => this.rowMenu(key)))
        .child(Scrollbar.vertical("graph").viewport_from_layout().absolute().inset_0()));
  }

  fileRow(f, picked, t, onPick, stage) {
    const parts = f.path.split("/"), name = parts.pop();
    return h_flex().id(`file-${f.path}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer().when(picked, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => onPick(cx))
      .when(Boolean(stage), (e) => e.child(div().id(`stage-${f.path}`).w(16).h(16).flex_none().flex().items_center().justify_center().rounded(4).border_1().border_color(f.staged ? t.accent : t.border).text_size(10).text_color(t.accent).cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); stage(cx); }).child(f.staged ? "✓" : "")))
      .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  // A file list scrolling inside a box of its own height that clips it, so the diff below never draws over its last rows.
  fileList(id, max, rows) {
    return div().flex_none().h(Math.min(max, rows.length * 26 + 8)).overflow_hidden()
      .child(v_flex().id(id).size_full().overflow_y_scrollbar().p(4).children(rows));
  }

  currentFiles(t) {
    const rows = this.files.map((f) => this.fileRow(f, this.open === f.path, t, (cx) => this.pick(f.path, cx),
      (cx) => this.act("Stage", f.staged ? (this.hasHead ? ["restore", "--staged", "--", f.path] : ["rm", "--cached", "--", f.path]) : ["add", "--", f.path], cx)));
    if (this.limited) rows.push(div().h(26).flex_none().px(8).flex().items_center().text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files"));
    return this.fileList("current-files", 180, rows).border_b(1).border_color(t.border);
  }

  commitDetails(t) {
    const row = this.graph?.rows.find((r) => r.hash === this.selected), info = this.details.get(this.selected);
    if (!row) return div();
    const meta = (label, value, colour) => h_flex().gap(8).child(div().w(58).flex_none().text_color(t.dim).child(label)).child(div().flex_1().min_w(0).truncate().text_color(colour ?? t.muted).child(value));
    return v_flex().flex_none().border_b(1).border_color(t.border)
      .child(v_flex().id("commit-meta").flex_none().px(12).py(8).gap(3).text_size(11.5)
        .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(row.subject))
        .when(Boolean(info?.body), (e) => e.child(v_flex().pb(4).text_color(t.muted).children(info.body.split("\n").slice(0, 6).map((line, i) => {
          const link = this.tracker && ticketLink(line, this.tracker);
          return link
            ? div().id(`ticket-${i}`).truncate().text_color(t.accent).cursor_pointer().hover((s) => s.text_color(t.foreground)).tooltip(`Open in ${link.where}`).on_click((_e, cx) => cx.open_url(link.url)).child(line)
            : div().child(line || " ");
        }))))
        .child(h_flex().id("hash").gap(8).cursor_pointer().on_click((_e, cx) => act("copy-hash", { type: "commit", hash: row.hash }, this.repo(), cx)).tooltip("Copy the hash")
          .child(div().w(58).flex_none().text_color(t.dim).child("Commit")).child(div().font_family("JetBrains Mono").text_color(t.accent).child(row.hash)))
        .when(row.parents.length > 0, (e) => e.child(meta("Parents", row.parents.map((p) => p.slice(0, 8)).join(", "))))
        .child(meta("Author", `${row.author} <${row.email}>`))
        .when(Boolean(info?.committer), (e) => e.child(meta("Committer", info.committer)))
        .child(meta("Date", `${fullDate(row.ts)} · ${shortAge(row.ts)}`))
        .when(Boolean(this.reviews?.get(row.hash)), (e) => {
          const review = this.reviews.get(row.hash);
          return e.child(h_flex().id("in-review").gap(8).cursor_pointer().tooltip("Open it in the Review tab").on_click(() => openReview({ item: review.key, commit: row.hash, root: this.root }))
            .child(div().w(58).flex_none().text_color(t.dim).child("Review"))
            .child(div().text_color(review.open ? t.ansi3 : review.approved ? t.ansi2 : t.accent).child(review.open ? `${review.label} · ${review.open} open ${review.open === 1 ? "note" : "notes"}` : review.approved ? `${review.label} · approved` : review.label)));
        }))
      .child(info
        ? this.fileList("commit-files", 130, info.files.map((f) => this.fileRow(f, this.commitFile === f.path, t, (cx) => this.pickCommitFile(f.path, cx))))
        : div().px(12).pb(8).text_size(11).text_color(t.dim).child("Loading files…"));
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(text);
    return h_flex().w_full().h(20).flex_none().gap(10).when(kind === "+", (e) => e.bg(t.ansi2 + "18")).when(kind === "-", (e) => e.bg(t.ansi1 + "18"))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  // The repos of the folder's family, each with its uncommitted files: a docker checkout and the app repos it holds.
  repoSwitch(t) {
    const { family, changed, shown } = this.family;
    return h_flex().id("repos").h(34).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border).overflow_x_scrollbar()
      .children(family.repos.map((repo) => {
        const on = repo === shown, count = changed[repo] ?? 0;
        return h_flex().id(`repo-${repo}`).h(24).px(9).gap(6).flex_none().items_center().rounded(6).text_size(12).cursor_pointer()
          .when(on, (e) => e.bg(t.raised).border_1().border_color(t.border)).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
          .tooltip(repo).on_click(() => { if (!on) this.showRepo(repo); })
          .child(div().child(repoName(family, repo)))
          .when(count > 0, (e) => e.child(div().px(5).rounded(4).bg(t.ansi3 + "26").text_color(t.ansi3).text_size(10.5).child(String(count))));
      }));
  }

  button(id, label, onClick, t, strong = false) {
    return div().id(id).h(26).px(9).flex().flex_none().items_center().rounded(6).bg(strong ? t.solid : t.raised).text_color(strong ? t.solid_foreground : t.foreground).text_size(12).cursor_pointer().on_click((_e, cx) => onClick(cx)).child(label);
  }

  render(cx) {
    if (this.overlay) return this.overlay.render(cx);
    if (key() !== this.context) this.refresh(cx);
    if (shared(CHANGED) !== this.changedSeen) { this.changedSeen = shared(CHANGED); this.refresh(cx); }
    const t = theme(), { scope, remotes } = this.graphSettings, current = this.selected === CURRENT;
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const segment = (id, label, on, onClick) => div().id(id).h(22).px(9).flex().items_center().rounded(5).text_size(11.5).cursor_pointer().when(on, (e) => e.bg(t.raised).border_1().border_color(t.border)).text_color(on ? t.foreground : t.muted).on_click((_e, cx) => onClick(cx)).child(label);
    return v_flex().id("changes").relative().size_full().min_h(0).rounded(4).overflow_hidden().bg(t.chrome).border_1().border_color(t.border).child(div().absolute().top(0).left(20).w(32).h(1).bg(t.accent)).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_size_change((size, cx) => { const h = size.height / (Number(settings().zoom) || 1); if (Math.abs(h - this.height) > 1) { this.height = h; cx.notify(); } })
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .when(Boolean(this.family), (e) => e.child(this.repoSwitch(t)))
      .child(h_flex().h(42).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().id("branch").h(26).px(10).flex().items_center().gap(5).rounded(6).border_1().border_color(this.picking ? t.accent : t.border).text_size(12).text_color(t.accent).cursor_pointer().on_click((_e, cx) => { this.picking = !this.picking; cx.notify(); })
          .child(svg(ICON("branch")).size(12)).child(div().max_w(160).truncate().child(this.branch ?? (this.headHash ? `detached at ${this.headHash.slice(0, 8)}` : ""))))
        .child(div().flex_1())
        .when(this.remotes.length > 0, (e) => e.child(this.button("fetch", this.busy ? "…" : "Fetch", (cx) => this.act("Fetch", ["fetch", "--all", "--prune"], cx), t)))
        .child(this.button("pull", this.behind ? `Pull ↓${this.behind}` : "Pull", (cx) => this.act("Pull", ["pull", "--ff-only"], cx), t))
        .child(this.button("push", this.ahead ? `Push ↑${this.ahead}` : "Push", (cx) => this.act("Push", this.hasUpstream ? ["push"] : ["push", "-u", "origin", "HEAD"], cx), t, Boolean(this.ahead || (!this.hasUpstream && this.remotes.length)))))
      .child(h_flex().flex_none().h(34).px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .child(segment("scope-all", "All branches", scope !== "current", (cx) => this.setting({ scope: "all" }, cx)))
        .child(segment("scope-current", "Current", scope === "current", (cx) => this.setting({ scope: "current" }, cx)))
        .when(this.remotes.length > 0 && scope !== "current", (e) => e.child(h_flex().id("remotes").ml(8).gap(5).items_center().text_size(11.5).text_color(t.muted).cursor_pointer().on_click((_e, cx) => this.setting({ remotes: !remotes }, cx))
          .child(div().size(13).flex().items_center().justify_center().rounded(3).border_1().border_color(remotes ? t.accent : t.border).when(remotes, (x) => x.bg(t.accent)).text_size(9).text_color(t.background).child(remotes ? "✓" : ""))
          .child("Remotes")))
        .child(div().flex_1())
        .child(this.button("review", "Review", () => openReview({ root: this.root }), t))
        .child(this.button("stash", "Stash", (cx) => this.act("Stash", ["stash", "push", "-u"], cx), t))
        .child(this.button("pop", "Pop", (cx) => this.act("Pop", ["stash", "pop"], cx), t)))
      .when(this.picking, (e) => e.child(v_flex().id("branches").flex_none().max_h(180).overflow_y_scrollbar().p(6).gap(2).border_b(1).border_color(t.border)
        .children((this.branches ?? []).map((b) => div().id(`br-${b}`).h(26).px(8).flex().items_center().rounded(6).text_size(12).when(b === this.branch, (x) => x.text_color(t.accent)).cursor_pointer().hover((x) => x.bg(t.hover)).on_click((_e, cx) => this.act("Switch", ["switch", b], cx)).child(div().flex_1().child(b)).when(b !== this.branch, (x) => x.child(div().id(`merge-${b}`).px(6).rounded(4).text_size(11).text_color(t.muted).hover((y) => y.bg(t.raised)).on_click((_e, cx) => { cx.stop_propagation(); this.act("Merge", ["merge", b], cx); }).child("merge")))))
        .child(div().id("new-branch").h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.branchInput).h_full().text_size(12).text_color(t.foreground)))))
      .child(this.graphList(t))
      .when(current, (e) => e.child(this.currentFiles(t)))
      .when(!current, (e) => e.child(this.commitDetails(t)))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        .child(div().id("changes-diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("changes-diff", this.rows.length, 20, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((row) => this.diffRow(row, t))).size_full())))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0()))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .when(current, (e) => e.child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Working…" : this.files.some((f) => f.staged) ? "Commit staged" : "Commit all"))));
  }
}
