# herdr-mods

Two Herdr mods for following what your Claude Code agents commit:

- **git** replaces Herdr's Changes panel with a commit graph whose ticket lines link to their Tilid ticket or forge issue.
- **review** adds a Review tab to each space. Every commit a Claude makes lands there by itself, grouped by ticket into one net diff. You read the files, leave notes to send back to the Claude, then approve.

They come with the `review` CLI and a `review` skill for Claude Code, which Claude uses to describe a ticket, file loose commits under their tickets, work through your notes and take before and after screenshots.

## Requirements

Linux, Herdr, Claude Code, bun and git.

## Install

```sh
git clone https://github.com/Kayno0o/herdr-mods.git
cd herdr-mods
bun install
bun run setup
```

Keep the checkout where it is: the mods point into it. Run `bun run setup` again after every pull.

`setup` installs both mods, the `Ctrl+Shift+R` shortcut, the commit hook and the skill, then downloads the Chromium the screenshots use. It never replaces a shortcut you already bound. If your Herdr layout is one Herdr ships, `setup` prints the command that clones it: run it, then `setup` again.

## Use

`Ctrl+Shift+R` opens the current space's Review tab. For the rest, ask Claude: "describe ticket 1234", "file the loose commits", "take the screenshots of ticket 1234".

## Config

Everything specific to you lives in `~/.config/herdr-mods` (or `$HERDR_MODS_CONFIG`), never in the checkout. `config.json` is optional:

```json
{
  "tilid": {
    "defaultInstance": "acme",
    "reviewStatus": "In review",
    "afterReviewStatus": "Ready to ship"
  },
  "forge": {
    "hosts": ["git.example.org"],
    "links": { "git.home.lan": "https://git.example.org" }
  }
}
```

- `tilid.defaultInstance` is the `<instance>.tilid.io` of a `.tilidrc` that names none.
- With both statuses set, the Review tab offers to approve a ticket and move it in Tilid, signed in with the session the Tilid MCP keeps in `~/.tilid_tokens.json`.
- Ticket lines link to issues on any Forgejo or Gitea host that tea (`~/.config/tea/config.yml`) or gt (`~/.config/gitea-cli/hosts.yml`) is logged into, plus `forge.hosts`. `forge.links` gives the address to open for a host your remotes reach under another name.

`bun review/cli.ts trackers` prints the hosts and the instance the mods end up with.

## Screenshots

`review shoot` replays a ticket's screens before and after its change, on a stack whose repos it checks out itself. It needs:

- a preset per project in `~/.config/herdr-mods/presets/<project>.ts`, modelled on [shoot/example-preset.ts](shoot/example-preset.ts);
- the login accounts the presets read, in `~/.config/herdr-mods/.env`;
- a throwaway stack, never the one you work in: `shoot` runs migrations and never rolls them back. `wt` (`@kaynooo/cli-wt`) makes one per task; without it, pass the stack's folder and URL with `--stack <dir> --url <url>`.
