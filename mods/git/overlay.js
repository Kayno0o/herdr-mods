// The graph's right-click menu and the dialogs its actions ask, each opened as an overlay of this mod that runs the action on the repo it was given and tells every copy to read again.

import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, notify, openOverlay, closeOverlay, props, setShared } from "herdr";
import { menuFor, dialogFor, plan, invalid, initialValues, lastLines } from "./actions.js";

export const CHANGED = "git.changed";
const ROW = 28;
const SEP_H = 9;
const TITLE_H = 22;

// Runs a plan's steps on the repo, stopping at the first failure; null when it all went through, else git's last lines.
export async function runPlan(repo, p) {
  if (p.unmerged) {
    const r = await exec("git", ["ls-files", "--unmerged"], { cwd: repo.root, on: repo.on });
    if (r.stdout.trim()) return "Resolve the conflicts first: committing now would commit their markers";
  }
  for (const step of p.steps ?? []) {
    const r = await exec("git", step, { cwd: repo.root, on: repo.on });
    if (r.code !== 0) return lastLines(r.stderr || r.stdout) || `git ${step[0]} failed`;
  }
  setShared(CHANGED, Date.now());
  if (p.done) notify({ title: p.done, level: "success", timeout: 2500 });
  return null;
}

// What an action does when picked: a copy or a plan with no question runs at once, anything else opens its dialog.
export async function act(id, target, repo, cx) {
  const spec = dialogFor(id, target, repo.ctx);
  if (spec) { openDialog(id, target, repo); return null; }
  const p = plan(id, target, {}, repo.ctx);
  if (p.copy !== undefined) { cx.write_to_clipboard(p.copy); notify({ title: "Copied", level: "success", timeout: 1500 }); return null; }
  const error = await runPlan(repo, p);
  if (error) notify({ title: "Git", body: error, level: "error" });
  return error;
}

// A menu is one section per thing the row holds (its commit, then each branch, remote branch and tag on it), each titled when there are several.
export function openMenu(sections, repo) {
  const titled = sections.length > 1;
  const height = sections.reduce((h, s, i) => menuFor(s.target, repo.ctx).reduce((h, item) => h + (item.sep ? SEP_H : ROW), h + (titled ? TITLE_H : 0) + (i ? SEP_H : 0)), 10);
  openOverlay({ mod: "git", kind: "popup", at: "pointer", width: 250, height, props: { menu: { sections, repo } } });
}

export function openDialog(id, target, repo) {
  openOverlay({ mod: "git", kind: "dialog", width: 420, props: { dialog: { id, target, repo } } });
}

export class Menu {
  constructor({ sections, repo }) {
    this.repo = repo;
    this.titled = sections.length > 1;
    this.sections = sections.map((s) => ({ ...s, items: menuFor(s.target, repo.ctx) }));
  }

  pick(item, target, cx) {
    closeOverlay(props().overlay);
    act(item.id, target, this.repo, cx);
  }

  render(_cx) {
    const t = theme();
    const sep = () => div().h(SEP_H).flex_none().flex().items_center().child(div().w_full().h(1).bg(t.border));
    return v_flex().id("git-menu").w_full().p(5).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .children(this.sections.flatMap((s, k) => [
        ...(k ? [sep()] : []),
        ...(this.titled ? [div().h(TITLE_H).flex_none().px(10).flex().items_center().text_size(11).text_color(t.dim).truncate().child(s.title)] : []),
        ...s.items.map((item, i) => item.sep ? sep()
          : h_flex().id(`item-${k}-${i}`).h(ROW).flex_none().px(10).items_center().rounded(7).cursor_pointer().hover((x) => x.bg(t.hover))
            .text_color(item.danger ? t.ansi1 : t.foreground).on_click((_e, cx) => this.pick(item, s.target, cx)).child(item.label)),
      ]));
  }
}

export class Dialog {
  constructor({ id, target, repo }, cx) {
    this.id = id; this.target = target; this.repo = repo;
    this.spec = dialogFor(id, target, repo.ctx);
    this.values = initialValues(this.spec);
    this.error = null; this.busy = false;
    this.inputs = (this.spec.fields ?? []).map((field) => {
      const input = InputState.new({ placeholder: field.label });
      input.set_value(field.value ?? "");
      input.on("change", () => { this.values[field.name] = input.value(); });
      input.on("submit", (_e, cx) => this.submit(cx));
      return input;
    });
    if (this.inputs[0]) { this.inputs[0].focus(); cx.timer.after(300, () => this.inputs[0].focus()); }
  }

  submit(cx) {
    if (this.busy) return;
    this.error = invalid(this.spec, this.values);
    if (this.error) { cx.notify(); return; }
    this.busy = true;
    cx.spawn(async (cx) => {
      const error = await runPlan(this.repo, plan(this.id, this.target, this.values, this.repo.ctx));
      this.busy = false;
      if (error) { this.error = error; cx.notify(); return; }
      closeOverlay(props().overlay);
    });
    cx.notify();
  }

  render() {
    const t = theme(), spec = this.spec;
    const danger = spec.danger || spec.modes?.find((m) => m.name === this.values.mode)?.danger;
    const box = (on) => div().size(13).flex_none().flex().items_center().justify_center().rounded(3).border_1().border_color(on ? t.accent : t.border).when(on, (e) => e.bg(t.accent)).text_size(9).text_color(t.background).child(on ? "✓" : "");
    return v_flex().id("git-dialog").w_full().p(18).gap(12).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(spec.title)).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().text_color(t.muted).child(spec.text))
      .children((spec.fields ?? []).map((field, i) => v_flex().gap(5)
        .child(div().text_size(11).text_color(t.dim).child(field.label))
        .child(div().id(`field-${field.name}`).h(36).px(10).flex().items_center().rounded(9).border_1().border_color(t.border).cursor_text().child(Input.new(this.inputs[i]).h_full().text_size(12.5).text_color(t.foreground)))))
      .children((spec.modes ?? []).map((mode) => {
        const on = this.values.mode === mode.name, colour = mode.danger ? t.ansi1 : t.accent;
        return h_flex().id(`mode-${mode.name}`).h(34).px(10).gap(10).items_center().rounded(8).border_1().border_color(on ? colour : t.border).cursor_pointer()
          .on_click((_e, cx) => { this.values.mode = mode.name; cx.notify(); })
          .child(div().size(12).flex_none().rounded(6).border_1().border_color(on ? colour : t.dim).when(on, (e) => e.bg(colour)))
          .child(div().text_color(mode.danger && on ? t.ansi1 : t.foreground).child(mode.label));
      }))
      .children((spec.checks ?? []).map((check) => h_flex().id(`check-${check.name}`).gap(8).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.values[check.name] = !this.values[check.name]; cx.notify(); })
        .child(box(this.values[check.name])).child(div().child(check.label))))
      .when(Boolean(this.error), (e) => e.child(div().text_size(11.5).text_color(t.ansi1).child(this.error)))
      .child(h_flex().gap(8).justify_end()
        .child(div().id("cancel").h(30).px(12).flex().items_center().rounded(8).bg(t.raised).cursor_pointer().on_click(() => closeOverlay(props().overlay)).child("Cancel"))
        .child(div().id("run").h(30).px(14).flex().items_center().rounded(8).bg(danger ? t.ansi1 : t.solid).text_color(danger ? t.background : t.solid_foreground).cursor_pointer()
          .on_click((_e, cx) => this.submit(cx)).child(this.busy ? "Working…" : spec.action)));
  }
}
