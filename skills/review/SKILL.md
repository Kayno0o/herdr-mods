---
name: review
description: >-
  Work on the review inboxes Herdr's Review tab shows: describe a ticket or a loose commit, file loose commits under their tickets, add review notes, take before and after screenshots of the screens a ticket changes, and act on the open notes the user sends back. Use whenever asked to review, describe or screenshot a ticket or commits, to prepare a review, to generate a diff or a review for a day, or when handed a brief of review notes.
---

# Review inboxes

`review` below stands for `{{CLI}}`, run from any folder. `review help` lists every command.

Each project has one inbox, `{{REVIEWS}}/<project>/inbox.json`, the project being the Tilid code of the `.tilidrc` above the repo, else the repo's folder. It lists every ticket and loose commit the user has not approved yet. A ticket gathers the commits naming it, fixups and rebased copies folded in, and shows as one net diff. A commit naming no ticket is a loose item, keyed by its sha.

A Claude Code hook files each commit a Claude makes, and the Review tab files the branch's other unpushed commits when it opens. So there is nothing to generate: a request to "generate the review of today" means describing and screenshotting what the inbox already holds. `review sync --repo <dir>` files what is missing by hand.

Never edit `inbox.json` yourself: every change goes through `review`, which locks the file against the Review tab and other agents.

## Reading

```bash
review inbox <project>            # or --repo <dir>: tickets and loose commits, read progress, open notes
review show <project> <item>      # the item's net diff with its notes; --commit <sha> for one commit
```

An item is `#13859` (or `13859`) or the start of a loose commit's sha. Where intent is not obvious from the hunks, read the file at that commit: `git -C <repo> show <sha>:<path>`. A description written off the patch alone is usually wrong about why.

## Describing

```bash
review prose <project> <item> "<text>"
review file <project> <sha> "#13859 - [USE_CASE] Ticket title"   # file a loose commit under its ticket, `none` to unfile it
```

Prose is in the user's language, markdown, backticks for identifiers. One to three sentences on the whole item, across its commits and repos: what was wrong or asked, what changes. Never restate the diff, the reader sees the lines. File a loose commit only under the ticket it really belongs to, its title copied from Tilid.

## Notes

```bash
review note <project> <item> <path> "<body>" --at "<text of the line>"
```

`--at` is a piece of a line the diff shows, copied without its `+`/`-`/space prefix: the first added or unchanged line holding it wins, else the first removed one, so make it long enough to be unique. `--line <n> --side old|new` anchors on an exact line instead, and neither notes the whole file.

Notes are exceptions, not coverage: roughly one per three or four changed files, only where a reader would stumble (an ordering constraint, a fragile branch, a real risk), never one that paraphrases its line. One or two sentences, in the user's language.

## The user's notes

The user comments in the Review tab, then sends the open notes to a Claude as a brief: `review brief <project> [<item>...]` prints the same. Fix each point in the repo it names, then mark the notes you handled with the `review resolve` command the brief ends on. Leave the others open and say which and why. Approving, rejecting and reading files are the user's, never yours.

## Screenshots

A ticket that changes what a screen shows gets before and after captures; a refactor, a test, a rename or an API-only change gets none.

**The stack.** Captures need a stack you may drive, never the user's own: `wt add <task>` gives a disposable one with its own database and subdomain; where `wt` is not installed, ask the user for a disposable stack's folder and URL and pass both with `--stack` and `--url`. A `shot` worktree (`wt add shot`, `wt path shot` gives its folder) is yours outright: start it, stop it, rebuild it, reset its data, without asking. Any other stack stays the user's to start: hand them the command and wait. `shoot` checks the stack's repos out and runs the preset's hooks (install, migrate, build), so migrations are never rolled back: that is why the stack is disposable.

**The scenario** is `{{REVIEWS}}/<project>/scenarios/<ticket number or sha>.ts`, one per item. Each shot is one screen state worth comparing, with a short `label` in the user's language, the `route` from the app's base URL and the `steps` that bring the screen to that state:

```ts
import { defineScenario } from '{{REPO}}/shoot/types'

export default defineScenario({
  shots: [
    {
      label: 'Order summary: the discount row',
      route: '/orders/1042',
      fullPage: true,
      async steps({ page, side }) {
        await page.getByRole('tab', { name: 'Summary', exact: true }).click()
        if (side === 'after')
          await page.getByText('Discount').waitFor()
      },
    },
  ],
})
```

- The before side is the parent of the item's oldest commit in each repo, the after side its newest commit: the item's net change, like its diff.
- Locate by the role and the text the diff names, not by CSS class: a class the change renamed makes the sides differ for the wrong reason.
- `viewport` defaults to 1440x900, which crops a wide grid: size it to what the change is about. `video: true` only for a behaviour rather than a look.
- A Vuetify tooltip opens on two real `page.mouse.move` calls, never a forced hover, and a disabled element takes no pointer event: aim at its wrapper.
- Wait for the new state only on `side === 'after'`: the before side does not have it.
- A helper taking the page types it with `Page` from the same `shoot/types`: `playwright-core` does not resolve from the reviews folder.

**Run it**, `--dry-run` first to see the revisions and the shot ids:

```bash
review shoot <project> <item> --stack <stack-dir> --dry-run
review shoot <project> <item> --stack <stack-dir>
review shoot <project> <item> --stack <stack-dir> --only "<label>"   # iterate on one shot
review shoot <project> <item> --stack <stack-dir> --failed --keep    # retake what failed; --keep, on the shot stack only, skips putting it back
review shoot <project> <item> --stack <stack-dir> --url <base-url>   # a stack wt did not make
```

The project needs a preset in `{{CONFIG}}/presets/<project>.ts` (base URL, login, readiness wait, checkout hooks, browser locale), and the login account in `{{CONFIG}}/.env` (the keys the preset names). A new project gets a preset modelled on the closest one there, else on `{{REPO}}/shoot/example-preset.ts`.

Shots land in the inbox at once, shown in the ticket's header. A shot whose label leaves the scenario is dropped at the next run. Screenshots taken some other way go in with `review shot <project> <item> --label "<l>" --route <r> --before <png> --after <png>`.

**Then look at every image you produced.** A run that reports `ok` proves nothing on its own. Read each file and check three things: the two sides differ, and in the way the change claims; the frame holds the whole thing the change is about; nothing else on screen is broken. A capture showing the change off-screen or at the wrong size is a bad capture: fix the viewport or the steps and shoot again. That last check finds real bugs, a label clipped by an `overflow` wrapper being the usual kind: tell the user what and where, and whether the item introduced it.

A failed shot keeps its screenshot and its error, which usually says why.

## Handing over

Say which items you described or shot and what each pair shows, in a line or two. The user reads them in Herdr's Review tab (Ctrl+Shift+R).
