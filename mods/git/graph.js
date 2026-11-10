// The commit graph's data: the log as git prints it, each commit's lane and the strokes around its dot, its labels and its age.

export const CURRENT = "current";
export const MAX_LANES = 10;
export const LOG_FORMAT = "%x1f%H%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%at%x1f%D";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// All branches walks the refs it shows rather than --all, which also walks other tools' refs (stash, checkpoints); one past the page says whether there is more.
export function logArgs({ scope, remotes, limit }) {
  const refs = scope === "current" ? ["HEAD"] : ["--branches", "--tags", ...(remotes ? ["--remotes"] : []), "HEAD"];
  return ["log", "--date-order", "--decorate=full", "-n", String(limit + 1), `--format=${LOG_FORMAT}`, ...refs, "--"];
}

export function parseLog(stdout, limit) {
  const commits = stdout.split("\n").filter(Boolean).map((line) => {
    const [, hash, parents, subject, author, email, ts, refs] = line.split("\x1f");
    return { hash, parents: parents ? parents.split(" ") : [], subject, author, email, ts: Number(ts) || 0, refs: refs ?? "" };
  });
  return { commits: commits.slice(0, limit), more: commits.length > limit };
}

// Puts each commit (newest first, a child before its parents) on a lane. A lane waits for the commit it leads to; a commit takes the first lane waiting for it and the others curve into its dot; its first parent keeps its lane, a merge's other parents curve out to a lane already waiting for them or a free one.
// Each row lists its strokes as [x1, y1, x2, y2, colour lane, dashed], x in lanes and y in rows (0 top, 0.5 the dot, 1 bottom); the current row's lane down to HEAD is dashed.
export function lanesOf(commits) {
  const lanes = [];
  let width = 1;
  const rows = commits.map((c) => {
    const before = lanes.slice();
    const dashed = c.current ? 1 : 0;
    let col = lanes.findIndex((l) => l?.hash === c.hash);
    const joins = [];
    lanes.forEach((l, i) => { if (l?.hash === c.hash && i !== col) joins.push(i); });
    if (col < 0) { col = lanes.indexOf(null); if (col < 0) col = lanes.length; }
    for (const i of joins) lanes[i] = null;
    lanes[col] = null;
    const segs = [];
    before.forEach((l, i) => { if (l && i !== col && !joins.includes(i)) segs.push([i, 0, i, 1, i, l.dashed]); });
    if (before[col]) segs.push([col, 0, col, 0.5, col, before[col].dashed]);
    for (const i of joins) segs.push([i, 0, col, 0.5, i, before[i].dashed]);
    c.parents.forEach((parent, k) => {
      let at = k === 0 ? col : lanes.findIndex((l) => l?.hash === parent);
      if (at < 0) { at = lanes.indexOf(null); if (at < 0) at = lanes.length; }
      if (!lanes[at]) lanes[at] = { hash: parent, dashed };
      segs.push([col, 0.5, at, 1, at, dashed]);
    });
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    const n = Math.max(before.length, lanes.length, col + 1);
    width = Math.max(width, n);
    return { ...c, col, n, segs, merge: c.parents.length > 1 };
  });
  return { rows, width: Math.min(width, MAX_LANES) };
}

// A remote branch's remote is the longest remote name its path starts with, since a remote's name may hold a slash.
function splitRemote(path, remotes) {
  const remote = remotes.filter((r) => path.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0] ?? path.split("/")[0];
  return { remote, branch: path.slice(remote.length + 1) };
}

/** @typedef {{ kind: "head" | "branch" | "remote" | "tag", name?: string, head?: boolean, remotes?: string[], remote?: string, branch?: string }} Label */

// The labels of a commit from git's full decoration: a detached HEAD first, the checked-out branch, the other local branches with their same-named remotes riding on them, remote-only branches, then tags.
/** @returns {Label[]} */
export function labelsOf(refs, remotes) {
  let detached = false, head = null;
  const locals = [], remote = [], tags = [];
  for (const ref of refs ? refs.split(", ") : []) {
    if (ref === "HEAD") detached = true;
    else if (ref.startsWith("HEAD -> refs/heads/")) head = ref.slice(19);
    else if (ref.startsWith("tag: refs/tags/")) tags.push(ref.slice(15));
    else if (ref.startsWith("refs/heads/")) locals.push(ref.slice(11));
    else if (ref.startsWith("refs/remotes/") && !ref.endsWith("/HEAD")) remote.push(ref.slice(13));
  }
  const branches = [...(head === null ? [] : [head]), ...locals];
  const riding = new Set();
  /** @type {Label[]} */
  const labels = [];
  if (detached) labels.push({ kind: "head" });
  for (const name of branches) {
    const with_ = [];
    for (const path of remote) {
      const split = splitRemote(path, remotes);
      if (split.branch === name) { with_.push(split.remote); riding.add(path); }
    }
    labels.push({ kind: "branch", name, head: name === head, remotes: with_ });
  }
  for (const path of remote) if (!riding.has(path)) labels.push({ kind: "remote", name: path, ...splitRemote(path, remotes) });
  for (const name of tags) labels.push({ kind: "tag", name });
  return labels;
}

export function shortAge(ts, now = Date.now() / 1000) {
  const s = now - ts;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  const d = new Date(ts * 1000), today = new Date(now * 1000);
  return d.getFullYear() === today.getFullYear() ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function fullDate(ts) {
  const d = new Date(ts * 1000), two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

// Numbers each diff line once, so a frame only draws the rows on screen.
export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") { old++; return { kind, number: next++, text: line.slice(1) || " " }; }
    return { kind: "", text: line };
  });
}

// `git diff --numstat -z` (without renames) as added and removed lines by path; several outputs add up.
export function numstat(outputs) {
  const stats = {};
  for (const stdout of outputs) {
    for (const entry of stdout.split("\0")) {
      const [a, d, ...parts] = entry.split("\t");
      if (!parts.length) continue;
      const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
      stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
    }
  }
  return stats;
}

// `git grep --untracked -c -I -z ''` as line counts by path, which `git diff --numstat` leaves out for untracked files; binaries and empty files print nothing.
export function lineCounts(stdout) {
  const counts = {};
  for (const line of stdout.split("\n")) {
    const [path, count] = line.split("\0");
    if (path && count) counts[path] = { add: Number(count) || 0, del: 0, binary: false };
  }
  return counts;
}

const TICKET_LINE = /^(?:([\w.-]+\/[\w.-]+))?#(\d+) - \S/;
// An origin's host and owner/repo, over ssh (scp-like or ssh://, a port either way) or http(s).
const REMOTE = /^(?:[\w.-]+@|ssh:\/\/(?:[\w.-]+@)?|https?:\/\/(?:[^@/]+@)?)([\w.-]+)(?::\d+)?[:/](?:\d+\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;

// Prints the first .tilidrc above the repo, else above its main checkout (a worktree's own folder may sit under /tmp), as Tilid's CLIs look it up.
export const FIND_TILIDRC = `for d in "$PWD" "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo /)")"; do
  while :; do
    if [ -f "$d/.tilidrc" ]; then cat "$d/.tilidrc"; exit 0; fi
    [ "$d" = / ] && break
    d=$(dirname "$d")
  done
done`;

// A .tilidrc's project page: its `project` is the project's code, on its `instance`, else the one `review trackers` names.
/** @param {string | null} [defaultInstance] */
export function tilidUrl(rc, defaultInstance = null) {
  const values = Object.fromEntries((rc ?? "").split("\n").map((line) => line.trim().match(/^(\w+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  const instance = values.instance || defaultInstance;
  return values.project && instance ? `https://${instance}.tilid.io/project/${encodeURIComponent(values.project)}` : null;
}

// Where a commit's ticket lines lead: the Tilid project of the repo's .tilidrc, else its repo on a known forge, `forges` mapping each host to its web address.
export function trackerOf(tilidUrl, origin, forges = {}) {
  const [, host, repo] = REMOTE.exec(origin.trim()) ?? [];
  const web = host && forges[host.toLowerCase()];
  return { tilid: tilidUrl || null, forge: web ? { web, repo, name: new URL(web).host } : null };
}

// A body line naming a ticket (`#1525 - [UC] title`, `owner/repo#12 - title` for another repo on the same forge) and the page it opens, else null.
export function ticketLink(line, tracker) {
  const match = TICKET_LINE.exec(line.trim());
  if (!match) return null;
  const [, repo, number] = match;
  const { forge } = tracker;
  if (repo) return forge ? { url: `${forge.web}/${repo}/issues/${number}`, where: forge.name } : null;
  if (tracker.tilid) return { url: `${tracker.tilid}?ticket=${number}`, where: "Tilid" };
  if (forge) return { url: `${forge.web}/${forge.repo}/issues/${number}`, where: forge.name };
  return null;
}
