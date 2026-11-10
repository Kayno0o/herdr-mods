// What a right-click on the graph offers, the dialog an action asks first, and the git commands it runs.
// A target is { type: "branch", name, head, remotes } | { type: "remote", name, remote, branch, local } | { type: "tag", name } | { type: "commit", hash, subject, head, merge } | { type: "current", staged }; ctx is { branch, remotes }.

const SEP = { id: "", label: "", danger: false, sep: true };
const item = (id, label, danger = false) => ({ id, label, danger, sep: false });
const short = (hash) => hash.slice(0, 8);
const onto = (ctx) => ctx.branch ?? "HEAD";

export function menuFor(target, ctx) {
  const remote = ctx.remotes.length > 0;
  switch (target.type) {
    case "branch": return [
      ...(target.head ? [] : [item("checkout", "Checkout")]),
      item("rename", "Rename…"),
      ...(target.head ? [] : [item("delete-branch", "Delete…", true)]),
      SEP,
      ...(target.head ? [] : [item("merge", `Merge into ${onto(ctx)}…`), item("rebase", `Rebase ${onto(ctx)} on it…`)]),
      ...(remote ? [item("push", "Push…")] : []),
      SEP,
      item("copy-name", "Copy name"),
    ];
    case "remote": return [
      item("checkout-remote", "Checkout…"),
      item("merge", `Merge into ${onto(ctx)}…`),
      item("delete-remote", "Delete remote branch…", true),
      SEP,
      item("copy-name", "Copy name"),
    ];
    case "tag": return [
      ...(remote ? [item("push-tag", "Push…")] : []),
      item("delete-tag", "Delete…", true),
      SEP,
      item("copy-name", "Copy name"),
    ];
    case "commit": return [
      item("tag", "Add tag…"),
      item("branch", "Create branch…"),
      ...(target.head ? [] : [item("checkout-commit", "Checkout…")]),
      SEP,
      ...(target.head ? [] : [item("cherry-pick", "Cherry pick…")]),
      item("revert", "Revert…"),
      ...(target.head ? [] : [item("merge", `Merge into ${onto(ctx)}…`), item("rebase", `Rebase ${onto(ctx)} on it…`)]),
      item("reset", `Reset ${onto(ctx)} to here…`, true),
      SEP,
      item("copy-hash", "Copy hash"),
      item("copy-subject", "Copy subject"),
    ];
    case "current": return [
      item("commit", "Commit…"),
      item("stash", "Stash…"),
      item("reset-current", "Reset uncommitted changes…", true),
    ];
  }
  return [];
}

// What a merge, rebase or cherry pick takes as its argument.
function refOf(target) {
  if (target.type === "commit") return target.hash;
  return target.name;
}

function describe(target) {
  if (target.type === "commit") return `${short(target.hash)} "${target.subject}"`;
  return target.name;
}

// null when the action runs at once; otherwise what its dialog asks.
export function dialogFor(id, target, ctx) {
  const remotes = ctx.remotes.map((name) => ({ name, label: name }));
  const what = describe(target);
  switch (id) {
    case "rename": return { title: "Rename branch", text: `Rename ${target.name} to:`, fields: [{ name: "name", label: "Name", value: target.name }], action: "Rename" };
    case "delete-branch": return { title: "Delete branch", text: `Delete the branch ${target.name}?`, checks: [{ name: "force", label: "Force, even if it isn't merged", value: false }], action: "Delete", danger: true };
    case "merge": return { title: "Merge", text: `Merge ${what} into ${onto(ctx)}?`, checks: [{ name: "noff", label: "Always create a merge commit (--no-ff)", value: false }], action: "Merge" };
    case "rebase": return { title: "Rebase", text: `Rebase ${onto(ctx)} on ${what}?`, action: "Rebase" };
    case "push": return { title: "Push branch", text: `Push ${target.name} to:`, modes: remotes, mode: ctx.remotes.includes("origin") ? "origin" : ctx.remotes[0], checks: [{ name: "upstream", label: "Set as its upstream", value: !target.remotes?.length }], action: "Push" };
    case "checkout-remote": return target.local ? null : { title: "Checkout remote branch", text: `Check ${target.name} out as a local branch tracking it:`, fields: [{ name: "name", label: "Local name", value: target.branch }], action: "Checkout" };
    case "delete-remote": return { title: "Delete remote branch", text: `Delete ${target.branch} on ${target.remote}? Everyone who pulls from ${target.remote} loses it.`, action: "Delete", danger: true };
    case "push-tag": return { title: "Push tag", text: `Push the tag ${target.name} to:`, modes: remotes, mode: ctx.remotes.includes("origin") ? "origin" : ctx.remotes[0], action: "Push" };
    case "delete-tag": return { title: "Delete tag", text: `Delete the tag ${target.name}?`, checks: ctx.remotes.length ? [{ name: "remote", label: `Delete it on ${ctx.remotes.includes("origin") ? "origin" : ctx.remotes[0]} too`, value: false }] : [], action: "Delete", danger: true };
    case "tag": return { title: "Add tag", text: `Tag ${what}:`, fields: [{ name: "name", label: "Name", value: "" }, { name: "message", label: "Message (makes it annotated)", value: "", optional: true, free: true }], action: "Add tag" };
    case "branch": return { title: "Create branch", text: `Create a branch at ${what}:`, fields: [{ name: "name", label: "Name", value: "" }], checks: [{ name: "checkout", label: "Check it out", value: true }], action: "Create" };
    case "checkout-commit": return { title: "Checkout commit", text: `Check out ${what}? HEAD is left detached from any branch.`, action: "Checkout" };
    case "cherry-pick": return { title: "Cherry pick", text: `Apply ${what} on ${onto(ctx)}?`, action: "Cherry pick" };
    case "revert": return { title: "Revert", text: `Add a commit undoing ${what}?`, action: "Revert" };
    case "reset": return { title: "Reset", text: `Move ${onto(ctx)} to ${what}:`, modes: [{ name: "soft", label: "Soft: keep the changes, staged" }, { name: "mixed", label: "Mixed: keep the changes, unstaged" }, { name: "hard", label: "Hard: discard the changes", danger: true }], mode: "mixed", action: "Reset" };
    case "commit": return { title: "Commit", text: "Commit the changes:", fields: [{ name: "message", label: "Message", value: "", free: true }], checks: [{ name: "all", label: "Stage every change first (untracked too)", value: !target.staged }], action: "Commit" };
    case "stash": return { title: "Stash", text: "Put the changes aside:", fields: [{ name: "message", label: "Message", value: "", optional: true, free: true }], checks: [{ name: "untracked", label: "Include untracked files", value: true }], action: "Stash" };
    case "reset-current": return { title: "Reset uncommitted changes", text: "Reset the changes of the working tree:", modes: [{ name: "mixed", label: "Mixed: unstage, keep the files as they are" }, { name: "hard", label: "Hard: discard every change to tracked files", danger: true }], mode: "mixed", action: "Reset" };
  }
  return null;
}

// A dialog's fields, checked: a name must be one word not starting with a dash; a message is free text.
export function invalid(spec, values) {
  for (const field of spec?.fields ?? []) {
    const value = (values[field.name] ?? "").trim();
    if (!value) { if (field.optional) continue; return `${field.label} is empty`; }
    if (!field.free && (/\s/.test(value) || value.startsWith("-"))) return `${field.label} can't hold spaces or start with -`;
  }
  return null;
}

// The commands an action runs (each stops the rest when it fails), what to copy instead, and the toast once done.
export function plan(id, target, values, ctx) {
  const v = (name) => (values[name] ?? "").trim();
  const merges = target.merge ? ["-m", "1"] : [];
  switch (id) {
    case "checkout": return { steps: [["switch", target.name]], done: `Checked out ${target.name}` };
    case "rename": return { steps: [["branch", "-m", target.name, v("name")]], done: `Renamed to ${v("name")}` };
    case "delete-branch": return { steps: [["branch", values.force ? "-D" : "-d", target.name]], done: `Deleted ${target.name}` };
    case "merge": return { steps: [["merge", "--no-edit", ...(values.noff ? ["--no-ff"] : []), refOf(target)]], done: `Merged ${describe(target)}` };
    case "rebase": return { steps: [["rebase", refOf(target)]], done: `Rebased ${onto(ctx)}` };
    case "push": return { steps: [["push", ...(values.upstream ? ["-u"] : []), values.mode, target.name]], done: `Pushed ${target.name}` };
    case "checkout-remote": return target.local
      ? { steps: [["switch", target.branch]], done: `Checked out ${target.branch}` }
      : { steps: [["switch", "-c", v("name"), "--track", target.name]], done: `Checked out ${v("name")}` };
    case "delete-remote": return { steps: [["push", target.remote, "--delete", target.branch]], done: `Deleted ${target.name}` };
    case "push-tag": return { steps: [["push", values.mode, `refs/tags/${target.name}`]], done: `Pushed ${target.name}` };
    case "delete-tag": {
      const remote = ctx.remotes.includes("origin") ? "origin" : ctx.remotes[0];
      return { steps: [["tag", "-d", target.name], ...(values.remote ? [["push", remote, "--delete", `refs/tags/${target.name}`]] : [])], done: `Deleted ${target.name}` };
    }
    case "tag": return { steps: [["tag", ...(v("message") ? ["-a", "-m", v("message")] : []), v("name"), target.hash]], done: `Tagged ${v("name")}` };
    case "branch": return { steps: [values.checkout ? ["switch", "-c", v("name"), target.hash] : ["branch", v("name"), target.hash]], done: `Created ${v("name")}` };
    case "checkout-commit": return { steps: [["switch", "--detach", target.hash]], done: `Checked out ${short(target.hash)}` };
    case "cherry-pick": return { steps: [["cherry-pick", ...merges, target.hash]], done: `Cherry picked ${short(target.hash)}` };
    case "revert": return { steps: [["revert", "--no-edit", ...merges, target.hash]], done: `Reverted ${short(target.hash)}` };
    case "reset": return { steps: [["reset", `--${values.mode}`, target.hash]], done: `Reset to ${short(target.hash)}` };
    case "commit": return { unmerged: values.all, steps: [...(values.all ? [["add", "--all"]] : []), ["commit", "-m", v("message")]], done: "Committed" };
    case "stash": return { steps: [["stash", "push", ...(values.untracked ? ["-u"] : []), ...(v("message") ? ["-m", v("message")] : [])]], done: "Stashed" };
    case "reset-current": return { steps: [["reset", `--${values.mode}`, "HEAD"]], done: "Reset" };
    case "copy-name": return { copy: target.name };
    case "copy-hash": return { copy: target.hash };
    case "copy-subject": return { copy: target.subject };
  }
  return { steps: [] };
}

// The values a dialog starts with.
export function initialValues(spec) {
  const values = {};
  for (const field of spec?.fields ?? []) values[field.name] = field.value ?? "";
  for (const check of spec?.checks ?? []) values[check.name] = Boolean(check.value);
  if (spec?.modes) values.mode = spec.mode ?? spec.modes[0]?.name;
  return values;
}

// git's last lines, hints dropped, for a failed step.
export function lastLines(text) {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("hint:")).slice(-4).join("\n");
}
