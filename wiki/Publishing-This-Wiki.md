# Publishing this wiki

The source of truth for these pages is **`wiki/` in the main repository**, not the wiki repository.
Edit there, review it in a pull request like anything else, then push.

## Why it works this way

A GitHub wiki is a separate git repository (`<repo>.wiki.git`) with no pull requests, no review and
no CI. That is exactly what makes it good for fast operational notes — and exactly what makes it a
bad place to be the only copy of anything. Keeping the source in `wiki/` gives the pages a diff, a
review and a history that survives the wiki being wiped or edited by mistake.

## One-time setup

The wiki repository only exists after at least one page has been created through the GitHub web UI.
Create a page there first, then:

```bash
git clone https://github.com/DresvyanskiyDenis/PiON.wiki.git ~/src/PiON.wiki
```

## Publishing

From the main repository:

```bash
WIKI=~/src/PiON.wiki

git -C "$WIKI" pull --ff-only
rsync -a --delete --exclude '.git' wiki/ "$WIKI"/
git -C "$WIKI" add -A
git -C "$WIKI" commit -m "docs(wiki): sync from main repository"
git -C "$WIKI" push
```

`--delete` means the wiki mirrors `wiki/` exactly: a page deleted here disappears there. That is
intentional — two sources of truth is the failure this whole arrangement avoids.

If someone edited a page through the web UI, `pull --ff-only` brings it back first. Copy the change
into `wiki/` in the main repository, commit it there, and re-run. Do not resolve it only in the wiki
repository, or it is lost on the next sync.

## Page naming

GitHub maps a filename to a page title by replacing hyphens with spaces:

| File | Page | Link syntax |
|---|---|---|
| `Home.md` | Home | — the wiki landing page |
| `Provider-Cheat-Sheet.md` | Provider Cheat Sheet | `[[Provider Cheat Sheet]]` |
| `Release-Notes.md` | Release Notes | `[[Release Notes]]` |

So write `[[Provider Cheat Sheet]]`, not `[[Provider-Cheat-Sheet]]`. Both resolve; only one reads
like a sentence.

**`Home.md` is required.** Without it the wiki landing page is whatever GitHub picks.

## House rules

- **Flat namespace.** No subdirectories — GitHub wikis do not render them as a hierarchy.
- **`[[WikiLink]]` for wiki pages**, full `https://dresvyanskiydenis.github.io/PiON/...` URLs for the
  documentation site. Relative links do not cross between the two repositories.
- **If a statement would become wrong when the code changes, it belongs on the site**, next to the
  code, where CI catches the break. The wiki is for what stays true across refactors: recipes,
  symptoms, cheat sheets.
- **No secrets, no hostnames, no tenant names.** The wiki is as public as the repository and gets
  none of its review.
- Site links are absolute and hard-coded. If the repository ever moves, they are a single
  find-and-replace over `wiki/` — do it in the main repository and re-sync, never in the wiki clone.

## Checking links before you push

The wiki is not part of the MkDocs build, so nothing checks it automatically. Cheap manual check for
dangling `[[…]]` targets:

```bash
grep -oh '\[\[[^]]*\]\]' wiki/*.md | tr -d '[]' | sort -u \
  | while read -r page; do
      [ -f "wiki/${page// /-}.md" ] || echo "dangling: $page"
    done
```

---

See also: [[Home]]
