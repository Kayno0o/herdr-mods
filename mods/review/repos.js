// A docker checkout often holds the app's own repos as gitignored folders (shop-docker/shop): its family is the outer repo and the ones nested up to three levels below it, and the Changes pane and the Review tab show the one picked among them.
// Kept identical in mods/git and mods/review, since a mod cannot import from another's folder.

// shared(PICKS)[`${machine}:${found}`] is the family member last picked, by either mod, while the focus was in the repo `found`.
export const PICKS = "git.repo";

// Every .git below the folder, dependencies and dot folders (worktrees, caches) left out.
export const NESTED = "find . -maxdepth 4 \\( -name node_modules -o -name vendor -o -name var -o \\( -name '.?*' ! -name .git \\) \\) -prune -o -name .git -print";

export const pickKey = (on, found) => `${on ?? ""}:${found}`;

// The folder the focus is in: the focused terminal's; with a mod pane focused (the Git or Review tab itself, which has none), the space's latest agent's, else one of its terminals', else the space's own folder.
export function folderOf(space, f, panes, agents) {
  const pane = f?.pane ? panes.find((p) => p.pane === f.pane) : null;
  if (pane?.cwd || f?.cwd) return pane?.cwd || f.cwd;
  const tabs = new Set((space?.tabs ?? []).map((t) => t.id));
  const cwds = new Map(panes.filter((p) => tabs.has(p.tab) && p.cwd).map((p) => [p.pane, p.cwd]));
  const agent = agents.filter((a) => cwds.has(a.pane)).sort((a, b) => b.seq - a.seq)[0];
  return cwds.get(agent?.pane) ?? cwds.values().next().value ?? space?.folder;
}

// The family of the repo `found` holds: the repo around it, when it is itself nested, else itself; then each repo nested in that one.
export async function familyOf(found, run) {
  const up = await run("git", ["rev-parse", "--show-toplevel"], `${found}/..`);
  const outer = up.code === 0 ? up.stdout.trim() : found;
  const listed = await run("sh", ["-c", NESTED], outer);
  const nested = listed.code === 0 ? listed.stdout.split("\n").filter((p) => p.startsWith("./") && p !== "./.git").map((p) => `${outer}/${p.slice(2, -"/.git".length)}`) : [];
  return { outer, repos: [outer, ...nested.sort()] };
}

// Which member to show: the one picked last from where the focus is, else the nested one the focus is in, else the one with the most uncommitted files (the outer one when none has any).
export function choose(family, found, picked, changed) {
  if (picked && family.repos.includes(picked)) return picked;
  if (found !== family.outer) return found;
  return family.repos.reduce((best, repo) => (changed[repo] ?? 0) > (changed[best] ?? 0) ? repo : best, family.outer);
}

const FAMILY_MS = 60000;
// A status that writes nothing under .git, so a folder watch on the repo does not see it.
const STATUS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=normal"];

// The member to show from the repo `found` and each member's uncommitted file count; the family is looked up again after a minute, kept in `cache` meanwhile.
export async function pickRepo(found, run, picks, cache, on = null) {
  const at = pickKey(on, found);
  let held = cache.get(at);
  if (!held || Date.now() - held.at > FAMILY_MS) {
    held = { family: await familyOf(found, run), at: Date.now() };
    cache.set(at, held);
  }
  const family = held.family;
  if (family.repos.length < 2) return { family: null, changed: {}, at, shown: found };
  const counts = await Promise.all(family.repos.map((repo) => run("git", STATUS, repo)));
  const changed = Object.fromEntries(family.repos.map((repo, i) => [repo, counts[i].code === 0 ? counts[i].stdout.split("\0").filter(Boolean).length : 0]));
  return { family, changed, at, shown: choose(family, found, picks?.[at], changed) };
}

export const repoName = (family, repo) => repo === family.outer ? repo.slice(repo.lastIndexOf("/") + 1) : repo.slice(family.outer.length + 1);
